"use strict";

/**
 * Extras for each robot, each turned on by its own setting:
 * - maintenance: the wear of the main brush, side brush, filter and sensors, shown on the
 *   spot clean fan (filter life, reset after a replacement) and as a contact sensor that
 *   opens when one of them is due;
 * - error sensor: a contact sensor that opens while the robot is stuck or in error;
 * - Do Not Disturb: a switch for the robot's quiet hours;
 * - volume: the robot's voice volume as a light's brightness;
 * - spot clean: a fan that cleans around the robot, its slider the suction.
 */

// Lifetimes in seconds, as in the Roborock app.
const CONSUMABLES = [
  { key: "main_brush_work_time", life: 300 * 3600, en: "Main brush", he: "מברשת ראשית" },
  { key: "side_brush_work_time", life: 200 * 3600, en: "Side brush", he: "מברשת צד" },
  { key: "filter_work_time", life: 150 * 3600, en: "Filter", he: "פילטר" },
  { key: "sensor_dirty_time", life: 30 * 3600, en: "Sensors", he: "חיישנים" },
];

// What the robot's error codes mean (for the log).
const ERRORS = {
  1: "LiDAR sensor blocked", 2: "bumper stuck", 3: "wheels lifted", 4: "cliff sensor error", 5: "main brush jammed",
  6: "side brush jammed", 7: "wheels jammed", 8: "robot trapped", 9: "dustbin missing", 10: "filter wet or blocked",
  11: "magnetic strip detected", 12: "battery low", 13: "charging problem", 14: "battery error", 15: "wall sensor dirty",
  16: "robot tilted", 17: "side brush error", 18: "fan error", 21: "vertical bumper pressed", 22: "dock locator error",
  23: "could not return to the dock", 24: "no-go zone or invisible wall detected", 26: "wall sensor error",
  27: "lifting mechanism jammed", 28: "robot on carpet", 29: "filter blocked", 30: "invisible wall detected",
  31: "cannot cross the carpet", 32: "internal error", 34: "clean water tank empty", 35: "dirty water tank full",
  36: "dirty water tank missing", 38: "clean water tank missing", 39: "mop pad missing",
};

const TEXT = {
  en: {
    maintenance: (r) => `${r} Maintenance`,
    error: (r) => `${r} Error`,
    dnd: (r) => `${r} Do Not Disturb`,
    volume: (r) => `${r} Volume`,
    spot: (r) => `${r} Spot Clean`,
  },
  he: {
    maintenance: (r) => `תחזוקת ${r}`,
    error: (r) => `תקלה ב-${r}`,
    dnd: (r) => `נא לא להפריע ${r}`,
    volume: (r) => `עוצמת ${r}`,
    spot: (r) => `ניקוי נקודתי ${r}`,
  },
};

const ERROR_STATES = new Set([9, 12]);
const CONSUMABLES_EVERY_MS = 60 * 60 * 1000;
const SETTINGS_EVERY_MS = 10 * 60 * 1000;

