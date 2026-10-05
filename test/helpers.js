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
function mapAnswer(id, nonceHex, map) {
  const head = Buffer.alloc(24);
  head.write("ENDPOINT", 0, "ascii");
  head.writeUInt16LE(id, 16);
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(nonceHex, "hex"), Buffer.alloc(16));
  return Buffer.concat([head, cipher.update(zlib.gzipSync(map)), cipher.final()]);
}

/** Minimal MQTT broker speaking just what our client uses, with a robot attached. */
function startFakeBroker(robotLog, robot = {}) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (type, body) => sock.write(Buffer.concat([Buffer.from([type, body.length]), body]));
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
        else if (type === 8) send(0x90, Buffer.concat([body.subarray(0, 2), Buffer.from([1])]));
        else if (type === 12) send(0xd0, Buffer.alloc(0));
        else if (type === 3) {
          const qos = (h >> 1) & 3;
          const tl = body.readUInt16BE(0);
          const topic = body.toString("utf8", 2, 2 + tl);
          const frame = body.subarray(2 + tl + (qos ? 2 : 0));
          const msg = P.decodeMessage(frame, LOCAL_KEY);
          const req = JSON.parse(JSON.parse(msg.payload.toString()).dps["101"]);
          robotLog.push(req);
          let result = ["ok"];
          if (req.method === "get_room_mapping") result = [[16, "111", 14], [17, "222", 14]];
          if (req.method === "get_status") result = [robot.status || { state: 8, in_cleaning: 0, fan_power: 101, water_box_mode: 202, battery: 87 }];
          const ts = Math.floor(Date.now() / 1000);
          const outTopic = topic.replace("rr/m/i/", "rr/m/o/");
          const publish = (protocol, payload) => {
            const resp = P.encodeMessage({ localKey: LOCAL_KEY, protocol, payload, ts });
            const t = Buffer.alloc(2); t.writeUInt16BE(outTopic.length);
            const pub = Buffer.concat([t, Buffer.from(outTopic), resp]);
            const lenBytes = [];
            let L = pub.length;
            do { let x = L % 128; L = Math.floor(L / 128); if (L) x |= 0x80; lenBytes.push(x); } while (L);
            sock.write(Buffer.concat([Buffer.from([0x30, ...lenBytes]), pub]));
          };
          publish(102, Buffer.from(JSON.stringify({ dps: { 102: JSON.stringify({ id: req.id, result }) }, t: ts })));
          // The map itself follows the "ok" as a separate message. First one that
          // belongs to another app on the same account (it must be ignored).
          if (req.method === "get_map_v1" && robot.cleaning) {
            publish(301, mapAnswer(req.id, crypto.randomBytes(16).toString("hex"), fakeMap([99])));
            publish(301, mapAnswer(req.id, req.security.nonce, fakeMap(robot.cleaning)));
          }
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
    Active: "Active", RotationSpeed: "RotationSpeed", On: "On", Name: "Name", ConfiguredName: "ConfiguredName", Manufacturer: "M", Model: "Mo", SerialNumber: "S" };
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
    constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.services = new Map([["Info", new Service("Info")]]); }
    getService(t) { return this.services.get(t); }
    addService(t, name) { const s = new Service(name); s.type = t; this.services.set(t, s); return s; }
    removeService(svc) { for (const [k, v] of this.services) if (v === svc) this.services.delete(k); }
  }
  const api = new EventEmitter();
  api.hap = { Service: S, Characteristic: C, uuid: { generate: (s) => require("crypto").createHash("md5").update(s).digest("hex") } };
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storage };
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, list) => api.registered.push(...list);
  api.unregisterPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.registerPlatform = (_p, _n, cls) => (api.Platform = cls);
  return api;
}

module.exports = { LOCAL_KEY, DUID, RRIOT, fakeMap, mapAnswer, startFakeBroker, fakeHomebridge };
