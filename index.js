"use strict";

const fs = require("fs");
const path = require("path");
const cloud = require("./lib/cloud");
const { RoborockSession } = require("./lib/robot");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RoborockRoomCleanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map(); // uuid -> PlatformAccessory (from cache)
    this.programs = new Map(); // uuid -> runtime program
    this.docks = new Map(); // duid -> charging sensor
    this.storageDir = path.join(api.user.storagePath(), STORAGE_DIR);
    this.session = null;
    this.stopped = false;

    api.on("didFinishLaunching", () => {
      this.start().catch((err) => this.log.error(`Startup failed: ${err.message}`));
    });
    api.on("shutdown", () => {
      this.stopped = true;
      for (const p of this.programs.values()) clearTimeout(p.pollTimer);
      for (const d of this.docks.values()) clearTimeout(d.timer);
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
    this.session = new RoborockSession(auth.userData, this.log);
    this.session.start();

    const wanted = new Set();
    for (const robot of robots) {
      const netFile = `net-${robot.duid}.json`;
      const savedIp = (this.config.robotIps || {})[robot.name] || this.config.robotIp || (this.readJson(netFile) || {}).ip;
      const channel = this.session.channel(robot.duid, robot.localKey, robot.name, savedIp);
      const segments = await this.loadRooms(channel, roomNames);
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
      if (this.config.chargingSensor !== false) {
        wanted.add(this.setupChargingSensor(robot, channel, robots.length > 1));
      }
      for (const def of this.buildPrograms(robot, segments, robots.length > 1)) {
        wanted.add(def.uuid);
        this.setupAccessory(def, channel);
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

  /** Room list for one robot: [{ segmentId, name }]. Falls back to the cache while the robot is offline. */
  async loadRooms(channel, roomNames) {
    const cacheFile = `rooms-${channel.duid}.json`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const mapping = await channel.getRoomMapping();
        const rooms = mapping.map((m) => ({
          segmentId: m.segmentId,
          name: roomNames.get(m.roomId) || `Room ${m.segmentId}`,
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

  buildPrograms(robot, segments, multiRobot) {
    const c = this.config;
    const defaults = {
      suction: c.suction || "max",
      mopMode: c.mopMode || "vacuum_only",
      repeat: clampRepeat(c.repeat ?? 2),
    };
    // The room name is always part of the fan name: if the template has no
    // {room} placeholder (easy to lose when typing right-to-left), append it.
    let template = String(c.nameTemplate || "Clean {room}").trim();
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

  // ---------- accessories ----------

  // ---------- charging sensor ----------

  /**
   * One contact sensor per robot: closed = on the dock charging (or full),
   * open = off the dock. The same accessory carries the battery level.
   */
  setupChargingSensor(robot, channel, multiRobot) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${robot.duid}:charging`);
    const base = this.config.chargingSensorName || `${robot.name} Charging`;
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
    const battery = accessory.getService(Service.Battery) || accessory.addService(Service.Battery, `${name} Battery`);

    const dock = { robot, channel, accessory, contact, battery, timer: null, last: accessory.context.last || null };
    this.docks.set(robot.duid, dock);

    contact.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.contactValue(dock.last));
    battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => (dock.last ? dock.last.battery : 100));
    battery.getCharacteristic(Characteristic.ChargingState).onGet(() => this.chargingValue(dock.last));
    battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.lowBatteryValue(dock.last));
    if (dock.last) this.applyDock(dock);

    const intervalMs = Math.max(30, Number(this.config.statusInterval) || 60) * 1000;
    const tick = async () => {
      if (this.stopped) return;
      try {
        const status = await channel.getStatus();
        this.updateChargingSensor(robot.duid, status);
      } catch (err) {
        this.log.debug(`${robot.name}: status update failed: ${err.message}`);
      }
      dock.timer = setTimeout(tick, intervalMs);
      dock.timer.unref?.();
    };
    dock.timer = setTimeout(tick, 2000);
    dock.timer.unref?.();
    return uuid;
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

    const program = { ...def, channel, accessory, service, running: false, pollTimer: null, restore: null, startTimer: null };
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
    speed.onGet(() => this.levelToSpeed(accessory.context.level));
    speed.onSet((value) => {
      if (value <= 0) {
        this.requestStop(program);
        return;
      }
      const level = this.speedToLevel(value);
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
    program.service.updateCharacteristic(Characteristic.Active, running ? 1 : 0);
    program.service.updateCharacteristic(Characteristic.RotationSpeed, this.levelToSpeed(program.accessory.context.level));
  }

  async startProgram(program) {
    const { channel } = program;
    // Only one program per robot can run at a time.
    for (const other of this.programs.values()) {
      if (other !== program && other.channel === channel && other.running) {
        clearTimeout(other.pollTimer);
        this.setRunning(other, false);
        program.restore = program.restore || other.restore;
        other.restore = null;
      }
    }
    this.setRunning(program, true);
    const rooms = `rooms ${program.segments.join(",")}`;
    this.log.info(`${program.name}: starting (${rooms}, suction ${program.suction}, ${program.mopMode}, x${program.repeat}).`);

    try {
      const status = await channel.getStatus().catch(() => null);
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
        // Very old firmware only understands a plain list of room ids.
        this.log.debug(`app_segment_clean with repeat failed (${err.message}), retrying legacy form.`);
        await channel.send("app_segment_clean", program.segments);
      }
      program.startedAt = Date.now();
      this.schedulePoll(program, 30000);
    } catch (err) {
      this.log.error(`${program.name}: could not start: ${err.message}`);
      this.setRunning(program, false);
      await this.restoreSettings(program);
    }
  }

  async stopProgram(program) {
    clearTimeout(program.pollTimer);
    this.setRunning(program, false);
    this.log.info(`${program.name}: stopping and returning to the dock.`);
    try {
      await program.channel.send("app_stop", []);
      await sleep(1500);
      await program.channel.send("app_charge", []);
    } catch (err) {
      this.log.error(`${program.name}: could not stop: ${err.message}`);
    }
    await sleep(3000);
    await this.restoreSettings(program);
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
      status = await program.channel.getStatus();
    } catch (err) {
      this.log.debug(`${program.name}: status poll failed: ${err.message}`);
      this.schedulePoll(program, 30000);
      return;
    }
    this.log.debug(`${program.name}: ${STATE_NAMES[status.state] || status.state}, in_cleaning=${status.in_cleaning}`);
    this.updateChargingSensor(program.robot.duid, status);
    const graceOver = Date.now() - program.startedAt > 60000;
    if (graceOver && !status.in_cleaning) {
      this.log.info(`${program.name}: finished.`);
      this.setRunning(program, false);
      await this.restoreSettings(program);
      return;
    }
    this.schedulePoll(program, 20000);
  }

  async restoreSettings(program) {
    const r = program.restore;
    program.restore = null;
    if (!r) return;
    try {
      if (r.fanPower && r.fanPower !== SUCTION[program.suction]) await program.channel.send("set_custom_mode", [r.fanPower]);
      if (r.waterBoxMode && program.mopMode === "vacuum_only" && r.waterBoxMode !== WATER_OFF) {
        await program.channel.send("set_water_box_custom_mode", [r.waterBoxMode]);
      }
    } catch (err) {
      this.log.debug(`${program.name}: restoring previous settings failed: ${err.message}`);
    }
  }
}

function clampRepeat(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(3, Math.max(1, v)) : 2;
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RoborockRoomCleanPlatform);
};
module.exports.RoborockRoomCleanPlatform = RoborockRoomCleanPlatform;