class RobotExtras {
  /**
   * platform: the plugin (api, log, config, accessory helpers)
   * robot, channel: the robot and its connection
   */
  constructor(platform, robot, channel, multiRobot) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.config = platform.config;
    this.robot = robot;
    this.channel = channel;
    this.multiRobot = multiRobot;
    this.lang = this.config.language === "he" ? "he" : "en";
    this.text = TEXT[this.lang];
    this.timers = [];
    this.stopped = false;
    this.wear = null; // { key: seconds worked }
    this.errorShown = null;
    this.spot = null;
    this.maintenance = null;
    this.errorSensor = null;
    this.dnd = null;
    this.volume = null;
  }

  /** Make the accessories asked for. Returns the uuids made. */
  setup() {
    const made = [];
    const c = this.config;
    if (c.spotClean === true) made.push(this.setupSpot());
    if (c.maintenance === true) made.push(this.setupMaintenance());
    if (c.errorSensor === true) made.push(this.setupError());
    if (c.dndSwitch === true) made.push(this.setupDnd());
    if (c.volumeSlider === true) made.push(this.setupVolume());
    if (this.maintenance) this.every(CONSUMABLES_EVERY_MS, () => this.readConsumables(), 3000);
    if (this.dnd || this.volume) this.every(SETTINGS_EVERY_MS, () => this.readSettings(), 4000);
    return made;
  }

  every(ms, fn, first) {
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.log.debug(`${this.robot.name}: ${err.message}`);
      }
      if (this.stopped) return;
      const t = setTimeout(run, ms);
      t.unref?.();
      this.timers.push(t);
    };
    const t = setTimeout(run, first);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  /** The name: the one typed in the settings, or the plugin's own in the chosen language. */
  nameOf(kind) {
    const own = String(this.config[`${kind}Name`] || "").trim();
    const base = own || this.text[kind](this.robot.name);
    return this.multiRobot && own ? `${base} (${this.robot.name})` : base;
  }

  accessory(kind, name) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`${this.platform.pluginName}:${this.robot.duid}:${kind}`);
    let accessory = this.platform.accessories.get(uuid);
    const nameChanged = !accessory || accessory.context.name !== name;
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(this.platform.pluginName, this.platform.platformName, [accessory]);
      this.platform.accessories.set(uuid, accessory);
      this.log.info(`Added "${name}".`);
    }
    accessory.context.name = name;
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(Characteristic.Model, this.robot.name || "Robot vacuum")
      .setCharacteristic(Characteristic.SerialNumber, `${this.robot.sn || this.robot.duid}-${kind}`);
    return { uuid, accessory, nameChanged };
  }

  service(accessory, type, name, subtype, nameChanged) {
    const { Characteristic } = this.api.hap;
    const service = (subtype ? accessory.getServiceById(type, subtype) : accessory.getService(type)) || accessory.addService(type, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName && nameChanged) {
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
    }
    return service;
  }

  // ---------- spot clean (a fan: on cleans around the robot, the slider is the suction)

  setupSpot() {
    const { Service, Characteristic } = this.api.hap;
    const name = this.nameOf("spot");
    const { uuid, accessory, nameChanged } = this.accessory("spot", name);
    const fan = this.service(accessory, Service.Fanv2, name, undefined, nameChanged);
    const p = this.platform;
    const levels = p.levels();
    if (!levels.includes(accessory.context.level)) accessory.context.level = p.config.suction && levels.includes(p.config.suction) ? p.config.suction : "max";
    const spot = { accessory, fan, running: false, startedAt: 0 };
    this.spot = spot;
    const active = fan.getCharacteristic(Characteristic.Active);
    const speed = fan.getCharacteristic(Characteristic.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: p.speedStep() });
    active.onGet(() => (spot.running ? 1 : 0));
    speed.onGet(() => p.levelToSpeed(accessory.context.level));
    speed.onSet(async (value) => {
      const v = Number(value);
      if (v <= 0) return; // Home sends 0 together with "off"
      const level = p.speedToLevel(v);
      if (level === accessory.context.level) return;
      accessory.context.level = level;
      this.log.info(`${name}: suction ${level}.`);
      if (spot.running) {
        try {
          await this.channel.send("set_custom_mode", [p.suctionCodes[level]]);
        } catch (err) {
          this.log.warn(`${name}: could not change the suction (${err.message}).`);
        }
      }
    });
    active.onSet(async (value) => {
      const on = Number(value) === 1;
      if (on === spot.running) return;
      if (on) {
        spot.running = true;
        spot.startedAt = Date.now();
        try {
          await this.channel.send("set_custom_mode", [p.suctionCodes[accessory.context.level]]);
          await this.channel.send("app_spot", []);
          this.log.info(`${name}: started (suction ${accessory.context.level}).`);
        } catch (err) {
          spot.running = false;
          this.log.warn(`${name}: could not start (${err.message}).`);
          setTimeout(() => active.updateValue(0), 300);
          return;
        }
      } else {
        spot.running = false;
        spot.startedAt = 0;
        try {
          await this.channel.send("app_stop", []);
          await this.channel.send("app_charge", []);
          this.log.info(`${name}: stopped, the robot goes back to the dock.`);
        } catch (err) {
          this.log.warn(`${name}: could not stop (${err.message}).`);
        }
      }
      p.refreshStatusSoon(this.robot.duid, 3000);
    });
    active.updateValue(0);
    speed.updateValue(p.levelToSpeed(accessory.context.level));
    return uuid;
  }

  // ---------- maintenance

  setupMaintenance() {
    const { Service, Characteristic } = this.api.hap;
    const name = this.nameOf("maintenance");
    const { uuid, accessory, nameChanged } = this.accessory("maintenance", name);
    const contact = this.service(accessory, Service.ContactSensor, name, undefined, nameChanged);
    const parts = [];
    // The wear of each part, with "reset" after a replacement. Home shows these on a fan, so they
    // live on the spot clean fan when there is one, else on this accessory.
    const host = this.spot ? this.spot.accessory : accessory;
    for (const part of CONSUMABLES) {
      const label = part[this.lang];
      const svc = this.service(host, Service.FilterMaintenance, label, part.key, true);
      svc.getCharacteristic(Characteristic.FilterLifeLevel).onGet(() => this.lifeOf(part));
      svc.getCharacteristic(Characteristic.FilterChangeIndication).onGet(() => (this.lifeOf(part) <= 0 ? 1 : 0));
      if (!svc.testCharacteristic(Characteristic.ResetFilterIndication)) svc.addOptionalCharacteristic(Characteristic.ResetFilterIndication);
      svc.getCharacteristic(Characteristic.ResetFilterIndication).onSet(() => this.resetConsumable(part));
      if (this.spot && host === this.spot.accessory) this.spot.fan.addLinkedService(svc);
      parts.push({ part, svc });
    }
    // Earlier copies of these on the other accessory are removed.
    const other = host === accessory ? this.spot && this.spot.accessory : accessory;
    if (other) for (const part of CONSUMABLES) {
      const old = other.getServiceById(Service.FilterMaintenance, part.key);
      if (old) other.removeService(old);
    }
    this.maintenance = { accessory, contact, parts, name, due: accessory.context.due || [] };
    contact.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.maintenanceValue());
    contact.updateCharacteristic(Characteristic.ContactSensorState, this.maintenanceValue());
    return uuid;
  }

  lifeOf(part) {
    const worked = this.wear ? Number(this.wear[part.key]) : NaN;
    if (!Number.isFinite(worked)) return 100;
    return Math.max(0, Math.min(100, Math.round(100 - (worked / part.life) * 100)));
  }

  maintenanceValue() {
    const C = this.api.hap.Characteristic.ContactSensorState;
    return this.maintenance && this.maintenance.due.length ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  async readConsumables() {
    const answer = await this.channel.send("get_consumable", [], { background: true });
    const item = Array.isArray(answer) ? answer[0] : answer;
    if (!item || typeof item !== "object") return;
    this.wear = item;
    this.showConsumables();
  }

  showConsumables() {
    const m = this.maintenance;
    if (!m) return;
    const { Characteristic } = this.api.hap;
    const due = [];
    for (const { part, svc } of m.parts) {
      const life = this.lifeOf(part);
      svc.updateCharacteristic(Characteristic.FilterLifeLevel, life);
      svc.updateCharacteristic(Characteristic.FilterChangeIndication, life <= 0 ? 1 : 0);
      if (life <= 0) due.push(part[this.lang]);
    }
    const before = m.due.join(",");
    m.due = due;
    m.accessory.context.due = due;
    if (before !== due.join(",")) {
      this.log.info(due.length ? `${m.name}: due for replacement or cleaning: ${due.join(", ")}.` : `${m.name}: nothing is due.`);
    }
    m.contact.updateCharacteristic(Characteristic.ContactSensorState, this.maintenanceValue());
    this.log.debug(`${m.name}: ${m.parts.map(({ part }) => `${part.en} ${this.lifeOf(part)}%`).join(", ")}`);
  }

  async resetConsumable(part) {
    const label = part[this.lang];
    try {
      await this.channel.send("reset_consumable", [part.key]);
      if (this.wear) this.wear = { ...this.wear, [part.key]: 0 };
      this.log.info(`${this.maintenance.name}: ${label} reset (replaced or cleaned).`);
    } catch (err) {
      this.log.warn(`${this.maintenance.name}: could not reset ${label} (${err.message}).`);
    }
    this.showConsumables();
    setTimeout(() => this.readConsumables().catch(() => {}), 3000).unref?.();
  }

  // ---------- error sensor

  setupError() {
    const { Service, Characteristic } = this.api.hap;
    const name = this.nameOf("error");
    const { uuid, accessory, nameChanged } = this.accessory("error", name);
    const contact = this.service(accessory, Service.ContactSensor, name, undefined, nameChanged);
    this.errorSensor = { accessory, contact, name, code: accessory.context.code || 0 };
    contact.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.errorValue());
    contact.updateCharacteristic(Characteristic.ContactSensorState, this.errorValue());
    return uuid;
  }

  errorValue() {
    const C = this.api.hap.Characteristic.ContactSensorState;
    return this.errorSensor && this.errorSensor.code ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  // ---------- Do Not Disturb

  setupDnd() {
    const { Service, Characteristic } = this.api.hap;
    const name = this.nameOf("dnd");
    const { uuid, accessory, nameChanged } = this.accessory("dnd", name);
    const sw = this.service(accessory, Service.Switch, name, undefined, nameChanged);
    if (!accessory.context.hours) accessory.context.hours = [22, 0, 8, 0];
    this.dnd = { accessory, sw, name, on: accessory.context.on === true };
    const on = sw.getCharacteristic(Characteristic.On);
    on.onGet(() => this.dnd.on);
    on.onSet(async (value) => {
      const want = !!value;
      try {
        if (want) await this.channel.send("set_dnd_timer", accessory.context.hours);
        else await this.channel.send("close_dnd_timer", []);
        this.dnd.on = want;
        accessory.context.on = want;
        const [sh, sm, eh, em] = accessory.context.hours;
        const pad = (n) => String(n).padStart(2, "0");
        this.log.info(`${name}: ${want ? `on (${pad(sh)}:${pad(sm)}-${pad(eh)}:${pad(em)})` : "off"}.`);
      } catch (err) {
        this.log.warn(`${name}: could not turn ${want ? "on" : "off"} (${err.message}).`);
        setTimeout(() => on.updateValue(this.dnd.on), 300);
      }
    });
    on.updateValue(this.dnd.on);
    return uuid;
  }

  // ---------- volume

  setupVolume() {
    const { Service, Characteristic } = this.api.hap;
    const name = this.nameOf("volume");
    const { uuid, accessory, nameChanged } = this.accessory("volume", name);
    const light = this.service(accessory, Service.Lightbulb, name, undefined, nameChanged);
    const level = Number.isInteger(accessory.context.volume) ? accessory.context.volume : 50;
    this.volume = { accessory, light, name, level, last: Number.isInteger(accessory.context.last) && accessory.context.last > 0 ? accessory.context.last : 50 };
    const v = this.volume;
    const on = light.getCharacteristic(Characteristic.On);
    const brightness = light.getCharacteristic(Characteristic.Brightness);
    on.onGet(() => v.level > 0);
    brightness.onGet(() => Math.max(v.level, 1));
    const setVolume = async (level) => {
      level = Math.max(0, Math.min(100, Math.round(level)));
      if (level === v.level) return;
      try {
        await this.channel.send("change_sound_volume", [level]);
        this.showVolume(level);
        this.log.info(`${name}: ${level}%.`);
      } catch (err) {
        this.log.warn(`${name}: could not change the volume (${err.message}).`);
        setTimeout(() => this.showVolume(v.level), 300);
      }
    };
    on.onSet(async (value) => {
      if (!value) return setVolume(0); // off: silent
      if (v.level === 0) return setVolume(v.last); // on again: the volume before
    });
    brightness.onSet((value) => setVolume(Number(value)));
    this.showVolume(v.level);
    return uuid;
  }

  showVolume(level) {
    const v = this.volume;
    if (!v) return;
    const { Characteristic } = this.api.hap;
    v.level = level;
    if (level > 0) v.last = level;
    v.accessory.context.volume = level;
    v.accessory.context.last = v.last;
    v.light.updateCharacteristic(Characteristic.On, level > 0);
    if (level > 0) v.light.updateCharacteristic(Characteristic.Brightness, level);
  }

  // ---------- settings read from the robot (a change in the Roborock app shows up within 10 minutes)

  async readSettings() {
    if (this.dnd) {
      try {
        const answer = await this.channel.send("get_dnd_timer", [], { background: true });
        const t = Array.isArray(answer) ? answer[0] : answer;
        if (t && typeof t === "object") {
          const hours = [t.start_hour, t.start_minute, t.end_hour, t.end_minute].map(Number);
          if (hours.every(Number.isInteger)) this.dnd.accessory.context.hours = hours;
          if (t.enabled !== undefined) {
            this.dnd.on = Number(t.enabled) === 1;
            this.dnd.accessory.context.on = this.dnd.on;
            this.dnd.sw.updateCharacteristic(this.api.hap.Characteristic.On, this.dnd.on);
          }
        }
      } catch (err) {
        this.log.debug(`${this.dnd.name}: not read (${err.message}).`);
      }
    }
    if (this.volume) {
      try {
        const answer = await this.channel.send("get_sound_volume", [], { background: true });
        const level = Number(Array.isArray(answer) ? answer[0] : answer);
        if (Number.isFinite(level)) this.showVolume(Math.max(0, Math.min(100, Math.round(level))));
      } catch (err) {
        this.log.debug(`${this.volume.name}: not read (${err.message}).`);
      }
    }
  }

  // ---------- the robot's status changed

  statusChanged(status) {
    if (!status || typeof status.state !== "number") return;
    const { Characteristic } = this.api.hap;
    if (this.spot) {
      const running = status.state === 11;
      if (running) this.spot.startedAt = 0; // the start is seen: from now on the robot's word counts
      // Right after "start", the robot may not show it yet.
      const settling = this.spot.running && Date.now() - this.spot.startedAt < 20000;
      if (running !== this.spot.running && !(settling && !running)) {
        this.spot.running = running;
        this.spot.fan.updateCharacteristic(Characteristic.Active, running ? 1 : 0);
        this.log.info(`${this.spot.accessory.context.name}: ${running ? "cleaning" : "done"}.`);
      }
    }
    if (this.errorSensor) {
      const code = Number(status.error_code);
      let now = this.errorSensor.code;
      if (ERROR_STATES.has(status.state)) now = Number.isFinite(code) && code > 0 ? code : now || -1;
      else if (Number.isFinite(code)) now = code > 0 && status.state !== 8 && status.state !== 100 ? code : 0;
      else now = 0;
      if (now !== this.errorSensor.code) {
        this.errorSensor.code = now;
        this.errorSensor.accessory.context.code = now;
        this.errorSensor.contact.updateCharacteristic(Characteristic.ContactSensorState, this.errorValue());
        const what = now > 0 ? ERRORS[now] || `error ${now}` : "error";
        this.log.info(now ? `${this.errorSensor.name}: open: ${what} (state ${status.state}).` : `${this.errorSensor.name}: closed.`);
      }
    }
    // A clean that just ended wore the parts: read them again.
    if (this.maintenance && (status.state === 8 || status.state === 100) && this.lastState !== undefined && this.lastState !== status.state && ![8, 100].includes(this.lastState)) {
      setTimeout(() => this.readConsumables().catch(() => {}), 5000).unref?.();
    }
    this.lastState = status.state;
  }
}

module.exports = { RobotExtras, CONSUMABLES, ERRORS };
