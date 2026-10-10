"use strict";

const fs = require("fs");
const path = require("path");
const cloud = require("./lib/cloud");
const { RoborockSession } = require("./lib/robot");
const { MapView } = require("./lib/mapview");
const { PictureCamera } = require("./lib/camera");
const { Painter } = require("./lib/painter");
const { MatterVacuum } = require("./lib/vacuum");

const PLUGIN_NAME = "homebridge-roborock-room-clean";
const PLATFORM_NAME = "RoborockRoomClean";
const STORAGE_DIR = "roborock-room-clean";

const SUCTION = { quiet: 101, balanced: 102, turbo: 103, max: 104, max_plus: 108 };
const WATER_OFF = 200;

const STATE_NAMES = {
  1: "starting", 2: "charger disconnected", 3: "idle", 4: "remote control", 5: "cleaning",
  6: "returning home", 7: "manual mode", 8: "charging", 9: "charging problem", 10: "paused",
  11: "spot cleaning", 12: "error", 13: "shutting down", 14: "updating", 15: "docking",
  16: "going to target", 17: "zoned cleaning", 18: "room cleaning", 22: "emptying the bin",
  23: "washing the mop", 26: "going to wash the mop", 100: "fully charged",
};

/**
 * Names the plugin makes up itself, per language (the `language` setting).
 * Names the user typed and names from the Roborock app are never translated.
 */
const TEXT = {
  en: { fan: "Clean {room}", charging: (robot) => `${robot} Charging`, cleaning: (robot) => `${robot} Cleaning`, battery: (name) => `${name} Battery`, room: (id) => `Room ${id}`, map: (robot) => `${robot} Map` },
  he: { fan: "ניקוי {room}", charging: (robot) => `טעינת ${robot}`, cleaning: (robot) => `${robot} מנקה`, battery: (name) => `סוללת ${name}`, room: (id) => `חדר ${id}`, map: (robot) => `מפת ${robot}` },
};

/**
 * After the plugin stops a clean, the robot still reports "cleaning" for a
 * moment: do not mistake that for a new one. The wait ends early, as soon as
 * the robot is seen to have stopped.
 */
const QUIET_AFTER_STOP_MS = 60000;

/**
 * When Roborock's cloud refused to let the plugin listen to other apps' map
 * requests, it is not tried again for this long: a month after a plain "no",
 * a week when the cloud closed the connection instead (which is only very
 * likely a "no").
 */
const LISTEN_RETRY_MS = { refused: 30 * 24 * 60 * 60 * 1000, closed: 7 * 24 * 60 * 60 * 1000 };

/**
 * After the robot reports by itself that it started doing something, its
 * status is read every few seconds for a short while, so a clean started
 * outside Apple Home shows up quickly. Only over the home network: these
 * reads never go through the Roborock cloud.
 */
const CLOSE_WATCH_MS = 45000;
const CLOSE_WATCH_STEP_MS = 4000;

/** States in which the robot is actively cleaning (not returning, charging or paused). */
const CLEANING_STATES = new Set([5, 11, 17, 18]);

/** When the robot would not say which rooms it is cleaning, do not ask again for a while. */
const NO_MAP_PAUSE_MS = 10 * 60 * 1000;

