"use strict";

/**
 * The robot as a real robot vacuum in Apple Home (its own tile with the
 * vacuum icon: start, pause, send to the dock, pick rooms, pick the kind of
 * clean and the suction, battery).
 *
 * Apple Home only knows robot vacuums through Matter, so this is a Matter
 * accessory. Homebridge (2.0 and later) does the Matter side; a robot vacuum
 * is always published on its own, with its own pairing code, apart from the
 * plugin's bridge. This file says what the vacuum can do, turns what Home
 * asks into commands for the robot, and keeps Home's picture of the robot
 * current.
 *
 * Numbers below are from the Matter specification (RVC Run Mode, RVC Clean
 * Mode, RVC Operational State, Service Area and Power Source clusters).
 *
 * Three things about Homebridge's Matter side shape this file:
 * - What Home is told goes through Homebridge a moment later, and when it is
 *   turned down nobody is told. So what Homebridge really holds is read back
 *   every minute, and what differs is told again.
 * - What the vacuum can do (kinds of clean, mopping or not, progress per
 *   room) is taken by Home on the day the vacuum is added, and kept by
 *   Homebridge between starts. It is decided once and never shrinks.
 * - Writing the state clears the error, so the state is written only when it
 *   changes and the error always after it.
 */

const RUN = { IDLE: 0, CLEANING: 1 };
const RUN_TAG = { IDLE: 16384, CLEANING: 16385 };
// Apple Home does not show the labels of clean modes: it names them itself from these tags.
const TAG = { AUTO: 0, QUICK: 1, QUIET: 2, MAX: 7, DEEP_CLEAN: 16384, VACUUM: 16385, MOP: 16386 };
const OP = { STOPPED: 0, RUNNING: 1, PAUSED: 2, ERROR: 3, SEEKING_CHARGER: 64, CHARGING: 65, DOCKED: 66 };
const OP_ERROR = { NONE: 0, CANNOT_COMPLETE: 2, DOCK_NOT_FOUND: 64, STUCK: 65, BIN_MISSING: 66 };
const CHARGE = { CHARGING: 1, FULL: 2, NOT_CHARGING: 3 };
// What Home is told about each room of the clean in progress.
const AREA = { PENDING: 0, OPERATING: 1, SKIPPED: 2, COMPLETED: 3 };

const FAN_OFF = 105; // mopping only
const WATER_OFF = 200;
const WATER_DEFAULT = 202; // "moderate", when mopping is asked for and the robot's water is off

/**
 * The kinds of clean Home can choose from. The numbers must never change
 * their meaning: Home keeps the list from the day the vacuum was added.
 * `fan`: the suction it sets (null: the suction from the plugin settings).
 */
const CLEAN_MODES = [
  { mode: 0, label: "Vacuum", tags: [TAG.VACUUM], fan: null, mop: false },
  { mode: 1, label: "Mop", tags: [TAG.MOP], fan: FAN_OFF, mop: true },
  { mode: 2, label: "Vacuum and mop", tags: [TAG.VACUUM, TAG.MOP], fan: null, mop: true },
  { mode: 3, label: "Quiet", tags: [TAG.VACUUM, TAG.QUIET], fan: 101, mop: false },
  { mode: 4, label: "Balanced", tags: [TAG.VACUUM, TAG.AUTO], fan: 102, mop: false },
  { mode: 5, label: "Turbo", tags: [TAG.VACUUM, TAG.QUICK], fan: 103, mop: false },
  { mode: 6, label: "Max", tags: [TAG.VACUUM, TAG.MAX], fan: 104, mop: false },
  { mode: 7, label: "Max+", tags: [TAG.VACUUM, TAG.DEEP_CLEAN], fan: 108, mop: false, maxPlus: true },
];

/** Robot states in which it is cleaning (5 whole home, 11 spot, 17 zone, 18 rooms) or being driven (4, 7, 16). */
const WORKING = new Set([1, 4, 5, 7, 11, 16, 17, 18]);
/** On its way to the dock, or busy at it in the middle of a job (6, 15, 26 going there; 22 emptying, 23 washing, 29 mapping). */
const HEADING_HOME = new Set([6, 15, 26]);
const DOCK_CHORE = new Set([22, 23, 29]);
const CHARGING = new Set([8, 100]);

/** Roborock error codes that mean the robot is stuck somewhere and wants to be freed. */
const STUCK_ERRORS = new Set([2, 3, 4, 5, 6, 7, 8, 17, 21, 24]);

/** The one map the rooms are on. */
const MAP_ID = 0;

/** How often what Homebridge holds is compared with what Home was told. */
const CHECK_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** At most `max` bytes of text, never half a letter. */
function clip(text, max) {
  let out = "";
  let bytes = 0;
  for (const letter of String(text)) {
    bytes += Buffer.byteLength(letter);
    if (bytes > max) break;
    out += letter;
  }
  return out;
}

/** Whether what Homebridge holds (`have`) says what was meant (`want`). Extra fields in `have` do not count. */
function same(want, have) {
  try {
    if (want === null) return have === null || have === undefined;
    if (typeof want !== "object") return want === have;
    if (have === null || typeof have !== "object") return false;
    if (Array.isArray(want)) return have.length === want.length && want.every((value, i) => same(value, have[i]));
    return Object.keys(want).every((key) => same(want[key], have[key]));
  } catch (err) {
    return false;
  }
}

/** A name for a set of rooms (null: the whole home), to tell one clean's rooms from another's. */
function scopeOf(rooms) {
  return rooms && rooms.length ? [...new Set(rooms.map(Number))].sort((a, b) => a - b).join(",") : "all";
}

