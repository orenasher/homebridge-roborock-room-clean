"use strict";

// Shared by the tests: a fake Roborock MQTT broker with a robot behind it, and a fake Homebridge.
const net = require("net");
const zlib = require("zlib");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const P = require("../lib/protocol");

const LOCAL_KEY = "abcdefghijklmnop";
const DUID = "DUID123";
const RRIOT = { u: "user1", s: "sss", h: "hhh", k: "kkk", r: { a: "https://api.example", m: "tcp://127.0.0.1:0" } };

/** A robot map (unzipped) that marks the given rooms as being cleaned. */
function fakeMap(cleaning) {
  const block = (type, header, data) => {
    const b = Buffer.alloc(8 + header.length);
    b.writeUInt16LE(type, 0);
    b.writeUInt16LE(8 + header.length, 2);
    b.writeUInt32LE(data.length, 4);
    header.copy(b, 8);
    return Buffer.concat([b, data]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(cleaning.length, 0);
  const blocks = Buffer.concat([
    block(8, Buffer.alloc(0), Buffer.alloc(12)), // robot position: skipped over
    block(11, count, Buffer.from(cleaning)),
  ]);
  const head = Buffer.alloc(20);
  head.write("rr", 0, "ascii");
  head.writeUInt16LE(20, 2);
  head.writeUInt32LE(blocks.length, 4);
  return Buffer.concat([head, blocks, Buffer.alloc(20)]); // + SHA1 tail
}

/** The body of a protocol-301 map answer for request `id`, encrypted with the request's nonce. */
function mapAnswer(id, nonceHex, map, endpoint = "ENDPOINT") {
  const head = Buffer.alloc(24);
  head.write(endpoint, 0, "latin1");
  head.writeUInt16LE(id, 16);
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(nonceHex, "hex"), Buffer.alloc(16));
  return Buffer.concat([head, cipher.update(zlib.gzipSync(map)), cipher.final()]);
}

/** Minimal MQTT broker speaking just what our client uses, with a robot attached. */
function startFakeBroker(robotLog, robot = {}) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (type, body) => sock.write(Buffer.concat([Buffer.from([type, body.length]), body]));
    // Lets a test play another app on the account: a message every connected client receives.
    robot.deliver = (topic, frame) => {
      const t = Buffer.alloc(2); t.writeUInt16BE(Buffer.byteLength(topic));
      const pub = Buffer.concat([t, Buffer.from(topic), frame]);
      const lenBytes = [];
      let L = pub.length;
      do { let x = L % 128; L = Math.floor(L / 128); if (L) x |= 0x80; lenBytes.push(x); } while (L);
      sock.write(Buffer.concat([Buffer.from([0x30, ...lenBytes]), pub]));
    };
    robot.subscribed = robot.subscribed || [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = 0, mult = 1, i = 1, b;
        do { b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
        if (buf.length < i + len) return;
        const h = buf[0], body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        const type = h >> 4;
        if (type === 1) send(0x20, Buffer.from([0, 0]));
        else if (type === 8) {
          const wanted = body.toString("utf8", 4, 4 + body.readUInt16BE(2));
          const refused = robot.refuseListen && wanted.startsWith("rr/m/i/");
          if (!refused) robot.subscribed.push(wanted);
          send(0x90, Buffer.concat([body.subarray(0, 2), Buffer.from([refused ? 0x80 : 1])]));
        }
        else if (type === 12) send(0xd0, Buffer.alloc(0));
        else if (type === 3) {
          const qos = (h >> 1) & 3;
          const tl = body.readUInt16BE(0);
          const topic = body.toString("utf8", 2, 2 + tl);
          const frame = body.subarray(2 + tl + (qos ? 2 : 0));
          // A real broker also hands a request to everyone listening on that topic: the sender included.
          if (robot.subscribed.some((t) => t.startsWith("rr/m/i/"))) robot.deliver(topic, Buffer.from(frame));
          const msg = P.decodeMessage(frame, LOCAL_KEY);
          const req = JSON.parse(JSON.parse(msg.payload.toString()).dps["101"]);
          robotLog.push(req);
          let result = ["ok"];
          const wantsMap = req.method === "get_map_v1";
          // "retry": the robot is still preparing the map.
          const notReady = wantsMap && robot.retries > 0 && robot.retries--;
          if (notReady) result = ["retry"];
          if (req.method === "get_room_mapping") result = robot.rooms || [[16, "111", 14], [17, "222", 14]];
          if (req.method === "get_status") result = [robot.status || { state: 8, in_cleaning: 0, fan_power: 101, water_box_mode: 202, battery: 87 }];
          const ts = Math.floor(Date.now() / 1000);
          const outTopic = topic.replace("rr/m/i/", "rr/m/o/");
          // "action locked": the robot refuses a command it cannot do right now.
          let error = null;
          if (robot.refuse && robot.refuse[req.method] > 0) {
            robot.refuse[req.method]--;
            error = { code: -10007, message: "action locked" };
          }
          const publish = (protocol, payload) => {
            const resp = P.encodeMessage({ localKey: LOCAL_KEY, protocol, payload, ts });
            const t = Buffer.alloc(2); t.writeUInt16BE(outTopic.length);
            const pub = Buffer.concat([t, Buffer.from(outTopic), resp]);
            const lenBytes = [];
            let L = pub.length;
            do { let x = L % 128; L = Math.floor(L / 128); if (L) x |= 0x80; lenBytes.push(x); } while (L);
            sock.write(Buffer.concat([Buffer.from([0x30, ...lenBytes]), pub]));
          };
          // `robot.slow`: { method: ms } - the robot takes its time to answer that command.
          const answer = () => {
            publish(102, Buffer.from(JSON.stringify({ dps: { 102: JSON.stringify(error ? { id: req.id, error } : { id: req.id, result }) }, t: ts })));
            // The map itself follows the "ok" as a separate message. First one that
            // belongs to another app on the same account (it must be ignored).
            if (wantsMap && !notReady && (robot.cleaning || robot.map) && (!robot.answersMap || robot.answersMap(req))) {
              publish(301, mapAnswer(req.id, crypto.randomBytes(16).toString("hex"), fakeMap([99]), "SOMEONE="));
              // `robot.map`: a whole map (with a floor plan) instead of the bare one.
              publish(301, mapAnswer(req.id, req.security.nonce, robot.map || fakeMap(robot.cleaning), req.security.endpoint));
            }
          };
          const delay = robot.slow && robot.slow[req.method];
          if (delay) setTimeout(answer, delay);
          else answer();
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function fakeHomebridge(storage) {
  class Characteristic extends EventEmitter {
    constructor(name) { super(); this.name = name; this.value = null; }
    onGet(fn) { this.getFn = fn; return this; }
    onSet(fn) { this.setFn = fn; return this; }
    updateValue(v) { this.value = v; return this; }
    setProps(p) { this.props = p; return this; }
  }
  const C = {
    ContactSensorState: { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
    BatteryLevel: "BatteryLevel",
    ChargingState: { NOT_CHARGING: 0, CHARGING: 1 },
    StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
    Active: "Active", RotationSpeed: "RotationSpeed", On: "On", Name: "Name", ConfiguredName: "ConfiguredName", Manufacturer: "M", Model: "Mo", SerialNumber: "S", FirmwareRevision: "F" };
  class Service {
    constructor(name) { this.displayName = name; this.chars = new Map(); }
    getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic(c)); return this.chars.get(c); }
    setCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
    updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
    testCharacteristic(c) { return this.chars.has(c); }
    addOptionalCharacteristic() {}
  }
  const S = { Switch: "Switch", Fanv2: "Fanv2", ContactSensor: "ContactSensor", Battery: "Battery", AccessoryInformation: "Info" };
  class PlatformAccessory {
    constructor(name, uuid, category) { this.displayName = name; this.UUID = uuid; this.category = category; this.context = {}; this.services = new Map([["Info", new Service("Info")]]); }
    configureController(controller) { this.controller = controller; }
    getService(t) { return this.services.get(t); }
    addService(t, name) { const s = new Service(name); s.type = t; this.services.set(t, s); return s; }
    removeService(svc) { for (const [k, v] of this.services) if (v === svc) this.services.delete(k); }
  }
  const api = new EventEmitter();
  // What a camera needs from Homebridge.
  class CameraController {
    constructor(options) { this.options = options; this.forced = []; }
    static generateSynchronisationSource() { return 0x1234567; }
    forceStopStreamingSession(id) { this.forced.push(id); }
  }
  api.hap = {
    Service: S, Characteristic: C, uuid: { generate: (s) => require("crypto").createHash("md5").update(s).digest("hex") },
    Categories: { CAMERA: 17 }, CameraController, SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
    H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 }, H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
  };
  api.external = [];
  api.publishExternalAccessories = (_p, list) => api.external.push(...list);
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storage };
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, list) => api.registered.push(...list);
  api.unregisterPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.registerPlatform = (_p, _n, cls) => (api.Platform = cls);
  return api;
}