/** How long one status answer is shared between the regular check and a running fan or routine. */
const STATUS_SHARE_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RoborockRoomCleanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map(); // uuid -> PlatformAccessory (from cache)
    this.programs = new Map(); // uuid -> runtime program
    this.docks = new Map(); // duid -> charging sensor
    this.cleaningSensors = new Map(); // duid -> cleaning sensor
    this.monitors = new Map(); // duid -> { robot, channel, last, timer } (robot status: battery, on the dock or not)
    this.views = new Map(); // duid -> MapView (the picture of the map camera)
    this.cameras = [];
    this.painter = null;
    this.vacuums = new Map(); // duid -> MatterVacuum (the robot as a robot vacuum in Apple Home)
    this.saidNoMatter = false;
    this.storageDir = path.join(api.user.storagePath(), STORAGE_DIR);
    this.session = null;
    this.stopped = false;
    this.text = TEXT[this.config.language] || TEXT.en;
    // Waits before each attempt to read which rooms an outside clean covers. The
    // robot sends the map to one viewer at a time: while the Roborock app is
    // open on its map it does not answer us, so the attempts go on for a few
    // minutes, until the app is closed or the phone is locked.
    this.externalWaits = [0, 5000, 5000, 5000, 5000, 10000, 10000, 10000, 10000, 15000, 15000, 15000, 15000, 20000, 20000, 20000, 30000, 30000, 30000, 30000];
    this.dockRetryMs = 4000; // wait before asking a robot that refused to go to the dock again
    this.ready = false; // true once every fan and switch exists

    api.on("didFinishLaunching", () => {
      this.start().catch((err) => this.log.error(`Startup failed: ${err.message}`));
    });
    api.on("shutdown", () => {
      this.stopped = true;
      for (const p of this.programs.values()) clearTimeout(p.pollTimer);
      for (const m of this.monitors.values()) clearTimeout(m.timer);
      for (const camera of this.cameras) camera.close();
      for (const vacuum of this.vacuums.values()) vacuum.close();
      for (const view of this.views.values()) view.close();
      if (this.painter) this.painter.close(true);
      if (this.session) this.session.stop();
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  // ---------- storage ----------

  readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.storageDir, file), "utf8"));
    } catch {
      return null;
    }
  }

  writeJson(file, data) {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(path.join(this.storageDir, file), JSON.stringify(data, null, 2));
    } catch (err) {
      this.log.warn(`Could not write ${file}: ${err.message}`);
    }
  }

  // ---------- startup ----------

  async start() {
    const auth = this.readJson("auth.json");
    if (!auth || !auth.userData) {
      this.log.warn(
        "Not logged in to Roborock yet. Open this plugin's settings in the Homebridge UI, " +
          "enter your Roborock email, press 'Send code' and then 'Log in'. Then restart Homebridge."
      );
      return;
    }

    let home;
    try {
      home = await cloud.getHomeData(auth);
      this.writeJson("home-cache.json", home);
    } catch (err) {
      home = this.readJson("home-cache.json");
      if (err.code === "AUTH") {
        this.log.error(err.message);
        if (!home) return;
      } else if (!home) {
        this.log.error(`Could not read your Roborock home (${err.message}). Will retry in 5 minutes.`);
        setTimeout(() => !this.stopped && this.start().catch(() => {}), 5 * 60 * 1000).unref?.();
        return;
      } else {
        this.log.warn(`Could not refresh your Roborock home (${err.message}); using the cached copy.`);
      }
    }

    const skip = new Set((this.config.skipDevices || []).map((s) => String(s).trim()));
    const products = new Map((home.products || []).map((p) => [p.id, p]));
    const allDevices = [...(home.devices || []), ...(home.receivedDevices || [])];
    const robots = allDevices.filter((d) => {
      if (skip.has(d.duid) || skip.has(d.sn) || skip.has(d.name)) return false;
      const product = products.get(d.productId);
      const isVacuum = !product || !product.category || /vacuum|robot/i.test(product.category);
      if (!isVacuum) return false;
      if (d.pv && d.pv !== "1.0") {
        this.log.warn(`${d.name}: protocol ${d.pv} is not supported yet (only S/Q/Saros-series "1.0" robots). Skipping.`);
        return false;
      }
      return !!d.localKey;
    });

    if (!robots.length) {
      this.log.warn("No supported Roborock robots were found on this account.");
      return;
    }

    const roomNames = new Map((home.rooms || []).map((r) => [String(r.id), r.name]));
    this.auth = auth;
    // Listening to other apps' map requests is something Roborock's cloud may
    // refuse by closing the connection. Once it did, that is remembered, so a
    // restart does not cost two more reconnects.
    const listen = this.readJson("listen.json");
    const retryAt = listen && Number(listen.refusedAt) > 0 ? Number(listen.refusedAt) + (LISTEN_RETRY_MS[listen.how] || LISTEN_RETRY_MS.closed) : 0;
    const refusedLately = this.config.followExternal !== false && Date.now() < retryAt && Number(listen.refusedAt) <= Date.now();
    if (refusedLately) {
      this.log.info(
        `The Roborock cloud did not let this plugin see other apps' map requests on ${new Date(Number(listen.refusedAt)).toISOString().slice(0, 10)}, so that is not tried again until ${new Date(retryAt).toISOString().slice(0, 10)}. ` +
          "A room clean started from the Roborock app shows in Apple Home once the app is closed."
      );
    }
    this.session = new RoborockSession(auth.userData, this.log, {
      overhear: this.config.followExternal !== false && !refusedLately,
      onOverhearRefused: (how) => this.writeJson("listen.json", { refusedAt: Date.now(), how: how === "closed" ? "closed" : "refused" }),
    });
    this.session.start();

    const wanted = new Set();
    const roomsOf = new Map(); // duid -> [{ segmentId, name }]
    const routineEntries = this.routineEntries();
    let routinesComplete = true;
    for (const robot of robots) {
      const netFile = `net-${robot.duid}.json`;
      const savedIp = (this.config.robotIps || {})[robot.name] || this.config.robotIp || (this.readJson(netFile) || {}).ip;
      const channel = this.session.channel(robot.duid, robot.localKey, robot.name, savedIp);
      const segments = await this.loadRooms(channel, roomNames);
      roomsOf.set(robot.duid, segments);
      if (!this.config.robotIp) {
        try {
          const ip = await channel.getIp();
          if (ip) {
            channel.setHost(ip);
            if (ip !== savedIp) this.writeJson(netFile, { ip });
            this.log.info(`${robot.name}: commands go directly to the robot at ${ip} (cloud as backup).`);
          }
        } catch (err) {
          this.log.debug(`${robot.name}: could not read the robot's network address: ${err.message}`);
        }
      }
      this.setupStatusMonitor(robot, channel);
      if (this.config.mapCamera === true) {
        try {
          this.setupMapCamera(robot, channel, segments, robots.length > 1, products.get(robot.productId));
        } catch (err) {
          this.log.error(`${robot.name}: the map camera could not be set up: ${err.message}`);
        }
      }
      if (this.config.chargingSensor !== false) {
        wanted.add(this.setupChargingSensor(robot, channel, robots.length > 1));
      }
      if (this.config.cleaningSensor === true) {
        wanted.add(this.setupCleaningSensor(robot, robots.length > 1));
      }
      for (const def of this.buildPrograms(robot, segments, robots.length > 1)) {
        wanted.add(def.uuid);
        this.setupAccessory(def, channel);
      }
      if (routineEntries.length) {
        const list = await this.loadRoutines(auth, robot);
        if (!list) {
          // The list could not be read: keep the switches that already exist
          // instead of removing them (and their automations) from Apple Home.
          routinesComplete = false;
          for (const a of this.accessories.values()) {
            if (a.context.routine && a.context.duid === robot.duid) wanted.add(a.UUID);
          }
        } else {
          for (const def of this.buildRoutines(robot, list, routineEntries, robots.length > 1)) {
            wanted.add(def.uuid);
            this.setupRoutine(def, channel);
          }
        }
      }
    }
    this.ready = true;
    if (this.config.matterVacuum === true) {
      for (const robot of robots) {
        try {
          this.setupMatterVacuum(robot, this.monitors.get(robot.duid).channel, roomsOf.get(robot.duid) || [], robots.length > 1, products.get(robot.productId));
        } catch (err) {
          this.log.error(`${robot.name}: the robot vacuum for Apple Home could not be set up: ${err.message}`);
        }
      }
    }
    if (routinesComplete) {
      const missing = routineEntries.filter((e) => !e.matched).map((e) => e.name || e.id);
      if (missing.length) {
        this.log.warn(`Routine(s) not found in the Roborock app: ${missing.join(", ")}. Untick them in the plugin settings.`);
      }
    }

    // Remove accessories that no longer match any program (renamed/removed rooms).
    const stale = [...this.accessories.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) this.accessories.delete(a.UUID);
      this.log.info(`Removed ${stale.length} old accessory(ies).`);
    }
  }

  // ---------- robot vacuum (Matter) ----------

  /**
   * The robot as a robot vacuum in Apple Home: its own tile with the vacuum
   * icon. Apple Home knows robot vacuums only through Matter, which Homebridge
   * offers from version 2 on, on bridges where Matter is turned on. Homebridge
   * publishes a robot vacuum on its own, with its own pairing code.
   */
  setupMatterVacuum(robot, channel, rooms, multiRobot, product) {
    const api = this.api;
    const enabled = typeof api.isMatterEnabled === "function" ? api.isMatterEnabled() : !!api.matter;
    const matter = enabled ? api.matter : null;
    if (!matter || !matter.deviceTypes || !matter.deviceTypes.RoboticVacuumCleaner || typeof matter.registerPlatformAccessories !== "function") {
      if (!this.saidNoMatter) {
        this.saidNoMatter = true;
        this.log.warn(
          matter
            ? "The robot vacuum for Apple Home is turned on in the plugin settings, but this Homebridge version has no robot vacuums in its Matter support. Update Homebridge."
            : "The robot vacuum for Apple Home is turned on in the plugin settings, but Matter is not turned on for this plugin's bridge, so there is no vacuum in Apple Home yet. " +
                "In the Homebridge UI open this plugin's bridge settings, turn Matter on (Homebridge 2 or later) and restart Homebridge. The fans, switches and the map camera do not need it."
        );
      }
      return null;
    }
    let name = String(this.config.matterVacuumName || "").trim();
    if (!name) name = robot.name;
    else if (multiRobot) name = `${name} ${robot.name}`;
    const file = `vacuum-${robot.duid}.json`;
    const programs = () => [...this.programs.values()].filter((p) => p.robot.duid === robot.duid);
    // The fans and switches of this robot go off. What one of them still meant to
    // put back (the robot's own suction and water) is handed on, not dropped.
    const switchOff = () => {
      let restore = null;
      for (const program of programs()) {
        clearTimeout(program.startTimer);
        program.startTimer = null;
        // Also from a fan that was just turned off and has not put its settings back yet.
        restore = restore || program.restore || null;
        program.restore = null;
        if (!program.running) continue;
        clearTimeout(program.pollTimer);
        this.setRunning(program, false);
      }
      return restore;
    };
    const vacuum = new MatterVacuum({
      log: this.log,
      matter,
      pluginName: PLUGIN_NAME,
      platformName: PLATFORM_NAME,
      name,
      robot,
      model: (product && (product.name || product.model)) || "Robot vacuum",
      channel,
      rooms,
      maxPlus: !!this.config.enableMaxPlus,
      defaultFan: SUCTION[this.levels().includes(this.config.suction) ? this.config.suction : "max"],
      // One room: the passes set for that room. Several: the default.
      repeat: (ids) => {
        const own = ids.length === 1 ? programs().find((p) => p.kind !== "routine" && p.segments.length === 1 && p.segments[0] === ids[0]) : null;
        return clampRepeat(own ? own.repeat : (this.config.repeat ?? 2));
      },
      restore: this.config.restoreSettings !== false,
      store: { read: () => this.readJson(file), write: (data) => this.writeJson(file, data) },
      checkMs: this.vacuumCheckMs, // tests only
      status: () => {
        const monitor = this.monitors.get(robot.duid);
        if (!monitor || (!monitor.full && !monitor.last)) return null;
        return { ...(monitor.full || {}), ...(monitor.last || {}), fullAt: monitor.fullAt };
      },
      readStatus: (maxAgeMs) => this.readStatus(robot.duid, channel, maxAgeMs),
      refreshSoon: (ms) => this.refreshStatusSoon(robot.duid, ms),
      sendToDock: (still) => this.sendToDock({ channel, robot, name }, still),
      // A fan or switch of this robot is on, or about to start.
      othersBusy: () => programs().some((p) => p.running || p.startTimer),
      // The plugin stopped a clean of this robot a moment ago (the robot may not show it yet).
      stopping: () => {
        const monitor = this.monitors.get(robot.duid);
        return !!monitor && Date.now() < (monitor.quietUntil || 0);
      },
      // A setting the vacuum just sent: the status known here says so at once.
      noteSetting: (key, value) => {
        const monitor = this.monitors.get(robot.duid);
        if (monitor && monitor.full) monitor.full = { ...monitor.full, [key]: value };
      },
      // Homebridge 2.4.0 and later can be asked whether it brought the vacuum up.
      verify: typeof api.versionGreaterOrEqual === "function" && api.versionGreaterOrEqual("2.4.0"),
      // A clean started from the vacuum is this plugin's own: the fans and switches of the robot go off...
      started: () => {
        const restore = switchOff();
        this.begun(robot.duid);
        this.claim(robot.duid);
        return restore;
      },
      // ... and the one that stands for exactly this clean is shown as on, like for a clean started in the Roborock app.
      show: (ids, status) => {
        if (this.config.followExternal === false) return;
        const match = ids ? this.matchExternal(programs(), "segments", ids, status) : this.matchExternal(programs(), "all", null, status);
        if (!match) return;
        this.log.info(`${match.name}: started from the robot vacuum in Apple Home, showing it as on.`);
        this.adopt(match, status);
        match.startedAt = Date.now(); // just started: the robot may take a moment to get going
      },
      stopped: () => {
        const restore = switchOff();
        this.quiet(robot.duid);
        return restore;
      },
      // The rooms of the fan or switch that is on now: a list, null for the whole home (or when
      // they cannot be told), undefined when none is on.
      runningRooms: () => {
        const program = programs().find((p) => p.running);
        if (!program) return undefined;
        if (program.kind !== "routine") return (program.segments || []).slice();
        const steps = program.steps || [];
        if (!steps.length || steps.some((step) => step.kind !== "segments")) return null;
        return [...new Set(steps.flatMap((step) => step.segments))];
      },
    });
    this.vacuums.set(robot.duid, vacuum);
    vacuum.start();
    return vacuum;
  }

  // ---------- map camera ----------

  /**
   * A camera in Apple Home that shows the robot's map, drawn by this plugin.
   * It is its own accessory (Apple Home wants cameras that way) and is added
   * once, with the setup code of this plugin's bridge.
   */
  setupMapCamera(robot, channel, rooms, multiRobot, product) {
    if (!this.painter) this.painter = new Painter(this.log);
    let name = String(this.config.mapCameraName || "").trim();
    if (!name) name = this.text.map(robot.name);
    else if (multiRobot) name = `${name} ${robot.name}`;
    const config = this.config;
    const view = new MapView({
      log: this.log,
      name,
      channel,
      painter: this.painter,
      file: path.join(this.storageDir, `map-${robot.duid}.bin`),
      options: () => ({
        theme: config.mapTheme,
        colors: config.mapColors,
        roomColors: config.mapRoomColors,
        rooms,
        rotation: Number(config.mapRotation) || 0,
        labels: config.mapLabels !== false,
        statusBar: config.mapStatus !== false,
        hideBeyondWalls: config.mapHideBeyondWalls === true,
        carpets: config.mapCarpets !== false,
        language: config.language === "he" ? "he" : "en",
        size: 1280,
      }),
      status: () => {
        const monitor = this.monitors.get(robot.duid);
        if (!monitor || (!monitor.full && !monitor.last)) return null;
        return { ...(monitor.full || {}), ...(monitor.last || {}) };
      },
    });
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
    } catch {
      /* the map is then simply not kept between restarts */
    }
    const kept = view.load();
    this.views.set(robot.duid, view);
    channel.onMap = (map) => view.offer(map);
    const camera = new PictureCamera({
      api: this.api,
      log: this.log,
      pluginName: PLUGIN_NAME,
      name,
      id: robot.duid,
      info: { manufacturer: "Roborock", model: (product && (product.name || product.model)) || "Robot vacuum", serial: robot.sn || robot.duid, firmware: /^\d+(\.\d+){0,2}$/.test(String(robot.fv || "")) ? String(robot.fv) : null },
      ffmpegPath: config.ffmpegPath,
      snapshot: () => view.snapshot(),
      picture: () => view.picture(),
      size: () => view.size,
      watching: (on) => view.setLive(on),
    });
    camera.publish();
    this.cameras.push(camera);
    this.log.info(
      `${name}: the map camera is ready. If it is not in Apple Home yet, add it once: Add Accessory > More options, choose "${name}" and enter the setup code of this plugin's bridge.`
    );
    // Have a picture ready before Home asks for one; without a kept map the robot is asked once.
    view.draw();
    if (!kept) {
      setTimeout(() => {
        if (!this.stopped) view.fetch().then(() => view.draw(), () => {});
      }, 8000).unref?.();
    }
    return view;
  }

  /** Room list for one robot: [{ segmentId, name }]. Falls back to the cache while the robot is offline. */
  async loadRooms(channel, roomNames) {
    const cacheFile = `rooms-${channel.duid}.json`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const mapping = await channel.getRoomMapping();
        const rooms = mapping.map((m) => ({
          segmentId: m.segmentId,
          name: roomNames.get(m.roomId) || this.text.room(m.segmentId),
        }));
        if (rooms.length) {
          this.writeJson(cacheFile, rooms);
          this.log.info(`${channel.name}: rooms ${rooms.map((r) => `${r.name} (${r.segmentId})`).join(", ")}`);
          return rooms;
        }
      } catch (err) {
        this.log.debug(`${channel.name}: reading rooms failed (attempt ${attempt}): ${err.message}`);
      }
      if (attempt < 3) await sleep(5000);
    }
    const cached = this.readJson(cacheFile);
    if (cached) {
      this.log.warn(`${channel.name}: robot did not answer, using the saved room list.`);
      return cached;
    }
    this.log.error(`${channel.name}: could not read the room list (is the robot online and is a map saved?).`);
    return [];
  }

  // ---------- routines ----------

  /** The routines ticked in the plugin settings: [{ id, name }] (either may be missing). */
  routineEntries() {
    const out = [];
    for (const item of Array.isArray(this.config.routines) ? this.config.routines : []) {
      const entry = item && typeof item === "object" ? item : { name: item };
      const id = entry.id == null ? "" : String(entry.id).trim();
      const name = entry.name == null ? "" : String(entry.name).trim();
      if (id || name) out.push({ id, name, matched: false });
    }
    return out;
  }

  /** Routine list of one robot: [{ id, name }], or null when it cannot be read and nothing is saved. */
  async loadRoutines(auth, robot) {
    const cacheFile = `routines-${robot.duid}.json`;
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const list = await cloud.getRoutines(auth, robot.duid);
        this.writeJson(cacheFile, list);
        this.log.info(`${robot.name}: routines ${list.map((r) => r.name).join(", ") || "(none)"}`);
        return list;
      } catch (err) {
        lastErr = err;
        this.log.debug(`${robot.name}: reading routines failed (attempt ${attempt}): ${err.message}`);
      }
      if (attempt < 2) await sleep(3000);
    }
    const cached = this.readJson(cacheFile);
    if (Array.isArray(cached)) {
      this.log.warn(`${robot.name}: could not read the routines (${lastErr.message}), using the saved list.`);
      return cached;
    }
    this.log.error(`${robot.name}: could not read the routines (${lastErr.message}).`);
    return null;
  }

  buildRoutines(robot, list, entries, multiRobot) {
    // Same rule as the fan name: the routine name is always part of the switch name.
    let template = String(this.config.routineNameTemplate || "{routine}").trim();
    if (!/\{routine\}/i.test(template)) template = template ? `${template} {routine}` : "{routine}";
    const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
    const byId = new Map(list.map((r) => [String(r.id), r]));
    const defs = new Map();
    for (const entry of entries) {
      // The id survives a rename in the Roborock app; the name is the fallback
      // for a config that was written by hand.
      const routine =
        (entry.id && byId.get(entry.id)) ||
        (entry.name && (list.find((r) => norm(r.name) === norm(entry.name)) || byId.get(entry.name)));
      if (!routine) continue;
      entry.matched = true;
      const base = template.replace(/\{routine\}/gi, routine.name).trim();
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:routine:${routine.id}`);
      defs.set(uuid, {
        kind: "routine",
        uuid,
        name: multiRobot ? `${base} (${robot.name})` : base,
        robot,
        routineId: routine.id,
        routineName: routine.name,
        steps: Array.isArray(routine.steps) ? routine.steps : [],
      });
    }
    return [...defs.values()];
  }

  /** A switch that starts a routine from the Roborock app and stays on while the robot is cleaning. */
  setupRoutine(def, channel) {
    const { Service, Characteristic } = this.api.hap;
    let accessory = this.accessories.get(def.uuid);
    const nameChanged = !accessory || accessory.context.name !== def.name;
    if (!accessory) {
      accessory = new this.api.platformAccessory(def.name, def.uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(def.uuid, accessory);
      this.log.info(`Added "${def.name}".`);
    }
    accessory.context.name = def.name;
    accessory.context.duid = def.robot.duid;
    accessory.context.routine = { id: def.routineId, name: def.routineName };

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(Characteristic.Model, def.robot.name || "Robot vacuum")
      .setCharacteristic(Characteristic.SerialNumber, `${def.robot.sn || def.robot.duid}-routine-${def.routineId}`);

    const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, def.name);
    service.setCharacteristic(Characteristic.Name, def.name);
    // As with the fans: a rename done in the Home app is kept across restarts.
    if (Characteristic.ConfiguredName && nameChanged) {
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, def.name);
    }

    const battery = this.setupBattery(accessory, def, service);

    const program = { ...def, channel, accessory, service, battery, running: false, pollTimer: null, restore: null, startTimer: null, idlePolls: 0 };
    this.programs.set(def.uuid, program);

    const on = service.getCharacteristic(Characteristic.On);
    on.onGet(() => program.running);
    on.onSet((value) => {
      if (!value) this.requestStop(program);
      else if (!program.running) this.startRoutine(program);
    });
    on.updateValue(false);
    this.applyFanBattery(program);
  }

  async startRoutine(program) {
    const { channel } = program;
    this.takeOver(program);
    this.begun(program.robot.duid);
    program.adopted = false;
    this.setRunning(program, true);
    this.claim(program.robot.duid);
    this.log.info(`${program.name}: starting the routine "${program.routineName}".`);
    try {
      const status = await this.readStatus(program.robot.duid, channel, 5000).catch(() => null);
      if (status && status.in_cleaning) {
        await channel.send("app_stop", []).catch(() => {});
        await sleep(2000);
      }
      await cloud.runRoutine(this.auth, program.routineId);
      program.startedAt = Date.now();
      program.idlePolls = 0;
      this.schedulePoll(program, 30000);
      this.refreshStatusSoon(program.robot.duid, 5000); // shows "off the dock" quickly
    } catch (err) {
      this.log.error(`${program.name}: could not start: ${err.message}`);
      this.setRunning(program, false);
      this.quiet(program.robot.duid);
      await this.restoreSettings(program);
    }
  }

  // ---------- room fans ----------

  buildPrograms(robot, segments, multiRobot) {
    const c = this.config;
    const defaults = {
      suction: c.suction || "max",
      mopMode: c.mopMode || "vacuum_only",
      repeat: clampRepeat(c.repeat ?? 2),
    };
    // The room name is always part of the fan name: if the template has no
    // {room} placeholder (easy to lose when typing right-to-left), append it.
    let template = String(c.nameTemplate || this.text.fan).trim();
    if (!/\{room\}/i.test(template)) template = template ? `${template} {room}` : "{room}";
    const byName = new Map(segments.map((s) => [s.name.trim().toLowerCase(), s]));
    const defs = [];

    const makeName = (base) => (multiRobot ? `${base} (${robot.name})` : base);

    if (c.autoRooms !== false) {
      const exclude = new Set((c.excludeRooms || []).map((r) => String(r).trim().toLowerCase()));
      // Per-room overrides (set from the room list in the plugin settings).
      const perRoom = new Map();
      for (const r of Array.isArray(c.roomSettings) ? c.roomSettings : []) {
        if (r && r.room != null) perRoom.set(String(r.room).trim().toLowerCase(), r);
      }
      for (const seg of segments) {
        if (exclude.has(seg.name.trim().toLowerCase())) continue;
        const own = perRoom.get(seg.name.trim().toLowerCase()) || perRoom.get(String(seg.segmentId)) || {};
        defs.push({
          uuid: this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:room:${seg.segmentId}`),
          name: makeName(template.replace(/\{room\}/gi, seg.name).trim()),
          robot,
          segments: [seg.segmentId],
          ...defaults,
          repeat: clampRepeat(own.repeat ?? defaults.repeat),
        });
      }
    }

    for (const prog of c.programs || []) {
      if (!prog || !prog.name) continue;
      if (prog.robot && prog.robot !== robot.name && prog.robot !== robot.duid) continue;
      const ids = [];
      const missing = [];
      for (const r of prog.rooms || []) {
        const key = String(r).trim();
        const seg = byName.get(key.toLowerCase()) || segments.find((s) => String(s.segmentId) === key);
        if (seg) ids.push(seg.segmentId);
        else missing.push(key);
      }
      if (missing.length) this.log.warn(`Program "${prog.name}": unknown room(s) ${missing.join(", ")}.`);
      if (!ids.length && (prog.rooms || []).length) continue;
      if (!ids.length && !segments.length) continue;
      defs.push({
        uuid: this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:program:${prog.name}`),
        name: makeName(prog.name),
        robot,
        segments: ids.length ? ids : segments.map((s) => s.segmentId), // no rooms listed = every room
        suction: prog.suction || defaults.suction,
        mopMode: prog.mopMode || defaults.mopMode,
        repeat: clampRepeat(prog.repeat ?? defaults.repeat),
      });
    }
    return defs;
  }

  // ---------- charging sensor ----------

  /**
   * One contact sensor per robot: closed = on the dock charging (or full),
   * open = off the dock. The same accessory carries the battery level.
   */
  setupChargingSensor(robot, channel, multiRobot) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:charging`);
    const base = this.config.chargingSensorName || this.text.charging(robot.name);
    const name = multiRobot && this.config.chargingSensorName ? `${base} (${robot.name})` : base;
    let accessory = this.accessories.get(uuid);
    const nameChanged = !accessory || accessory.context.name !== name;
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info(`Added "${name}".`);
    }
    accessory.context.name = name;
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(Characteristic.Model, robot.name || "Robot vacuum")
      .setCharacteristic(Characteristic.SerialNumber, `${robot.sn || robot.duid}-dock`);

    const contact = accessory.getService(Service.ContactSensor) || accessory.addService(Service.ContactSensor, name);
    contact.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName && nameChanged) {
      if (!contact.testCharacteristic(Characteristic.ConfiguredName)) contact.addOptionalCharacteristic(Characteristic.ConfiguredName);
      contact.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    const battery = accessory.getService(Service.Battery) || accessory.addService(Service.Battery, this.text.battery(name));

    const dock = { robot, channel, accessory, contact, battery, timer: null, last: accessory.context.last || null };
    this.docks.set(robot.duid, dock);

    contact.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.contactValue(dock.last));
    battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => (dock.last ? dock.last.battery : 100));
    battery.getCharacteristic(Characteristic.ChargingState).onGet(() => this.chargingValue(dock.last));
    battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.lowBatteryValue(dock.last));
    if (dock.last) this.applyDock(dock);
    // Start from the last known status until the first answer arrives.
    const monitor = this.monitors.get(robot.duid);
    if (monitor && !monitor.last) monitor.last = dock.last;
    return uuid;
  }

  // ---------- robot status (battery, on the dock or not) ----------

  /**
   * Keeps the robot's status up to date for the charging sensor and for the
   * battery shown on every fan. Three sources, fastest first:
   *  - the robot reports changes itself through the cloud connection (instant),
   *  - a check right after a fan starts or stops a clean,
   *  - a regular check: every `statusInterval` seconds on the dock, every
   *    30 seconds (or less) while the robot is away from it.
   * The robot is never asked more than it was before these were added:
   * every reader shares one recent answer, and when the robot does not
   * answer the checks slow down (up to 10 minutes apart) instead of piling up.
   */
  setupStatusMonitor(robot, channel) {
    const saved = this.readJson(`status-${robot.duid}.json`);
    const known = saved && typeof saved.battery === "number" && typeof saved.state === "number" ? { state: saved.state, battery: saved.battery } : null;
    // Until the first answer arrives, Home shows the values from before the restart.
    const monitor = { robot, channel, last: known, full: null, fullAt: 0, inflight: null, fails: 0, staleWarned: false, timer: null, dueAt: 0, polledAt: 0, job: null, quietFrom: 0, quietUntil: 0, noMapUntil: 0, closeUntil: 0, reportedAt: 0 };
    this.monitors.set(robot.duid, monitor);
    const intervalMs = Math.max(30, Number(this.config.statusInterval) || 60) * 1000;
    monitor.tick = async () => {
      if (this.stopped) return;
      clearTimeout(monitor.timer);
      monitor.timer = null;
      try {
        // While watching closely a fresh answer is wanted, not one from a few seconds ago.
        await this.readStatus(robot.duid, channel, this.watchingClosely(monitor) ? 1000 : STATUS_SHARE_MS);
      } catch (err) {
        this.log.debug(`${robot.name}: status update failed: ${err.message}`);
      }
      if (this.stopped) return;
      if (monitor.timer) return; // a sooner check was requested meanwhile
      if (this.watchingClosely(monitor)) {
        this.refreshStatusSoon(robot.duid, CLOSE_WATCH_STEP_MS);
        return;
      }
      const away = monitor.last && !RoborockRoomCleanPlatform.isCharging(monitor.last);
      const base = away ? Math.min(intervalMs, 30000) : intervalMs;
      this.refreshStatusSoon(robot.duid, Math.min(base * 2 ** Math.min(monitor.fails, 6), 10 * 60 * 1000));
    };
    channel.onPush = (update) => this.onStatusPush(robot.duid, update);
    this.refreshStatusSoon(robot.duid, 2000);
    return monitor;
  }

  /**
   * The robot's full status. An answer younger than `maxAgeMs` is reused, and
   * callers that ask at the same moment share one request.
   */
  async readStatus(duid, channel, maxAgeMs = STATUS_SHARE_MS) {
    const monitor = this.monitors.get(duid);
    if (!monitor) return channel.getStatus();
    if (monitor.full && Date.now() - monitor.fullAt < maxAgeMs) return monitor.full;
    if (!monitor.inflight) {
      monitor.polledAt = Date.now();
      monitor.inflight = channel
        .getStatus()
        .then((status) => {
          if (!status || typeof status.battery !== "number") throw new Error("the robot sent no status");
          monitor.full = status;
          monitor.fullAt = Date.now();
          if (monitor.staleWarned) this.log.info(`${monitor.robot.name}: status is being read again.`);
          monitor.fails = 0;
          monitor.staleWarned = false;
          this.updateStatus(duid, status);
          this.watchExternal(monitor, status);
          return status;
        })
        .catch((err) => {
          monitor.fails++;
          // Say it once: the battery and charging state shown in Home are old.
          if (monitor.fails >= 5 && !monitor.staleWarned) {
            monitor.staleWarned = true;
            this.log.warn(`${monitor.robot.name}: the status could not be read ${monitor.fails} times in a row (${err.message}). Battery and charging state in Apple Home may be out of date.`);
          }
          throw err;
        })
        .finally(() => {
          monitor.inflight = null;
        });
    }
    return monitor.inflight;
  }

  /** Ask the robot for its status in `delayMs`, unless a check is already due sooner. */
  refreshStatusSoon(duid, delayMs) {
    const monitor = this.monitors.get(duid);
    if (!monitor || this.stopped) return;
    const dueAt = Date.now() + delayMs;
    if (monitor.timer && monitor.dueAt <= dueAt) return;
    clearTimeout(monitor.timer);
    monitor.dueAt = dueAt;
    monitor.timer = setTimeout(monitor.tick, delayMs);
    monitor.timer.unref?.();
  }

  /** The robot reported a change by itself: show it at once, then read the full status. */
  onStatusPush(duid, update) {
    const monitor = this.monitors.get(duid);
    if (!monitor || !update) return;
    const next = { ...(monitor.last || {}) };
    const stateChanged = typeof update.state === "number" && next.state !== update.state;
    if (typeof update.state === "number") next.state = update.state;
    if (typeof update.battery === "number") next.battery = update.battery;
    this.log.debug(`${monitor.robot.name}: robot reported ${JSON.stringify(update)}`);
    if (typeof next.state === "number" && typeof next.battery === "number") this.updateStatus(duid, next);
    // The robot started doing something that nobody asked for in Home: most
    // likely a clean started in the Roborock app. Look right away, and keep
    // looking every few seconds until it is clear what it is.
    if (stateChanged && !RoborockRoomCleanPlatform.isCharging(next) && !monitor.job && !this.busy(duid) && this.canWatchClosely(monitor)) {
      if (!monitor.reportedAt) monitor.reportedAt = Date.now();
      monitor.closeUntil = Date.now() + CLOSE_WATCH_MS;
      this.refreshStatusSoon(duid, 1500);
      return;
    }
    // Follow up with a full status read, but never more than one every 30 seconds.
    this.refreshStatusSoon(duid, Math.max(3000, 30000 - (Date.now() - monitor.polledAt)));
  }

  /** Quick status reads are only done over the home network, and only while that works. */
  canWatchClosely(monitor) {
    return this.config.followExternal !== false && this.ready && !!monitor.channel.local && monitor.channel.lastVia === "local" && monitor.fails === 0;
  }

  /** True for a short while after the robot reported a change, until the clean it started is recognised. */
  watchingClosely(monitor) {
    return Date.now() < monitor.closeUntil && !monitor.job && this.canWatchClosely(monitor);
  }

  /** New status for one robot: update the charging sensor and the battery on its fans. */
  updateStatus(duid, status) {
    if (!status || typeof status.battery !== "number") return;
    const monitor = this.monitors.get(duid);
    if (monitor) {
      const before = monitor.last;
      const changed = !before || before.state !== status.state || before.battery !== status.battery;
      monitor.last = { state: status.state, battery: status.battery };
      if (changed) this.writeJson(`status-${duid}.json`, monitor.last);
      const view = this.views.get(duid);
      if (view) view.statusChanged(before, monitor.last);
      const vacuum = this.vacuums.get(duid);
      if (vacuum) vacuum.statusChanged();
    }
    this.updateChargingSensor(duid, status);
    this.updateCleaningSensor(duid, status);
    for (const program of this.programs.values()) {
      if (program.robot.duid === duid) this.applyFanBattery(program);
    }
  }

  lastStatus(duid) {
    const monitor = this.monitors.get(duid);
    return monitor ? monitor.last : null;
  }

  /**
   * Battery level and charging state inside every fan and routine switch (same
   * robot, same values). The low-battery warning stays with the charging
   * sensor, so Home does not flag a dozen accessories at once.
   * Returns the battery service, or null when the option is turned off.
   */
  setupBattery(accessory, def, mainService) {
    const { Service, Characteristic } = this.api.hap;
    const existing = accessory.getService(Service.Battery);
    if (this.config.batteryOnFans === false) {
      if (existing) accessory.removeService(existing);
      return null;
    }
    const battery = existing || accessory.addService(Service.Battery, this.text.battery(def.name));
    const duid = def.robot.duid;
    battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => {
      const last = this.lastStatus(duid);
      return last ? Math.max(0, Math.min(100, last.battery)) : 100;
    });
    battery.getCharacteristic(Characteristic.ChargingState).onGet(() => this.fanChargingValue(this.lastStatus(duid)));
    battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    mainService.setPrimaryService?.(true); // the fan or switch stays the main tile
    return battery;
  }

  /** Battery on a fan or switch: level, and "charging" while the robot sits on the dock (charging or full). */
  applyFanBattery(program) {
    if (!program.battery) return;
    const { Characteristic } = this.api.hap;
    const last = this.lastStatus(program.robot.duid);
    if (!last) return;
    program.battery.updateCharacteristic(Characteristic.BatteryLevel, Math.max(0, Math.min(100, last.battery)));
    program.battery.updateCharacteristic(Characteristic.ChargingState, this.fanChargingValue(last));
  }

  fanChargingValue(last) {
    const C = this.api.hap.Characteristic.ChargingState;
    return RoborockRoomCleanPlatform.isCharging(last) ? C.CHARGING : C.NOT_CHARGING;
  }

  static isCharging(status) {
    // 8 = charging, 100 = fully charged (still on the dock).
    return !!status && (status.state === 8 || status.state === 100);
  }

  contactValue(last) {
    const C = this.api.hap.Characteristic.ContactSensorState;
    return RoborockRoomCleanPlatform.isCharging(last) ? C.CONTACT_DETECTED : C.CONTACT_NOT_DETECTED;
  }

  chargingValue(last) {
    const C = this.api.hap.Characteristic.ChargingState;
    if (!last) return C.NOT_CHARGING;
    if (last.state === 8) return C.CHARGING;
    return C.NOT_CHARGING;
  }

  lowBatteryValue(last) {
    const C = this.api.hap.Characteristic.StatusLowBattery;
    return last && last.battery <= 20 ? C.BATTERY_LEVEL_LOW : C.BATTERY_LEVEL_NORMAL;
  }

  /**
   * A contact sensor that is open while the robot is cleaning and closed
   * otherwise (paused, stopped, on its way back, on the dock).
   */
  setupCleaningSensor(robot, multiRobot) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:cleaning`);
    const base = this.config.cleaningSensorName || this.text.cleaning(robot.name);
    const name = multiRobot && this.config.cleaningSensorName ? `${base} (${robot.name})` : base;
    let accessory = this.accessories.get(uuid);
    const nameChanged = !accessory || accessory.context.name !== name;
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info(`Added "${name}".`);
    }
    accessory.context.name = name;
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(Characteristic.Model, robot.name || "Robot vacuum")
      .setCharacteristic(Characteristic.SerialNumber, `${robot.sn || robot.duid}-cleaning`);
    const contact = accessory.getService(Service.ContactSensor) || accessory.addService(Service.ContactSensor, name);
    contact.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName && nameChanged) {
      if (!contact.testCharacteristic(Characteristic.ConfiguredName)) contact.addOptionalCharacteristic(Characteristic.ConfiguredName);
      contact.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    const sensor = { robot, accessory, contact, last: accessory.context.last || null };
    this.cleaningSensors.set(robot.duid, sensor);
    contact.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.cleaningValue(sensor.last));
    contact.updateCharacteristic(Characteristic.ContactSensorState, this.cleaningValue(sensor.last));
    return uuid;
  }

  /** Cleaning: the cleaning states, and emptying the bin or washing the mop in the middle of a clean. */
  static isCleaningNow(last) {
    if (!last) return false;
    if (CLEANING_STATES.has(last.state)) return true;
    return [22, 23, 26].includes(last.state) && !!last.inCleaning;
  }

  cleaningValue(last) {
    const C = this.api.hap.Characteristic.ContactSensorState;
    return RoborockRoomCleanPlatform.isCleaningNow(last) ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  updateCleaningSensor(duid, status) {
    const sensor = this.cleaningSensors.get(duid);
    if (!sensor || !status || typeof status.state !== "number") return;
    const was = RoborockRoomCleanPlatform.isCleaningNow(sensor.last);
    const inCleaning = status.in_cleaning !== undefined ? Number(status.in_cleaning) : sensor.last ? sensor.last.inCleaning : 0;
    sensor.last = { state: status.state, inCleaning };
    sensor.accessory.context.last = sensor.last;
    const now = RoborockRoomCleanPlatform.isCleaningNow(sensor.last);
    if (was !== now) this.log.info(`${sensor.robot.name}: ${now ? "cleaning" : "not cleaning"}.`);
    sensor.contact.updateCharacteristic(this.api.hap.Characteristic.ContactSensorState, this.cleaningValue(sensor.last));
  }

  updateChargingSensor(duid, status) {
    const dock = this.docks.get(duid);
    if (!dock || !status || typeof status.battery !== "number") return;
    const wasCharging = RoborockRoomCleanPlatform.isCharging(dock.last);
    dock.last = { state: status.state, battery: status.battery };
    dock.accessory.context.last = dock.last;
    if (wasCharging !== RoborockRoomCleanPlatform.isCharging(dock.last)) {
      this.log.info(`${dock.robot.name}: ${RoborockRoomCleanPlatform.isCharging(dock.last) ? "on the dock" : "off the dock"} (battery ${status.battery}%).`);
    }
    this.applyDock(dock);
  }

  applyDock(dock) {
    const { Characteristic } = this.api.hap;
    dock.contact.updateCharacteristic(Characteristic.ContactSensorState, this.contactValue(dock.last));
    dock.battery.updateCharacteristic(Characteristic.BatteryLevel, Math.max(0, Math.min(100, dock.last.battery)));
    dock.battery.updateCharacteristic(Characteristic.ChargingState, this.chargingValue(dock.last));
    dock.battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBatteryValue(dock.last));
  }

  // ---------- cleans started outside Apple Home ----------

  /** True while a fan or routine switch of this robot is on, or about to start. */
  busy(duid) {
    for (const program of this.programs.values()) {
      if (program.robot.duid === duid && (program.running || program.startTimer)) return true;
    }
    // A clean started from the robot vacuum in Apple Home is this plugin's own as well.
    const vacuum = this.vacuums.get(duid);
    return !!(vacuum && vacuum.job);
  }

  /** A clean of this robot is being started (by a fan, a routine switch or the vacuum). */
  begun(duid) {
    const monitor = this.monitors.get(duid);
    if (monitor) monitor.starts = (monitor.starts || 0) + 1;
  }

  startsOf(duid) {
    const monitor = this.monitors.get(duid);
    return monitor ? monitor.starts || 0 : 0;
  }

  /** The clean the robot is doing now (or is about to do) is this plugin's own. */
  claim(duid) {
    const monitor = this.monitors.get(duid);
    if (monitor) monitor.job = { ours: true };
    return monitor;
  }

  /** The plugin just stopped a clean on this robot (or failed to start one). */
  quiet(duid) {
    const monitor = this.claim(duid);
    if (monitor) {
      monitor.quietFrom = Date.now();
      monitor.quietUntil = Date.now() + QUIET_AFTER_STOP_MS;
    }
  }

  /**
   * Notice a clean this plugin did not start (a routine pressed in the
   * Roborock app, a schedule, another plugin) and show it in Apple Home on
   * the routine switch or fan it belongs to. Every clean is looked at once:
   * `monitor.job` is set when the robot starts cleaning and cleared when it
   * is done.
   */
  watchExternal(monitor, status) {
    // The robot was asked for this status after the plugin stopped its clean,
    // and it is no longer cleaning: the stop has taken, so a clean that shows
    // up from now on was started elsewhere.
    if (Date.now() < monitor.quietUntil && monitor.quietFrom && monitor.polledAt > monitor.quietFrom + 2000 && !CLEANING_STATES.has(status.state)) {
      monitor.quietUntil = Date.now();
    }
    if (!status.in_cleaning) {
      monitor.job = null;
      // The robot's report led to no clean (back on the dock, or the quick checks ran out): forget when it came.
      if (RoborockRoomCleanPlatform.isCharging(status) || Date.now() > monitor.closeUntil) monitor.reportedAt = 0;
      return;
    }
    // Not every fan and switch exists yet (Homebridge is starting): look again at the next status.
    if (!this.ready) return;
    const duid = monitor.robot.duid;
    // An unfinished clean of a robot that is standing still (an error, paused,
    // charging in between) is not shown as running: look again once it moves.
    if (!monitor.job && !CLEANING_STATES.has(status.state) && !this.busy(duid)) {
      if (Date.now() > monitor.closeUntil) monitor.reportedAt = 0;
      return;
    }
    if (monitor.job) {
      // A clean of ours that was stopped a while ago, no fan or switch is on,
      // and the robot is cleaning again: that is a new clean, started elsewhere.
      const over = monitor.job.ours && !this.busy(duid) && Date.now() >= monitor.quietUntil && CLEANING_STATES.has(status.state);
      if (!over) return;
    }
    const job = { ours: this.busy(duid) || Date.now() < monitor.quietUntil };
    monitor.job = job;
    if (job.ours || this.config.followExternal === false) return;
    // Every step from here on is written to the log, so it can be followed afterwards.
    this.log.info(`${monitor.robot.name}: a clean was started outside Apple Home (in_cleaning=${status.in_cleaning}, state=${status.state}); finding out what it is.`);
    this.identifyExternal(monitor, job, status).catch((err) => {
      this.log.warn(`${monitor.robot.name}: could not work out what was started outside Apple Home: ${err.message}`);
    });
  }

  /**
   * Find the switch or fan for a clean that was started elsewhere. The robot's
   * status does not say which routine is running, but its live map marks the
   * rooms being cleaned, and every routine lists its rooms.
   */
  async identifyExternal(monitor, job, status) {
    const { robot, channel } = monitor;
    const programs = () => [...this.programs.values()].filter((p) => p.robot.duid === robot.duid);
    if (!programs().length) return;
    // Give up as soon as the clean ended or a fan/switch was used in Home meanwhile.
    const current = () => !this.stopped && monitor.job === job && !this.busy(robot.duid) && Date.now() >= monitor.quietUntil;
    const dropped = () => {
      if (!this.stopped) this.log.info(`${robot.name}: stopped looking into the clean started outside Apple Home: it ended, or a fan or switch was used in Home meanwhile.`);
    };
    let candidates = programs();
    let match = null;
    let what = "a zone";
    // A whole-home clean (1) with a whole-home routine switch needs no map at all.
    if (status.in_cleaning === 1) match = this.matchExternal(candidates, "all", null, status);
    if (match) {
      what = "the whole home";
    } else if (status.in_cleaning !== 2) {
      // A room clean (3) is asked about again and again for a few minutes (see externalWaits).
      const tries = status.in_cleaning === 1 ? 1 : this.externalWaits.length;
      let rooms = null;
      const reasons = []; // what each try came to, for the log when none worked
      // The map travels through the cloud: it is left alone while the cloud is
      // not answering, and for a while after the robot sent none.
      let asked = true;
      if (Date.now() < monitor.noMapUntil) {
        asked = false;
        reasons.push("not asked, the robot sent no map a few minutes ago");
      } else if (Date.now() < channel.cloudPausedUntil) {
        asked = false;
        reasons.push("not asked, the Roborock cloud is not answering right now");
      }
      for (let attempt = 1; asked && attempt <= tries && !rooms; attempt++) {
        if (attempt === 4) {
          this.log.info(`${robot.name}: the robot is not sending its map yet (it does not while the Roborock app is open on the map); trying again for a few minutes.`);
        }
        if (this.externalWaits[attempt - 1]) await sleep(this.externalWaits[attempt - 1]);
        if (!current()) return dropped();
        try {
          const answer = await channel.getCleaning(5000, attempt);
          if (answer.rooms.length) rooms = answer.rooms;
          else reasons.push(`the map marks no rooms (it has blocks ${answer.blocks.join(",")})`);
        } catch (err) {
          reasons.push(err.message);
        }
      }
      if (!current()) return dropped();
      candidates = programs();
      // Newer robots also name the room they are in right now in their status.
      const here = status.cleaning_info && Number(status.cleaning_info.segment_id);
      if (rooms) {
        what = `room${rooms.length > 1 ? "s" : ""} ${rooms.join(",")}`;
        match = this.matchExternal(candidates, "segments", rooms, status);
      } else if (status.in_cleaning === 1) {
        what = "the whole home";
      } else if (Number.isInteger(here) && here > 0) {
        what = `room ${here}, from the robot's status`;
        match = this.matchExternal(candidates, "segments", [here], status) || this.onlyRoutineWith(candidates, here);
      } else {
        if (asked) monitor.noMapUntil = Date.now() + NO_MAP_PAUSE_MS;
        this.log.info(
          `${robot.name}: a clean was started outside Apple Home, but the robot did not report which rooms, so no switch is shown as on. ` +
            `Tries: ${summarise(reasons)}. ` +
            `Status: in_cleaning=${status.in_cleaning}, state=${status.state}${status.cleaning_info ? `, cleaning_info=${JSON.stringify(status.cleaning_info)}` : ""}.`
        );
        return;
      }
    }
    if (!match) {
      const known = candidates
        .filter((p) => p.kind === "routine")
        .map((p) => `${p.name} [${(p.steps || []).map((step) => (step.kind === "segments" ? step.segments.join(",") : step.kind)).join(" | ")}]`);
      this.log.info(
        `${robot.name}: a clean of ${what} was started outside Apple Home; no routine switch or fan matches it.` +
          (known.length ? ` Routine switches and their rooms: ${known.join("; ")}.` : "")
      );
      return;
    }
    // How long it took, counted from the robot's own report that it started (when there was one).
    const took = monitor.reportedAt ? ` ${Math.max(1, Math.round((Date.now() - monitor.reportedAt) / 1000))}s after the robot reported it.` : "";
    monitor.reportedAt = 0;
    this.log.info(`${match.name}: started outside Apple Home (${what}), showing it as on.${took}`);
    this.adopt(match, status);
  }

  /**
   * The routine switch whose routine cleans exactly these rooms (when two do,
   * the one whose suction and water settings the robot is using now), else
   * the fan or combination for exactly these rooms.
   *
   * A routine with several groups of rooms is also listed per group (see
   * routineSteps). Such a part of a routine only beats a fan for the same
   * rooms when the robot is using that group's settings: otherwise a plain
   * kitchen clean would light up every routine that happens to include the
   * kitchen.
   */
  matchExternal(candidates, kind, rooms, status) {
    const key = (ids) => [...new Set((ids || []).map(Number))].sort((a, b) => a - b).join(",");
    const want = key(rooms);
    let best = null;
    for (const program of candidates) {
      if (program.kind !== "routine") continue;
      for (const step of program.steps || []) {
        if (step.kind !== kind) continue;
        if (kind === "segments" && key(step.segments) !== want) continue;
        const settings = (step.fanPower === status.fan_power ? 1 : 0) + (step.waterBoxMode === status.water_box_mode ? 1 : 0);
        const score = (step.partial ? 0 : 10) + settings;
        if (!best || score > best.score) best = { program, score, weak: !!step.partial && settings < 2 };
      }
    }
    if (kind !== "segments") return best ? best.program : null;
    const fan = candidates.find((p) => p.kind !== "routine" && key(p.segments) === want) || null;
    if (best && !(best.weak && fan)) return best.program;
    return fan;
  }

  /** The one routine switch whose routine includes this room, or null when none or several do. */
  onlyRoutineWith(candidates, room) {
    const found = candidates.filter((p) => p.kind === "routine" && (p.steps || []).some((step) => step.kind === "segments" && step.segments.includes(room)));
    return found.length === 1 ? found[0] : null;
  }

  /** Show a clean that is already running on its switch or fan, and follow it until it ends. */
  adopt(program, status) {
    program.adopted = true;
    program.restore = null; // the settings are not ours to put back
    program.startedAt = 0; // already cleaning: no start-up grace
    program.idlePolls = 0;
    this.showSuction(program, status);
    this.setRunning(program, true);
    this.schedulePoll(program, 20000);
  }

  /** The slider level for a suction code of the robot, or null when the slider has no place for it. */
  levelOf(fanPower) {
    const level = Object.keys(SUCTION).find((name) => SUCTION[name] === fanPower);
    if (!level) return null;
    return this.levels().includes(level) ? level : "max"; // Max+ without the Max+ step: the top of the slider
  }

  /**
   * A fan that shows a clean started elsewhere shows the suction the robot is
   * really using, not the speed remembered for cleans started from Home.
   * That remembered speed is left alone and comes back when the clean ends.
   */
  showSuction(program, status) {
    if (program.kind === "routine" || !program.adopted) return;
    // A level just picked in Home stands until the robot's status has caught up with it.
    if (Date.now() - (program.shownByUser || 0) < 30000) return;
    const level = status ? this.levelOf(status.fan_power) : null;
    if (!level || level === program.shown) return;
    program.shown = level;
    if (program.running) this.setRunning(program, true);
  }

  /** The level a fan's slider is at: the robot's own while it shows an outside clean, else the remembered one. */
  sliderLevel(program) {
    return (program.adopted && program.running && program.shown) || program.accessory.context.level;
  }

  // ---------- fan speed ----------

  /** Suction levels on the fan slider, lowest first. */
  levels() {
    const list = ["quiet", "balanced", "turbo", "max"];
    if (this.config.enableMaxPlus) list.push("max_plus");
    return list;
  }

  speedStep() {
    return 100 / this.levels().length;
  }

  speedToLevel(speed) {
    const levels = this.levels();
    const i = Math.min(levels.length - 1, Math.max(0, Math.ceil(speed / this.speedStep() - 1e-9) - 1));
    return levels[i];
  }

  levelToSpeed(level) {
    const levels = this.levels();
    const i = levels.indexOf(level);
    return Math.round(this.speedStep() * ((i < 0 ? levels.length - 1 : i) + 1));
  }

  setupAccessory(def, channel) {
    const { Service, Characteristic } = this.api.hap;
    let accessory = this.accessories.get(def.uuid);
    const nameChanged = !accessory || !accessory.context.def || accessory.context.def.name !== def.name;
    if (!accessory) {
      accessory = new this.api.platformAccessory(def.name, def.uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(def.uuid, accessory);
      this.log.info(`Added "${def.name}".`);
    }
    accessory.context.def = { name: def.name, segments: def.segments };

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(Characteristic.Model, def.robot.name || "Robot vacuum")
      .setCharacteristic(Characteristic.SerialNumber, `${def.robot.sn || def.robot.duid}-${def.segments.join("-") || "all"}`);

    // Earlier versions used a Switch; replace it with a fan.
    const oldSwitch = accessory.getService(Service.Switch);
    if (oldSwitch) accessory.removeService(oldSwitch);

    const service = accessory.getService(Service.Fanv2) || accessory.addService(Service.Fanv2, def.name);
    service.setCharacteristic(Characteristic.Name, def.name);
    // Set the display name only when it is new or changed in the config, so a
    // rename done in the Home app is kept across restarts.
    if (Characteristic.ConfiguredName && nameChanged) {
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, def.name);
    }

    // The slider position is remembered per room (stored with the accessory,
    // so it is part of the Homebridge backup). A configured level wins when
    // the config itself changed.
    const configLevel = this.levels().includes(def.suction) ? def.suction : "max";
    if (accessory.context.configLevel !== configLevel || !this.levels().includes(accessory.context.level)) {
      accessory.context.level = configLevel;
      accessory.context.configLevel = configLevel;
    }

    const battery = this.setupBattery(accessory, def, service);

    const program = { ...def, channel, accessory, service, battery, running: false, pollTimer: null, restore: null, startTimer: null };
    Object.defineProperty(program, "suction", {
      get: () => accessory.context.level,
      enumerable: true,
    });
    this.programs.set(def.uuid, program);

    const active = service.getCharacteristic(Characteristic.Active);
    active.onGet(() => (program.running ? 1 : 0));
    active.onSet((value) => {
      if (value) this.requestStart(program);
      else this.requestStop(program);
    });

    const speed = service.getCharacteristic(Characteristic.RotationSpeed);
    speed.setProps({ minValue: 0, maxValue: 100, minStep: this.speedStep() });
    speed.onGet(() => this.levelToSpeed(this.sliderLevel(program)));
    speed.onSet((value) => {
      if (value <= 0) {
        this.requestStop(program);
        return;
      }
      const level = this.speedToLevel(value);
      if (program.adopted && program.running) {
        // A clean started elsewhere: change the robot's suction, but keep the
        // speed this fan remembers for cleans started from Home.
        if (level !== program.shown) {
          program.shown = level;
          program.shownByUser = Date.now();
          this.changeSuction(program, level);
        }
        return;
      }
      const changed = level !== accessory.context.level;
      accessory.context.level = level;
      this.api.updatePlatformAccessories?.([accessory]);
      if (program.running) {
        if (changed) this.changeSuction(program, level);
      } else {
        // Dragging the slider of a fan that is off turns it on.
        this.requestStart(program);
      }
    });

    active.updateValue(0);
    speed.updateValue(this.levelToSpeed(accessory.context.level));
    this.applyFanBattery(program);
  }

  /** Home sends Active and RotationSpeed together; wait a moment so the clean starts once, at the chosen level. */
  requestStart(program) {
    if (program.running) return;
    clearTimeout(program.startTimer);
    // Open the connection to the robot while we wait for Home's second message.
    if (program.channel.local) program.channel.local.connect().catch(() => {});
    program.startTimer = setTimeout(() => {
      program.startTimer = null;
      if (!program.running) this.startProgram(program);
    }, 300);
  }

  requestStop(program) {
    clearTimeout(program.startTimer);
    program.startTimer = null;
    if (program.running) this.stopProgram(program);
  }

  async changeSuction(program, level) {
    this.log.info(`${program.name}: suction ${level}.`);
    try {
      await program.channel.send("set_custom_mode", [SUCTION[level]]);
    } catch (err) {
      this.log.error(`${program.name}: could not change suction: ${err.message}`);
    }
  }

  setRunning(program, running) {
    const { Characteristic } = this.api.hap;
    program.running = running;
    if (program.kind === "routine") {
      program.service.updateCharacteristic(Characteristic.On, running);
      return;
    }
    program.service.updateCharacteristic(Characteristic.Active, running ? 1 : 0);
    if (!running) program.shown = null;
    program.service.updateCharacteristic(Characteristic.RotationSpeed, this.levelToSpeed(this.sliderLevel(program)));
  }

  /** Only one fan or routine per robot can run at a time: switch the others off. */
  takeOver(program) {
    for (const other of this.programs.values()) {
      if (other === program || other.channel !== program.channel) continue;
      // Also from one that was just turned off and has not put its settings back yet.
      program.restore = program.restore || other.restore;
      other.restore = null;
      if (other.running) {
        clearTimeout(other.pollTimer);
        this.setRunning(other, false);
      }
    }
    // A clean started from the robot vacuum in Apple Home ends here too; what it meant to put back, this one puts back.
    const vacuum = this.vacuums.get(program.robot.duid);
    if (vacuum) program.restore = program.restore || vacuum.handOver();
  }

  async startProgram(program) {
    const { channel } = program;
    this.takeOver(program);
    this.begun(program.robot.duid);
    program.adopted = false;
    this.setRunning(program, true);
    this.claim(program.robot.duid);
    const rooms = `rooms ${program.segments.join(",")}`;
    this.log.info(`${program.name}: starting (${rooms}, suction ${program.suction}, ${program.mopMode}, x${program.repeat}).`);

    try {
      const status = await this.readStatus(program.robot.duid, channel, 5000).catch(() => null);
      if (status && !program.restore && this.config.restoreSettings !== false) {
        program.restore = { fanPower: status.fan_power, waterBoxMode: status.water_box_mode };
      }
      if (status && status.in_cleaning) {
        await channel.send("app_stop", []).catch(() => {});
        await sleep(2000);
      }

      // Only send settings that actually need to change.
      const fan = SUCTION[program.suction];
      if (fan && (!status || status.fan_power !== fan)) await channel.send("set_custom_mode", [fan]);
      if (program.mopMode === "vacuum_only" && (!status || status.water_box_mode !== WATER_OFF)) {
        await channel.send("set_water_box_custom_mode", [WATER_OFF]).catch((err) => this.log.debug(`water mode: ${err.message}`));
      }

      try {
        await channel.send("app_segment_clean", [{ segments: program.segments, repeat: program.repeat }]);
      } catch (err) {
        // Very old firmware only understands a plain list of room ids, and says so. A start
        // that got no answer is not sent again that way: the robot may well have taken it,
        // and the plain list would replace it with a single pass.
        if (!err.refused) throw err;
        this.log.info(`${program.name}: the robot does not take the number of passes (${err.message}); cleaning once.`);
        await channel.send("app_segment_clean", program.segments);
      }
      program.startedAt = Date.now();
      this.schedulePoll(program, 30000);
      this.refreshStatusSoon(program.robot.duid, 5000); // shows "off the dock" quickly
    } catch (err) {
      this.log.error(`${program.name}: could not start: ${err.message}`);
      this.setRunning(program, false);
      this.quiet(program.robot.duid);
      await this.restoreSettings(program);
    }
  }

  async stopProgram(program) {
    clearTimeout(program.pollTimer);
    this.setRunning(program, false);
    this.quiet(program.robot.duid);
    this.log.info(`${program.name}: stopping and returning to the dock.`);
    const starts = this.startsOf(program.robot.duid);
    try {
      await program.channel.send("app_stop", []);
      // Not when another clean was started meanwhile: the robot would be sent home from it.
      await this.sendToDock(program, () => this.startsOf(program.robot.duid) === starts);
    } catch (err) {
      this.log.error(`${program.name}: could not stop: ${err.message}`);
    }
    await sleep(3000);
    await this.restoreSettings(program);
    this.refreshStatusSoon(program.robot.duid, 1000);
  }

  /**
   * Send the robot back to the dock after a stop. A robot that is still busy
   * stopping refuses this for a moment ("action locked"), so it is tried a
   * few times; a robot that is already on the dock needs nothing.
   */
  async sendToDock(program, still = () => true) {
    const { channel, robot } = program;
    for (let attempt = 1; ; attempt++) {
      await sleep(attempt === 1 ? 1500 : this.dockRetryMs);
      if (!still()) return;
      try {
        await channel.send("app_charge", []);
        return;
      } catch (err) {
        if (!err.refused) throw err;
        const status = await this.readStatus(robot.duid, channel, 0).catch(() => null);
        if (status && RoborockRoomCleanPlatform.isCharging(status)) return; // already there
        if (attempt >= 3) throw err;
        this.log.debug(`${program.name}: the robot is not ready to go to the dock yet (${err.message}), trying again.`);
      }
    }
  }

  schedulePoll(program, delay) {
    clearTimeout(program.pollTimer);
    program.pollTimer = setTimeout(() => this.poll(program), delay);
    program.pollTimer.unref?.();
  }

  async poll(program) {
    if (!program.running || this.stopped) return;
    let status;
    try {
      status = await this.readStatus(program.robot.duid, program.channel);
    } catch (err) {
      this.log.debug(`${program.name}: status poll failed: ${err.message}`);
      this.schedulePoll(program, 30000);
      return;
    }
    this.log.debug(`${program.name}: ${STATE_NAMES[status.state] || status.state}, in_cleaning=${status.in_cleaning}`);
    const graceOver = Date.now() - program.startedAt > 60000;
    if (graceOver && !status.in_cleaning) {
      // A routine can have several steps with a short pause in between, so it
      // only counts as finished when the robot is idle on two checks in a row.
      if (program.kind === "routine" && ++program.idlePolls < 2) {
        this.schedulePoll(program, 20000);
        return;
      }
      this.log.info(`${program.name}: finished.`);
      this.setRunning(program, false);
      await this.restoreSettings(program);
      return;
    }
    if (status.in_cleaning) program.idlePolls = 0;
    this.showSuction(program, status); // suction changed in the Roborock app meanwhile
    this.schedulePoll(program, 20000);
  }

  async restoreSettings(program) {
    const r = program.restore;
    program.restore = null;
    if (!r) return;
    try {
      if (program.kind === "routine") {
        // Settings saved by a room fan this routine took over from.
        if (r.fanPower) await program.channel.send("set_custom_mode", [r.fanPower]);
        if (r.waterBoxMode) await program.channel.send("set_water_box_custom_mode", [r.waterBoxMode]);
        return;
      }
      if (r.fanPower && r.fanPower !== SUCTION[program.suction]) await program.channel.send("set_custom_mode", [r.fanPower]);
      if (r.waterBoxMode && program.mopMode === "vacuum_only" && r.waterBoxMode !== WATER_OFF) {
        await program.channel.send("set_water_box_custom_mode", [r.waterBoxMode]);
      }
    } catch (err) {
      this.log.debug(`${program.name}: restoring previous settings failed: ${err.message}`);
    }
  }
}

/** "3x no answer; 1x the map marks no rooms": the same outcome in a row is counted, not repeated. */
function summarise(reasons) {
  const groups = [];
  for (const reason of reasons) {
    const last = groups[groups.length - 1];
    if (last && last.reason === reason) last.count++;
    else groups.push({ reason, count: 1 });
  }
  return groups.map((g) => `${g.count}x ${g.reason}`).join("; ");
}

function clampRepeat(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(3, Math.max(1, v)) : 2;
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RoborockRoomCleanPlatform);
};
module.exports.RoborockRoomCleanPlatform = RoborockRoomCleanPlatform;
