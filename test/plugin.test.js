"use strict";

// End-to-end test: fake Roborock MQTT broker + fake robot + fake Homebridge.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../lib/protocol");
const { LOCAL_KEY, DUID, RRIOT, startFakeBroker, fakeHomebridge } = require("./helpers");

test("protocol round trip", () => {
  const payload = P.buildRpcPayload("get_status", [], 12345, 1700000000);
  const frame = P.encodeMessage({ localKey: LOCAL_KEY, protocol: 101, payload, ts: 1700000000 });
  const msg = P.decodeMessage(frame, LOCAL_KEY);
  assert.equal(msg.protocol, 101);
  assert.deepEqual(JSON.parse(JSON.parse(msg.payload.toString()).dps["101"]), { id: 12345, method: "get_status", params: [] });
  // corrupt byte -> rejected by CRC
  frame[20] ^= 0xff;
  assert.equal(P.decodeMessage(frame, LOCAL_KEY), null);
});

test("encodeTimestamp matches python-roborock", () => {
  // hex "6553f100", picked at indices [5,6,3,7,1,2,0,4]
  assert.equal(P.encodeTimestamp(0x6553f100), "1030556f");
});

test("platform creates room switches and starts a max x2 clean", async () => {
  const robotLog = [];
  const broker = await startFakeBroker(robotLog);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "rrc-"));
  const dir = path.join(storage, "roborock-room-clean");
  fs.mkdirSync(dir);
  const rriot = { ...RRIOT, r: { ...RRIOT.r, m: `tcp://127.0.0.1:${broker.address().port}` } };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ email: "a@b.c", baseUrl: "https://x", userData: { token: "t", rriot } }));

  // Stub the cloud home-data call.
  const cloud = require("../lib/cloud");
  cloud.getHomeData = async () => ({
    devices: [{ duid: DUID, name: "S8", localKey: LOCAL_KEY, pv: "1.0", productId: "p" }],
    products: [{ id: "p", category: "robot.vacuum.cleaner" }],
    rooms: [{ id: 111, name: "סלון" }, { id: 222, name: "מטבח" }],
  });

  const api = fakeHomebridge(storage);
  const C_ = api.hap.Characteristic;
  require("../index.js")(api);
  const logs = [];
  const log = Object.assign((...a) => logs.push(a.join(" ")), {
    info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push("ERR " + m), debug: () => {},
  });
  const platform = new api.Platform(log, { nameTemplate: "ניקוי {room}", programs: [{ name: "מטבח וסלון", rooms: ["מטבח", "סלון"], repeat: 1 }] }, api);
  await platform.start();

  const names = api.registered.map((a) => a.displayName).sort();
  assert.deepEqual(names, ["ניקוי מטבח", "ניקוי סלון", "מטבח וסלון", "S8 Charging"].sort());

  // Charging sensor: robot reports state 8 (charging) -> contact closed, battery shown.
  await new Promise((r) => setTimeout(r, 2500));
  const dock = platform.docks.get(DUID);
  assert.equal(dock.contact.getCharacteristic(C_.ContactSensorState).value, 0);
  assert.equal(dock.battery.getCharacteristic("BatteryLevel").value, 87);
  assert.equal(dock.battery.getCharacteristic(C_.ChargingState).value, 1);
  platform.updateChargingSensor(DUID, { state: 5, battery: 60 });
  assert.equal(dock.contact.getCharacteristic(C_.ContactSensorState).value, 1);
  assert.equal(dock.battery.getCharacteristic("BatteryLevel").value, 60);

  const salon = [...platform.programs.values()].find((p) => p.name === "ניקוי סלון");
  const fan = salon.accessory.getService("Fanv2");
  assert.ok(fan, "room is exposed as a fan");
  assert.equal(fan.getCharacteristic("RotationSpeed").props.minStep, 25);
  assert.equal(await fan.getCharacteristic("RotationSpeed").getFn(), 100); // default = max

  // Home app: drag slider to 50% on a fan that is off -> starts at "balanced" once.
  fan.getCharacteristic("Active").setFn(1);
  fan.getCharacteristic("RotationSpeed").setFn(50);
  await new Promise((r) => setTimeout(r, 900));
  await new Promise((r) => setTimeout(r, 300));
  let fanCmds = robotLog.filter((r) => r.method === "set_custom_mode");
  assert.deepEqual(fanCmds.map((r) => r.params), [[102]]);
  const water = robotLog.find((r) => r.method === "set_water_box_custom_mode");
  assert.deepEqual(water.params, [200]);
  const cleans = robotLog.filter((r) => r.method === "app_segment_clean");
  assert.equal(cleans.length, 1);
  assert.deepEqual(cleans[0].params, [{ segments: [16], repeat: 2 }]);
  assert.equal(salon.running, true);
  assert.equal(await fan.getCharacteristic("Active").getFn(), 1);

  // While running, slider to 100% -> suction changes live to max, no new clean.
  robotLog.length = 0;
  fan.getCharacteristic("RotationSpeed").setFn(100);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(robotLog.map((r) => [r.method, r.params]), [["set_custom_mode", [104]]]);
  assert.equal(platform.speedToLevel(1), "quiet");
  assert.equal(platform.speedToLevel(26), "balanced");
  assert.equal(platform.speedToLevel(75), "turbo");

  // Restore of previous settings after the clean
  robotLog.length = 0;
  await platform.restoreSettings(salon);
  // previous robot settings were balanced(102)/water 202; now at max -> restore both
  assert.deepEqual(robotLog.map((r) => [r.method, r.params]), [["set_custom_mode", [101]], ["set_water_box_custom_mode", [202]]]);

  const combo = [...platform.programs.values()].find((p) => p.name === "מטבח וסלון");
  assert.deepEqual(combo.segments, [17, 16]);

  api.emit("shutdown");
  broker.close();
  assert.ok(!logs.some((l) => l.startsWith("ERR")), logs.join("\n"));
});