/**
 * Homebridge's Matter side, as far as a plugin sees it (modelled on Homebridge 2.4.0:
 * MatterAPIImpl, the vacuum and service-area behaviours, StateManager, the publisher of
 * stand-alone accessories). Everything a plugin hands over is checked against what the
 * Matter clusters of a robot vacuum allow.
 *
 * It behaves like the real one where that hurts:
 * - a robot vacuum that cannot be brought up is only written about in Homebridge's own log
 *   (`matter.lines`): registering still succeeds;
 * - state is taken a moment after `updateAccessoryState` returned, and when it is not
 *   acceptable it is dropped with a log line, nobody is told;
 * - writing the operational state clears the operational error;
 * - what was held before a restart (`matter.kept`, per cluster) wins over what the vacuum
 *   is registered with.
 * `matter.command(uuid, cluster, name, args)` is Apple Home sending a command.
 * `matter.drop = (cluster, attributes) => true` loses a state update without a word.
 */
function addFakeMatter(api) {
  const assert = require("node:assert");
  const check = (c) => {
    const run = c.rvcRunMode;
    const tagsOf = (m) => m.modeTags.map((t) => t.value);
    assert.equal(run.supportedModes.filter((m) => tagsOf(m).includes(16384)).length, 1, "one idle run mode");
    assert.ok(run.supportedModes.some((m) => tagsOf(m).includes(16385)), "a cleaning run mode");
    assert.ok(run.supportedModes.some((m) => m.mode === run.currentMode), "the run mode is one of the supported ones");
    const clean = c.rvcCleanMode;
    assert.equal(new Set(clean.supportedModes.map((m) => m.mode)).size, clean.supportedModes.length, "clean mode numbers are unique");
    for (const m of clean.supportedModes) {
      assert.ok(typeof m.label === "string" && m.label.length >= 1 && m.label.length <= 64);
      assert.ok(m.modeTags.length >= 1 && m.modeTags.every((t) => Number.isInteger(t.value)));
      assert.ok(tagsOf(m).includes(16385) || tagsOf(m).includes(16386), "every clean mode vacuums or mops");
    }
    assert.ok(clean.supportedModes.some((m) => m.mode === clean.currentMode), `clean mode ${clean.currentMode} is one of the supported ones`);
    const op = c.rvcOperationalState;
    assert.ok(op.operationalStateList.some((s) => s.operationalStateId === op.operationalState), `operational state ${op.operationalState} is in the list`);
    assert.ok(op.operationalError.errorStateId === 0 || op.operationalState === 3, "only an error state has an error");
    if (op.phaseList === null) assert.equal(op.currentPhase, null);
    const area = c.serviceArea;
    const ids = area.supportedAreas.map((s) => s.areaId);
    assert.ok(ids.length >= 1, "Apple Home does not take a vacuum without rooms");
    assert.equal(new Set(ids).size, ids.length, "area ids are unique");
    const names = area.supportedAreas.map((s) => s.areaInfo.locationInfo.locationName);
    assert.equal(new Set(names).size, names.length, "area names are unique");
    for (const s of area.supportedAreas) {
      assert.ok(Number.isInteger(s.areaId) && s.areaId >= 0 && s.areaId <= 0xffffffff);
      assert.ok(area.supportedMaps.some((m) => m.mapId === s.mapId), "every area is on a map that is offered");
      const name = s.areaInfo.locationInfo.locationName;
      assert.ok(typeof name === "string" && name.length >= 1 && Buffer.byteLength(name) <= 128);
    }
    // matter.js 0.17.9 reads supportedMaps.length when it brings the service area up: without a list it fails.
    assert.ok(Array.isArray(area.supportedMaps) && area.supportedMaps.length >= 1, "a list of maps is offered");
    for (const m of area.supportedMaps) assert.ok(Number.isInteger(m.mapId) && typeof m.name === "string" && m.name.length >= 1 && m.name.length <= 64);
    assert.equal(new Set(area.selectedAreas).size, area.selectedAreas.length);
    assert.ok(area.selectedAreas.every((id) => ids.includes(id)), "selected areas exist");
    assert.ok(area.currentArea === null || ids.includes(area.currentArea), "the current area exists");
    assert.ok(Array.isArray(area.progress), "progress per room is offered from the first day");
    assert.equal(new Set(area.progress.map((p) => p.areaId)).size, area.progress.length, "one line of progress per room");
    for (const p of area.progress) assert.ok(ids.includes(p.areaId) && [0, 1, 2, 3].includes(p.status), "progress is about rooms that exist");
    const power = c.powerSource;
    assert.ok(power.batPercentRemaining === null || (Number.isInteger(power.batPercentRemaining) && power.batPercentRemaining >= 0 && power.batPercentRemaining <= 200));
    assert.ok([0, 1, 2].includes(power.batChargeLevel) && [0, 1, 2, 3].includes(power.batChargeState));
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const matter = {
    uuid: api.hap.uuid,
    deviceTypes: { RoboticVacuumCleaner: { name: "RoboticVacuumCleaner", deviceType: 0x74 } },
    accessories: new Map(), // what Homebridge holds: accessory.clusters is the state Home sees
    updates: [], // [{ cluster, attributes }] in the order they were taken
    lines: [], // Homebridge's own log
    features: null, // what Home was offered on the day the vacuum was added
    kept: null, // { cluster: attributes } held from before a restart
    ready: true, // false: Matter is not on for this bridge
    failPublish: false,
    drop: null,
    busy: 0,
    async registerPlatformAccessories(plugin, platform, list) {
      if (!matter.ready) throw new Error(`${plugin}: Cannot register Matter accessories: Matter is not enabled on this bridge.`);
      for (const a of list) {
        for (const field of ["UUID", "displayName", "deviceType", "manufacturer", "model", "serialNumber"]) assert.ok(a[field], `the accessory has '${field}'`);
        assert.equal(a.deviceType, matter.deviceTypes.RoboticVacuumCleaner);
        for (const cluster of Object.keys(a.handlers)) for (const fn of Object.values(a.handlers[cluster])) assert.equal(typeof fn, "function");
        JSON.stringify(a.clusters); // plain data: it is kept in Homebridge's cache
        // No error in what Home takes the vacuum from (it upsets Apple Home there): Matter's default stands in.
        assert.ok(!("operationalError" in a.clusters.rvcOperationalState), "no error at registration");
        const held = { ...a, clusters: copy(a.clusters) };
        held.clusters.rvcOperationalState.operationalError = { errorStateId: 0 };
        check(held.clusters); // what the plugin hands over is right in itself
        await new Promise((r) => setTimeout(r, 20)); // bringing it up on its own Matter node takes a moment
        for (const [cluster, attributes] of Object.entries(matter.kept || {})) Object.assign(held.clusters[cluster], copy(attributes));
        try {
          if (matter.failPublish) throw new Error("no free Matter port");
          check(held.clusters);
        } catch (err) {
          // A robot vacuum lives on a Matter node of its own. When that cannot be brought up
          // Homebridge says so in its log, and the plugin's call still succeeds.
          matter.lines.push(`Failed to publish external Matter accessory ${a.displayName}: ${err.message}`);
          continue;
        }
        matter.features = { progress: "progress" in held.clusters.serviceArea, cleanModes: held.clusters.rvcCleanMode.supportedModes.map((m) => m.mode) };
        matter.accessories.set(a.UUID, held);
        matter.lines.push(`Commissioning codes for ${a.displayName}: Manual Code: 3497-011-2332`);
      }
    },
    async updateAccessoryState(uuid, cluster, attributes) {
      assert.ok(uuid && cluster && attributes && Object.keys(attributes).length, "a state update says what and where");
      assert.ok(matter.busy === 0, "state is never set from inside a command Home is waiting on");
      // Taken a moment later; the plugin's call has long returned by then.
      setImmediate(() => {
        const a = matter.accessories.get(uuid);
        if (!a) return matter.lines.push(`Accessory ${uuid} not found or not registered`);
        if (matter.drop && matter.drop(cluster, attributes)) return matter.lines.push(`Failed to update state for accessory ${uuid}: dropped`);
        const next = copy(a.clusters);
        Object.assign(next[cluster], copy(attributes));
        // Homebridge 2.4.0's Matter (matter.js 0.17.9) clears the error whenever the state is written.
        if (cluster === "rvcOperationalState" && "operationalState" in attributes) next[cluster].operationalError = { errorStateId: 0 };
        try {
          check(next);
        } catch (err) {
          matter.lines.push(`Failed to update state for accessory ${uuid}: ${err.message}`);
          matter.refused = (matter.refused || 0) + 1;
          return;
        }
        Object.assign(a.clusters, next);
        matter.updates.push({ cluster, attributes: copy(attributes) });
      });
    },
    async getAccessoryState(uuid, cluster) {
      const a = matter.accessories.get(uuid);
      return a && a.clusters[cluster] ? copy(a.clusters[cluster]) : undefined;
    },
    // Apple Home sends a command: the plugin's handler runs first, then Matter's own bookkeeping.
    async command(uuid, cluster, name, args) {
      const a = matter.accessories.get(uuid);
      matter.busy++;
      try {
        await a.handlers[cluster][name](args, { uuid });
      } finally {
        matter.busy--;
      }
      if (name === "changeToMode") a.clusters[cluster].currentMode = args.newMode;
      if (name === "selectAreas") a.clusters[cluster].selectedAreas = args.newAreas;
    },
  };
  api.matter = matter;
  api.isMatterEnabled = () => true;
  api.versionGreaterOrEqual = (version) => version <= "2.4.0"; // Homebridge 2.4.0
  return matter;
}

/** Open a PNG made by lib/canvas.js: { width, height, at(x, y) -> [r, g, b] }. */
function readPng(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0;
  const parts = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); }
    if (type === "IDAT") parts.push(body);
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const row = width * 3;
  const data = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (row + 1)];
    for (let x = 0; x < row; x++) {
      const v = raw[y * (row + 1) + 1 + x];
      data[y * row + x] = filter === 2 ? (v + data[(y - 1) * row + x]) & 255 : v;
    }
  }
  return { width, height, at: (x, y) => [data[(y * width + x) * 3], data[(y * width + x) * 3 + 1], data[(y * width + x) * 3 + 2]] };
}

module.exports = { LOCAL_KEY, DUID, RRIOT, fakeMap, mapAnswer, startFakeBroker, fakeHomebridge, addFakeMatter, readPng };