class MatterVacuum {
  /**
   * host:
   *   log, matter (api.matter), pluginName, platformName
   *   name               the vacuum's name in Home
   *   robot              { duid, sn, fv, name }, model (text)
   *   channel            RobotChannel (send)
   *   rooms              [{ segmentId, name }]
   *   maxPlus            the robot has the Max+ suction level
   *   defaultFan         suction code for the plain "Vacuum" kind of clean
   *   repeat(rooms)      passes for a clean of these rooms
   *   restore            put the robot's own suction and water back after a clean
   *   store              { read(), write(data) } - what must survive a restart
   *   status()           the robot's status as last known ({ state, battery, fan_power, ... , fullAt }), or null
   *   readStatus(maxAgeMs), refreshSoon(ms)
   *   sendToDock()       app_charge, patiently
   *   started()          a clean is being started from the vacuum: the fans and switches of this robot go off.
   *                      Returns the settings one of them still meant to put back, or null.
   *   show(rooms, status) the clean has started: rooms is the list of room ids, or null for the whole home
   *   stopped()          the clean was stopped from the vacuum. Returns like started().
   *   runningRooms()     the rooms of the fan or switch that is on: a list, null for the whole home, undefined when none is on
   *   othersBusy()       a fan or switch of this robot is on, or about to start
   *   stopping()         the plugin stopped a clean of this robot a moment ago
   *   noteSetting(key, value)  a suction or water setting was just sent (the status known here is brought up to date)
   *   verify             Homebridge can be asked whether it brought the vacuum up (2.4.0 and later)
   *   checkMs            (tests) how often what Homebridge holds is checked
   */
  constructor(host) {
    this.host = host;
    this.log = host.log;
    this.uuid = host.matter.uuid.generate(`${host.pluginName}:matter-vacuum:${host.robot.duid}`);
    const kept = host.store.read() || {};
    this.mop = typeof kept.mop === "boolean" ? kept.mop : null; // whether mopping is offered: fixed once Home knows the vacuum
    this.offered = Array.isArray(kept.modes) ? kept.modes.map(Number).filter(Number.isInteger) : []; // kinds of clean Home was ever offered
    this.cleanMode = Number.isInteger(kept.cleanMode) ? kept.cleanMode : null;
    this.selected = Array.isArray(kept.selected) ? kept.selected.map(Number).filter(Number.isInteger) : [];
    this.rooms = this.listRooms();
    this.lastRun = RUN.IDLE;
    this.expect = null; // what a command just sent will lead to: shown until the robot's own status says so (or does not, for too long)
    this.job = null; // { restore, changed, startedAt, rooms } - a clean started from the vacuum
    this.owed = null; // like a job that is over: settings that still have to be put back
    this.turn = 0; // goes up with every start and every stop: a start that finds it changed has been called off
    this.starting = false;
    this.dockAfter = false; // the start was called off by "send to dock"
    this.pauseWanted = false; // pause was pressed while the clean was being started
    this.progress = []; // [{ areaId, status }] - the rooms of the clean in progress
    this.current = null; // the room the robot is in, as far as is known
    this.visited = new Set(); // rooms the robot itself said it was in, in this clean
    this.scope = ""; // which rooms `progress` was made for ("all", or their numbers)
    this.modeSetAt = 0;
    this.accessory = null;
    this.published = false;
    this.publishing = false;
    this.failed = false;
    this.saidNoRooms = false;
    this.sent = {}; // cluster -> { attribute: what Home was last told, as text }
    this.repairs = {}; // "cluster.attribute" -> how many checks in a row found it not as told
    this.wroteAt = 0;
    this.queue = Promise.resolve(); // what Home is told, one thing after the other
    this.pushTimer = null;
    this.checkTimer = null;
    this.closed = false;
  }

  // ---------- what the vacuum can do

  /**
   * The kinds of clean Home is offered. One that was offered once stays
   * (Homebridge keeps the one last chosen between starts, and does not bring
   * the vacuum up when that one is no longer on the list).
   */
  modes() {
    return CLEAN_MODES.filter((m) => this.offered.includes(m.mode) || ((!m.mop || this.mop) && (!m.maxPlus || this.host.maxPlus)));
  }

  modeOf(number) {
    return this.modes().find((m) => m.mode === number) || null;
  }

  /** The kind of clean that sets this suction code (water off), or null. */
  modeForFan(fan) {
    const found = CLEAN_MODES.find((m) => m.fan === fan && !m.mop);
    if (!found) return null;
    if (this.modeOf(found.mode)) return found.mode;
    return found.maxPlus ? 6 : null; // Max+ on a vacuum that was added without it: shown as Max
  }

  /** [{ id, name }]: the rooms Home can choose from. Ids and names are both unique, as Matter wants them. */
  listRooms() {
    const ids = new Set();
    const names = new Set();
    const out = [];
    for (const room of this.host.rooms || []) {
      const id = Number(room.segmentId);
      if (!Number.isInteger(id) || id < 0 || ids.has(id)) continue;
      ids.add(id);
      const base = clip(String(room.name || "").trim() || `Room ${id}`, 100);
      let name = base;
      for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
      names.add(name);
      out.push({ id, name });
    }
    return out;
  }

  roomIds() {
    return this.rooms.map((r) => r.id);
  }

  // ---------- from the robot's status to what Home shows

  /** { run, op, error } for a status of the robot. */
  condition(status) {
    const state = status ? Number(status.state) : NaN;
    let run;
    let op;
    if (WORKING.has(state)) {
      run = RUN.CLEANING;
      op = OP.RUNNING;
    } else if (state === 10) {
      run = this.lastRun; // paused: still the same run
      op = OP.PAUSED;
    } else if (HEADING_HOME.has(state)) {
      // Driving home is how a run ends, never how one starts: Home is told "finished" once it is on the dock.
      run = this.lastRun;
      op = OP.SEEKING_CHARGER;
    } else if (DOCK_CHORE.has(state)) {
      run = this.lastRun; // emptying the bin in the middle of a clean is not the end of the clean
      op = run === RUN.CLEANING ? OP.RUNNING : OP.DOCKED;
    } else if (state === 8) {
      run = RUN.IDLE;
      op = OP.CHARGING;
    } else if (state === 100) {
      run = RUN.IDLE;
      op = OP.DOCKED;
    } else if (state === 9 || state === 12) {
      run = RUN.IDLE;
      op = OP.ERROR;
    } else {
      run = RUN.IDLE;
      op = OP.STOPPED;
    }
    // A command was just sent: until the robot's status shows its effect, Home is shown the effect.
    const expect = this.expect;
    if (expect) {
      // An error of the robot ends it at once: Home is not shown a clean that has stopped.
      if (Date.now() > expect.until || (Number.isFinite(state) && (expect.done(state) || state === 9 || state === 12))) this.expect = null;
      else {
        run = expect.run;
        op = expect.op;
      }
    }
    this.lastRun = run;
    let error = OP_ERROR.NONE;
    if (op === OP.ERROR) {
      const code = Number(status.error_code);
      error = code === 9 ? OP_ERROR.BIN_MISSING : code === 23 ? OP_ERROR.DOCK_NOT_FOUND : STUCK_ERRORS.has(code) ? OP_ERROR.STUCK : OP_ERROR.CANNOT_COMPLETE;
    }
    return { run, op, error };
  }

  /** The kind of clean Home shows: the robot's own while it cleans, otherwise the one chosen for the next clean. */
  shownCleanMode(status) {
    const chosen = this.modeOf(this.cleanMode) || this.modes()[0];
    if (!status || !WORKING.has(Number(status.state)) || Date.now() - this.modeSetAt < 30000) return chosen.mode;
    const water = Number(status.water_box_mode);
    const mopping = !!this.mop && Number.isFinite(water) && water !== WATER_OFF;
    const fan = Number(status.fan_power);
    // Several kinds of clean can come to the same settings ("Vacuum" is one of the suction levels):
    // while the robot does what the chosen one asks for, the chosen one is shown.
    if (mopping === chosen.mop && fan === (chosen.fan || this.host.defaultFan)) return chosen.mode;
    if (mopping) return fan === FAN_OFF ? 1 : 2;
    const mode = this.modeForFan(fan);
    return mode === null ? chosen.mode : mode;
  }

  battery(status) {
    const level = status && typeof status.battery === "number" ? Math.max(0, Math.min(100, Math.round(status.battery))) : null;
    const state = status ? Number(status.state) : NaN;
    return {
      batPercentRemaining: level === null ? null : level * 2, // Matter counts in half percents
      batChargeLevel: level === null || level > 20 ? 0 : level > 10 ? 1 : 2,
      batChargeState: state === 100 || (state === 8 && level === 100) ? CHARGE.FULL : state === 8 ? CHARGE.CHARGING : CHARGE.NOT_CHARGING,
    };
  }

  // ---------- the rooms of the clean in progress

  /**
   * A clean begins. `rooms`: its rooms, or null for the whole home.
   *
   * Home's line under the vacuum ("cleaning the kitchen") comes from this
   * list. Without it, or with nothing in it marked as being cleaned, Home says
   * "on its way to the room" for the whole clean. So: of the rooms asked for,
   * the first is marked as being cleaned and the others as waiting, until the
   * robot itself says where it is; for the whole home, where the room is not
   * known, every room is marked as being cleaned and none is named.
   */
  announce(rooms) {
    const ids = this.roomIds();
    const list = (rooms || []).map(Number).filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
    this.visited = new Set();
    this.scope = scopeOf(rooms);
    if (list.length) {
      this.progress = list.map((areaId, i) => ({ areaId, status: i === 0 ? AREA.OPERATING : AREA.PENDING }));
      this.current = list[0];
    } else {
      this.progress = ids.map((areaId) => ({ areaId, status: AREA.OPERATING }));
      this.current = null;
    }
  }

  /** Keep the rooms of the clean in progress in step with the robot. */
  track(status, run, op) {
    // Cleaning again straight from the way to the dock is a new clean (one started in the
    // Roborock app or from a fan while the robot drove home): the rooms of the last one are over.
    const before = this.trackedOp;
    this.trackedOp = op;
    const fresh = op === OP.RUNNING && before === OP.SEEKING_CHARGER && !this.job && !this.starting;
    const open = !fresh && this.progress.some((p) => p.status === AREA.OPERATING || p.status === AREA.PENDING);
    if (run !== RUN.CLEANING) {
      if (open) {
        // Over (on the dock, or stopped): nothing is being cleaned or waiting any more.
        this.progress = this.progress.map((p) => ({ areaId: p.areaId, status: AREA.COMPLETED }));
        this.current = null;
      }
      return;
    }
    if (op !== OP.RUNNING) return;
    if (this.job || this.starting) {
      // A clean started here that goes on after a stop on the dock (to charge, to empty the bin).
      if (!open) this.announce(this.job ? this.job.rooms : null);
    } else {
      // Not started here (a fan, a routine switch, the Roborock app, the button on the robot).
      // The rooms are those of the fan or switch that is on, when one is; otherwise they are not known.
      const rooms = this.host.runningRooms ? this.host.runningRooms() : undefined;
      if (rooms !== undefined ? !open || scopeOf(rooms) !== this.scope : !open) this.announce(rooms || null);
    }
    // Newer robots name the room they are in.
    const here = status && status.cleaning_info ? Number(status.cleaning_info.segment_id) : NaN;
    if (!Number.isInteger(here) || !this.progress.some((p) => p.areaId === here)) return;
    this.visited.add(here);
    if (here === this.current) return;
    this.current = here;
    this.progress = this.progress.map((p) => ({
      areaId: p.areaId,
      status: p.areaId === here ? AREA.OPERATING : this.visited.has(p.areaId) ? AREA.COMPLETED : AREA.PENDING,
    }));
  }

  /**
   * The rooms Home shows as chosen. Home names the rooms of a clean from the rooms chosen on
   * the vacuum, so while a clean started elsewhere (a fan, a switch, the Roborock app) runs,
   * its rooms are shown (none: the whole home). What was chosen on the vacuum is kept, and
   * shown again once that clean is over.
   */
  shownSelection(ids) {
    const open = this.progress.some((p) => p.status === AREA.OPERATING || p.status === AREA.PENDING);
    if (open && !this.job && !this.starting) return this.scope === "all" ? [] : this.progress.map((p) => p.areaId);
    return this.selected.filter((id) => ids.includes(id));
  }

  /** What changes over time, per cluster. */
  snapshot() {
    const status = this.host.status();
    const { run, op, error } = this.condition(status);
    this.track(status, run, op);
    const ids = this.roomIds();
    return {
      rvcRunMode: { currentMode: run },
      rvcOperationalState: { operationalState: op, operationalError: { errorStateId: error } },
      rvcCleanMode: { currentMode: this.shownCleanMode(status) },
      serviceArea: {
        selectedAreas: this.shownSelection(ids),
        currentArea: this.current,
        progress: this.progress.map((p) => ({ areaId: p.areaId, status: p.status })),
      },
      powerSource: this.battery(status),
    };
  }

  /** Everything Home is told when the vacuum is published. */
  clusters() {
    const now = this.snapshot();
    return {
      rvcRunMode: {
        supportedModes: [
          { label: "Idle", mode: RUN.IDLE, modeTags: [{ value: RUN_TAG.IDLE }] },
          { label: "Cleaning", mode: RUN.CLEANING, modeTags: [{ value: RUN_TAG.CLEANING }] },
        ],
        ...now.rvcRunMode,
      },
      rvcCleanMode: {
        supportedModes: this.modes().map((m) => ({ label: m.label, mode: m.mode, modeTags: m.tags.map((value) => ({ value })) })),
        ...now.rvcCleanMode,
      },
      rvcOperationalState: {
        phaseList: null,
        currentPhase: null,
        operationalStateList: Object.values(OP).map((operationalStateId) => ({ operationalStateId })),
        // Not the error: Home takes the vacuum from what it is registered with, and an error there has
        // been seen to upset it. The first update, a moment later, brings it.
        operationalState: now.rvcOperationalState.operationalState,
      },
      serviceArea: {
        // One map, named: Homebridge's Matter (matter.js 0.17.9) cannot bring up a vacuum whose
        // service area has no list of maps at all.
        supportedMaps: [{ mapId: MAP_ID, name: "Home" }],
        supportedAreas: this.rooms.map((room) => ({
          areaId: room.id,
          mapId: MAP_ID,
          areaInfo: { locationInfo: { locationName: room.name, floorNumber: null, areaType: null }, landmarkInfo: null },
        })),
        // `progress` has to be there from the first day, also when empty: Homebridge offers Home
        // the rooms' progress only when the vacuum is published with it, and Home asks only when it is added.
        estimatedEndTime: null,
        ...now.serviceArea,
      },
      powerSource: {
        status: 1, // active
        order: 0,
        description: "Battery",
        batPresent: true,
        batReplacementNeeded: false,
        batReplaceability: 0,
        batFunctionalWhileCharging: true,
        ...now.powerSource,
      },
    };
  }

  // ---------- publishing

  /** Publish the vacuum once enough is known about the robot. Safe to call again and again. */
  start() {
    if (this.closed || this.published || this.publishing || this.failed) return;
    const { host } = this;
    if (!this.rooms.length) {
      // Home does not take a robot vacuum whose list of rooms is empty.
      if (!this.saidNoRooms) {
        this.saidNoRooms = true;
        this.log.warn(`${host.name}: the robot's rooms are not known, so it is not added to Apple Home as a robot vacuum. Let the robot map the home and divide it into rooms in the Roborock app, then restart Homebridge.`);
      }
      return;
    }
    const status = host.status();
    if (this.mop === null) {
      // Whether the robot mops is read from its status once, and then kept: Home takes the list of
      // kinds of clean when the vacuum is added, and it must not change under it afterwards.
      if (!status || status.fullAt === 0 || status.fan_power === undefined) return; // not known yet: tried again at the next status
      this.mop = typeof status.water_box_mode === "number";
    }
    this.offered = this.modes().map((m) => m.mode);
    if (!this.modeOf(this.cleanMode)) this.cleanMode = this.modeForFan(host.defaultFan) ?? this.modes()[0].mode;
    this.save();
    const firmware = /^\d+(\.\d+){0,2}$/.test(String(host.robot.fv || "")) ? String(host.robot.fv) : undefined;
    this.accessory = {
      UUID: this.uuid,
      displayName: host.name,
      deviceType: host.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: String(host.robot.sn || host.robot.duid),
      manufacturer: "Roborock",
      model: String(host.model || "Robot vacuum"),
      ...(firmware ? { firmwareRevision: firmware } : {}),
      context: { duid: host.robot.duid },
      clusters: this.clusters(),
      handlers: this.handlers(),
    };
    this.publishing = true;
    (async () => {
      await host.matter.registerPlatformAccessories(host.pluginName, host.platformName, [this.accessory]);
      if (this.closed) return;
      // Homebridge reports a vacuum it could not bring up in its own log lines only: ask it.
      if (!(await this.isUp())) {
        this.failed = true;
        this.log.error(
          `${host.name}: Homebridge did not bring the robot vacuum for Apple Home up; its own lines above this one say why. ` +
            "The fans, switches and the map camera are not affected. It is tried again when Homebridge restarts."
        );
        return;
      }
      if (this.closed) return;
      this.published = true;
      this.log.info(
        `${host.name}: the robot is published as a robot vacuum for Apple Home (Matter), with ${this.rooms.length} room(s)${this.mop ? ", vacuuming and mopping" : ""}. ` +
          'If it is not in Apple Home yet, add it once: Add Accessory > More options, and enter the "Manual Code" that Homebridge wrote in the log just above this line.'
      );
      // Homebridge may have brought back what it kept from before the restart: everything is told afresh.
      this.sent = {};
      this.nudgeBattery = true;
      this.push(500);
      this.checkTimer = setInterval(() => this.check().catch((err) => this.log.debug(`${host.name}: checking what Home was told failed (${err.message}).`)), host.checkMs || CHECK_MS);
      this.checkTimer.unref?.();
    })()
      .catch((err) => {
        // Not tried again at every status: the reason does not go away by itself.
        this.failed = true;
        this.log.error(
          `${host.name}: the robot vacuum for Apple Home could not be published: ${err.message} ` +
            "Robot vacuums need Matter turned on for the bridge this plugin runs on. The fans, switches and the map camera are not affected. It is tried again when Homebridge restarts."
        );
      })
      .finally(() => {
        this.publishing = false;
      });
  }

  /** Whether Homebridge really has the vacuum (it says so only where it can be asked). */
  async isUp() {
    const { matter } = this.host;
    if (!this.host.verify || typeof matter.getAccessoryState !== "function") return true;
    for (const ms of [200, 3000]) {
      await sleep(ms);
      if (this.closed) return true;
      try {
        if (await matter.getAccessoryState(this.uuid, "rvcRunMode")) return true;
      } catch (err) {
        return true; // cannot be asked: not taken for an answer
      }
    }
    return false;
  }

  save() {
    this.host.store.write({ mop: this.mop, modes: this.offered, cleanMode: this.cleanMode, selected: this.selected });
  }

  // ---------- telling Home

  /** Tell Home what changed, in a moment (never from inside a command Home is still waiting on). */
  push(delay = 150) {
    if (this.closed || !this.published) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      if (!this.closed) this.flush();
    }, delay);
    this.pushTimer.unref?.();
  }

  flush() {
    for (const [cluster, attributes] of Object.entries(this.snapshot())) {
      if (cluster === "powerSource" && this.nudgeBattery && typeof attributes.batPercentRemaining === "number") {
        // Matter does not send changes of the battery percentage to Home ("changes omitted"):
        // Home reads it now and then, and keeps what it read on the day the vacuum was added.
        // Once after every start the battery is shown as unknown for a moment and then as it
        // is, so the next time Home reads the battery it finds it has changed, and takes the
        // real value.
        this.nudgeBattery = false;
        this.tell(cluster, { batPercentRemaining: null, batChargeState: 0 });
        (this.sent[cluster] = this.sent[cluster] || {}).batPercentRemaining = "null";
        this.sent[cluster].batChargeState = "0";
      }
      const told = this.sent[cluster] || (this.sent[cluster] = {});
      const changed = {};
      for (const [key, value] of Object.entries(attributes)) {
        const text = JSON.stringify(value);
        if (told[key] === text) continue;
        told[key] = text;
        changed[key] = value;
      }
      if (!Object.keys(changed).length) continue;
      if (cluster === "rvcOperationalState" && "operationalState" in changed) {
        // Writing the state clears the error in Homebridge's Matter: the error goes after it, every time.
        changed.operationalError = attributes.operationalError;
        told.operationalError = JSON.stringify(attributes.operationalError);
      }
      this.tell(cluster, changed);
    }
  }

  /** Hand one change to Homebridge, after the ones before it. */
  tell(cluster, attributes) {
    const write = (part) =>
      Promise.resolve()
        .then(() => {
          this.wroteAt = Date.now();
          return this.host.matter.updateAccessoryState(this.uuid, cluster, part);
        })
        .catch((err) => {
          const told = this.sent[cluster] || {};
          for (const key of Object.keys(part)) delete told[key]; // told again at the next change, or at the next check
          this.log.debug(`${this.host.name}: Home could not be told about ${cluster} (${err.message}).`);
        });
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      const { operationalState, ...rest } = attributes;
      if (cluster !== "rvcOperationalState" || operationalState === undefined) return write(attributes);
      await write({ operationalState });
      await sleep(250); // the state first, and settled
      if (!this.closed && Object.keys(rest).length) await write(rest);
    });
  }

  /**
   * Compare what Homebridge holds with what Home was told, and tell again
   * what differs. Homebridge takes what it is told a moment later, and when
   * it then turns it down it only writes a line in its own log.
   */
  async check() {
    if (this.closed || !this.published) return;
    const { matter } = this.host;
    if (Date.now() - this.wroteAt < Math.min(3000, (this.host.checkMs || CHECK_MS) / 2)) return; // something is on its way right now
    if (typeof matter.getAccessoryState !== "function") return this.flush();
    for (const [cluster, attributes] of Object.entries(this.snapshot())) {
      const have = await Promise.resolve(matter.getAccessoryState(this.uuid, cluster)).catch(() => undefined);
      if (!have || this.closed) continue;
      const told = this.sent[cluster] || {};
      for (const [key, value] of Object.entries(attributes)) {
        const name = `${cluster}.${key}`;
        if (told[key] !== JSON.stringify(value)) continue; // changed meanwhile: told below anyway
        if (same(value, have[key])) {
          this.repairs[name] = 0;
          continue;
        }
        // Not for ever: something Homebridge turns down every time is left alone after a few tries.
        this.repairs[name] = (this.repairs[name] || 0) + 1;
        if (this.repairs[name] > 5) continue;
        this.log.debug(`${this.host.name}: Homebridge holds ${JSON.stringify(have[key])} for ${name}, not ${told[key]}: telling it again.`);
        delete told[key];
      }
    }
    if (!this.closed) this.flush();
  }

  /** The robot's status changed. */
  statusChanged() {
    if (this.closed) return;
    if (!this.published) return this.start();
    this.finishIfDone();
    this.push();
  }

  // ---------- what Home asks for

  handlers() {
    return {
      identify: {
        identify: () => {
          this.send("find_me", []).catch(() => {});
        },
      },
      rvcRunMode: {
        changeToMode: (request) => this.answered("rvcRunMode", () => this.changeRunMode(request && request.newMode)),
      },
      rvcCleanMode: {
        changeToMode: (request) => this.answered("rvcCleanMode", () => this.changeCleanMode(request && request.newMode)),
      },
      rvcOperationalState: {
        pause: () => this.pause(),
        resume: () => this.resume(),
        goHome: () => this.home(),
      },
      serviceArea: {
        selectAreas: (request) => this.answered("serviceArea", () => this.selectAreas(request && request.newAreas)),
      },
    };
  }

  /**
   * Run a command that Matter completes by itself: once the handler returns,
   * Homebridge's Matter side writes the new mode or room selection into the
   * cluster on its own. What the robot really ends up doing may differ (a
   * start that fails, a mode the robot overrides), so that cluster is told
   * afresh a moment after the command, whatever was told before.
   */
  answered(cluster, run) {
    try {
      return run();
    } finally {
      this.sent[cluster] = {};
      this.push(300);
    }
  }

  send(method, params) {
    return this.host.channel.send(method, params).then((answer) => {
      if (this.host.noteSetting && method === "set_custom_mode") this.host.noteSetting("fan_power", params[0]);
      if (this.host.noteSetting && method === "set_water_box_custom_mode") this.host.noteSetting("water_box_mode", params[0]);
      return answer;
    });
  }

  /** Show `op`/`run` until the robot's state satisfies `done`, for at most `ms`. */
  expecting(run, op, done, ms) {
    this.expect = { run, op, done, until: Date.now() + ms };
    this.lastRun = run;
    this.push();
  }

  changeRunMode(mode) {
    if (mode === RUN.CLEANING) return this.play();
    if (mode === RUN.IDLE) return this.stop();
    throw new Error(`run mode ${mode} is not one of this vacuum's`);
  }

  /** Play in Home: go on with a paused clean, or start the one chosen. */
  play() {
    const { host } = this;
    if (this.starting) {
      // Pressed again while the clean is being started: once is enough (a pause pressed meanwhile is taken back).
      if (this.pauseWanted) {
        this.pauseWanted = false;
        this.expecting(RUN.CLEANING, OP.RUNNING, (state) => WORKING.has(state), 90000);
      }
      return;
    }
    if (this.expect && this.expect.op === OP.PAUSED) return this.resume(); // paused a moment ago
    const turn = ++this.turn;
    this.starting = true;
    this.pauseWanted = false;
    this.expecting(RUN.CLEANING, OP.RUNNING, (state) => WORKING.has(state), 90000);
    (async () => {
      // What the robot is doing, asked afresh: what is known here can be a few seconds old.
      const status = await host.readStatus(0).catch(() => host.status());
      if (turn !== this.turn) return;
      const state = status ? Number(status.state) : NaN;
      if (WORKING.has(state) && !host.stopping()) {
        this.starting = false; // already cleaning
        return;
      }
      if (state === 10 && status.in_cleaning) {
        this.starting = false; // paused in the middle of a clean: go on with it
        return this.resume();
      }
      const ids = this.roomIds();
      const picked = this.selected.filter((id) => ids.includes(id));
      const rooms = picked.length && picked.length < ids.length ? picked : null; // none or all of them: the whole home
      this.announce(rooms);
      this.push();
      await this.begin(turn, rooms, status);
    })()
      .catch((err) => {
        if (turn !== this.turn) return; // called off meanwhile: whoever did that tidies up
        this.log.error(`${host.name}: could not start the clean: ${err.message}`);
        this.expect = null;
        this.progress = [];
        this.current = null;
        const debt = this.endJob();
        // What was already changed for this clean is put back.
        return this.settle(debt).then(() => host.refreshSoon(1000));
      })
      .finally(() => {
        if (turn === this.turn) this.starting = false;
        this.push();
      });
  }

  /** Start the clean chosen in Home: these rooms (null: the whole home), in the chosen kind of clean. */
  async begin(turn, rooms, status) {
    const { host } = this;
    const calledOff = () => turn !== this.turn || this.closed;
    const mode = this.modeOf(this.cleanMode) || this.modes()[0];
    const names = rooms ? rooms.map((id) => (this.rooms.find((r) => r.id === id) || {}).name || id).join(", ") : "the whole home";
    this.log.info(`${host.name}: starting from the vacuum in Apple Home (${names}, ${mode.label.toLowerCase()}).`);
    // The settings to put back when this clean is over: those an earlier clean (the vacuum's own,
    // or a fan's that goes off now) still meant to put back, otherwise the robot's as they are now.
    const handed = host.started() || null;
    const before = this.job || this.owed;
    this.owed = null;
    const job = { restore: null, changed: { fan: false, water: false }, startedAt: Date.now(), rooms };
    if (before && before.restore) {
      job.restore = before.restore;
      job.changed = { ...before.changed };
    } else if (handed) {
      job.restore = handed;
      job.changed = { fan: true, water: true };
    }
    this.job = job;
    if (status && !job.restore && host.restore) job.restore = { fanPower: status.fan_power, waterBoxMode: status.water_box_mode };
    if (status && status.in_cleaning) {
      await this.send("app_stop", []).catch(() => {});
      await sleep(2000);
      if (calledOff()) return;
    }
    // Only what needs to change is sent.
    const fan = mode.fan || host.defaultFan;
    if (fan && (!status || status.fan_power !== fan)) {
      job.changed.fan = true;
      await this.send("set_custom_mode", [fan]);
      if (calledOff()) return;
    }
    if (this.mop) {
      const now = status ? Number(status.water_box_mode) : NaN;
      const water = !mode.mop ? WATER_OFF : Number.isFinite(now) && now !== WATER_OFF ? null : WATER_DEFAULT;
      if (water !== null && now !== water) {
        job.changed.water = true;
        await this.send("set_water_box_custom_mode", [water]).catch((err) => this.log.debug(`water mode: ${err.message}`));
        if (calledOff()) return;
      }
    }
    this.modeSetAt = Date.now();
    try {
      if (!rooms) await this.send("app_start", []);
      else {
        const repeat = host.repeat(rooms);
        try {
          await this.send("app_segment_clean", [{ segments: rooms, repeat }]);
        } catch (err) {
          // Only when the robot says it does not understand it (see startProgram in index.js).
          if (calledOff() || !err.refused) throw err;
          this.log.info(`${host.name}: the robot does not take the number of passes (${err.message}); cleaning once.`);
          await this.send("app_segment_clean", rooms);
        }
      }
    } finally {
      // Stopped while the start was on its way to the robot: the robot may have taken the start after the stop.
      // Not when a newer clean is being started or runs (a fan, or the vacuum again): that one is left alone.
      const nothingNewer = () => !this.starting && !this.job && !host.othersBusy();
      if (calledOff() && !this.closed && nothingNewer()) {
        await this.send("app_stop", []).catch(() => {});
        if (this.dockAfter && nothingNewer()) await host.sendToDock(nothingNewer).catch(() => {});
        host.refreshSoon(1500);
      }
    }
    if (calledOff()) return;
    if (this.pauseWanted) {
      this.pauseWanted = false;
      await this.send("app_pause", []).catch((err) => this.log.error(`${host.name}: could not pause: ${err.message}`));
    }
    job.startedAt = Date.now();
    host.show(rooms, { ...(status || {}), fan_power: fan });
    host.refreshSoon(4000);
  }

  /**
   * The clean in progress is over as far as the vacuum is concerned: the fans
   * and switches go off, a start under way is called off. Returns what still
   * has to be put back (see settle).
   */
  endJob(dockAfter = false) {
    if (this.starting) this.dockAfter = dockAfter;
    this.turn++;
    this.starting = false;
    this.pauseWanted = false;
    const job = this.job || this.owed;
    this.job = null;
    const handed = this.host.stopped() || null;
    this.owed = job && job.restore ? job : handed ? { restore: handed, changed: { fan: true, water: true } } : null;
    return this.owed;
  }

  /** Put back what `debt` owes, unless a new clean has taken it over meanwhile. */
  async settle(debt) {
    if (!debt || this.owed !== debt) return;
    this.owed = null;
    await this.putBack(debt);
  }

  /**
   * Stop (Home's run mode "idle"): the robot stops where it is. Sending it to
   * the dock is a command of its own in Home, and Home also asks for "idle"
   * on the way to something else, so the robot is not sent anywhere here.
   */
  stop() {
    const { host } = this;
    const status = host.status();
    if (!this.starting && !this.expect && status && CHARGING.has(Number(status.state))) {
      // On the dock, nothing going on, as far as is known here. That may be old news: the robot is asked.
      host
        .readStatus(0)
        .then((fresh) => {
          if (fresh && !CHARGING.has(Number(fresh.state)) && !this.closed) this.halt();
        })
        .catch(() => {});
      return;
    }
    this.halt();
  }

  halt() {
    const { host } = this;
    this.log.info(`${host.name}: stopping (asked from the vacuum in Apple Home). The robot stays where it is; "send to dock" takes it home.`);
    const debt = this.endJob(false);
    this.expecting(RUN.IDLE, OP.STOPPED, (s) => !WORKING.has(s) && s !== 10 && !HEADING_HOME.has(s) && !DOCK_CHORE.has(s), 20000);
    (async () => {
      try {
        await this.send("app_stop", []);
      } catch (err) {
        this.log.error(`${host.name}: could not stop: ${err.message}`);
        this.expect = null;
      }
      await sleep(3000);
      await this.settle(debt);
    })()
      .catch((err) => this.log.debug(`${host.name}: after the stop: ${err.message}`))
      .then(() => host.refreshSoon(1000));
  }

  /** "Send to dock" in Home. */
  home() {
    const { host } = this;
    const status = host.status();
    if (!this.starting && !this.expect && status && CHARGING.has(Number(status.state))) {
      // On the dock as far as is known here. That may be old news, so the robot is asked before it is believed.
      host
        .readStatus(0)
        .then((fresh) => {
          if (fresh && !CHARGING.has(Number(fresh.state)) && !this.closed) this.dock(fresh);
        })
        .catch(() => {});
      return;
    }
    this.dock(status);
  }

  /** Stop what the robot is doing and send it to its dock. */
  dock(status) {
    const { host } = this;
    const state = status ? Number(status.state) : NaN;
    const starting = this.starting;
    this.log.info(`${host.name}: sending it to the dock (asked from the vacuum in Apple Home).`);
    const debt = this.endJob(true);
    // The run is not over until the robot is on the dock: Home keeps what it showed (cleaning, or idle) on the way there.
    this.expecting(this.lastRun, OP.SEEKING_CHARGER, (s) => HEADING_HOME.has(s) || DOCK_CHORE.has(s) || CHARGING.has(s), 30000);
    const turn = this.turn;
    const still = () => turn === this.turn && !host.othersBusy(); // no new clean was started meanwhile
    (async () => {
      try {
        if (starting || !status || status.in_cleaning || WORKING.has(state) || state === 10) await this.send("app_stop", []).catch((err) => this.log.debug(`app_stop: ${err.message}`));
        if (still()) await host.sendToDock(still);
      } catch (err) {
        this.log.error(`${host.name}: could not send the robot to the dock: ${err.message}`);
        this.expect = null;
      }
      await sleep(3000);
      await this.settle(debt);
    })()
      .catch((err) => this.log.debug(`${host.name}: after sending it to the dock: ${err.message}`))
      .then(() => host.refreshSoon(1000));
  }

  pause() {
    if (this.starting) {
      // The clean is still being started: it is paused as soon as the robot has taken the start.
      this.log.info(`${this.host.name}: pausing as soon as the clean has started (asked from the vacuum in Apple Home).`);
      this.pauseWanted = true;
      this.expecting(RUN.CLEANING, OP.PAUSED, (s) => s === 10, 60000);
      return;
    }
    const status = this.host.status();
    if (status && Number(status.state) === 10) return;
    this.log.info(`${this.host.name}: pausing (asked from the vacuum in Apple Home).`);
    this.expecting(this.lastRun, OP.PAUSED, (s) => !WORKING.has(s), 20000);
    this.send("app_pause", [])
      .catch((err) => {
        this.log.error(`${this.host.name}: could not pause: ${err.message}`);
        this.expect = null;
      })
      .then(() => this.host.refreshSoon(1500));
  }

  resume() {
    const { host } = this;
    this.log.info(`${host.name}: resuming (asked from the vacuum in Apple Home).`);
    this.expecting(RUN.CLEANING, OP.RUNNING, (s) => WORKING.has(s), 30000);
    host
      .readStatus(5000)
      .catch(() => host.status())
      .then((status) => {
        // A paused clean of rooms or of a zone is taken up where it stopped. Never a plain start instead:
        // that would begin a clean of the whole home.
        const kind = status ? Number(status.in_cleaning) : NaN;
        if (kind === 3) return this.send("resume_segment_clean", []);
        if (kind === 2) return this.send("resume_zoned_clean", []);
        if (kind === 0 && Number(status.state) === 10) {
          // Paused on its way to the dock, with no clean going on: it goes on to the dock.
          this.expecting(this.lastRun, OP.SEEKING_CHARGER, (s) => HEADING_HOME.has(s) || DOCK_CHORE.has(s) || CHARGING.has(s), 30000);
          return this.send("app_charge", []);
        }
        return this.send("app_start", []);
      })
      .catch((err) => {
        this.log.error(`${host.name}: could not resume: ${err.message}`);
        this.expect = null;
      })
      .then(() => host.refreshSoon(1500));
  }

  changeCleanMode(number) {
    const mode = this.modeOf(number);
    if (!mode) throw new Error(`clean mode ${number} is not one of this vacuum's`);
    this.cleanMode = mode.mode;
    this.save();
    const status = this.host.status();
    if (status && (WORKING.has(Number(status.state)) || Number(status.state) === 10)) {
      // Chosen while the robot cleans (or is paused in a clean): it takes effect at once.
      this.modeSetAt = Date.now();
      this.log.info(`${this.host.name}: ${mode.label.toLowerCase()} (changed from the vacuum in Apple Home).`);
      const job = this.job;
      (async () => {
        if (job) job.changed.fan = true;
        await this.send("set_custom_mode", [mode.fan || this.host.defaultFan]);
        if (this.mop) {
          const now = Number(status.water_box_mode);
          const water = !mode.mop ? WATER_OFF : Number.isFinite(now) && now !== WATER_OFF ? null : WATER_DEFAULT;
          if (water !== null && now !== water) {
            if (job) job.changed.water = true;
            await this.send("set_water_box_custom_mode", [water]);
          }
        }
      })()
        .catch((err) => this.log.error(`${this.host.name}: could not change the kind of clean: ${err.message}`))
        .then(() => this.host.refreshSoon(2000));
    }
    this.push();
  }

  selectAreas(areas) {
    const ids = this.roomIds();
    const list = [...new Set((Array.isArray(areas) ? areas : []).map(Number))];
    const unknown = list.find((id) => !ids.includes(id));
    if (unknown !== undefined) throw new Error(`room ${unknown} is not on the robot's map`);
    this.selected = list;
    this.save();
    this.push();
  }

  // ---------- the end of a clean started here

  /** Put the robot's own suction and water setting back: what this clean (or the one it took over from) changed. */
  async putBack(job) {
    const r = job && job.restore;
    if (!r) return;
    job.restore = null;
    try {
      if (r.fanPower && job.changed.fan) await this.send("set_custom_mode", [r.fanPower]);
      if (this.mop && r.waterBoxMode && job.changed.water) await this.send("set_water_box_custom_mode", [r.waterBoxMode]);
    } catch (err) {
      this.log.debug(`${this.host.name}: restoring previous settings failed: ${err.message}`);
    }
  }

  finishIfDone() {
    const job = this.job;
    const status = this.host.status();
    if (!job || !status || this.starting) return;
    // Judged on a status read well after the start: right after it the robot still reports the old state.
    if (!status.fullAt || status.fullAt - job.startedAt < 60000 || status.in_cleaning) return;
    this.job = null;
    this.log.info(`${this.host.name}: the clean started from the vacuum in Apple Home is finished.`);
    this.putBack(job);
  }

  /**
   * A fan or switch of this plugin is starting a clean of its own: the one
   * started here is over (one under way is called off). Returns the settings
   * it meant to put back, for the fan to put back instead.
   */
  handOver() {
    const job = this.job || this.owed;
    this.job = null;
    this.owed = null;
    this.expect = null;
    this.pauseWanted = false;
    if (this.starting) {
      this.dockAfter = false;
      this.turn++;
      this.starting = false;
    }
    return job && job.restore ? job.restore : null;
  }

  close() {
    this.closed = true;
    clearTimeout(this.pushTimer);
    clearInterval(this.checkTimer);
  }
}

module.exports = { MatterVacuum, CLEAN_MODES, RUN, OP, AREA };
