"use strict";

// Extras per robot: spot clean fan, maintenance, error sensor, Do Not Disturb, volume.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const cloud = require("../lib/cloud");
const { fakeHomebridge, startFakeBroker, RRIOT, DUID } = require("./helpers");
const { HOME } = require("./vacuum-harness");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startPlatform(config, robot) {
  const robotLog = [];
  const broker = await startFakeBroker(robotLog, robot);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "rrc-"));
  const dir = path.join(storage, "roborock-room-clean");
  fs.mkdirSync(dir);
  const rriot = { ...RRIOT, r: { ...RRIOT.r, m: `tcp://127.0.0.1:${broker.address().port}` } };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ email: "a@b.c", baseUrl: "https://x", userData: { token: "t", rriot } }));
  cloud.getHomeData = async () => HOME;
  cloud.getRoutines = async () => [];
  const api = fakeHomebridge(storage);
  require("../index.js")(api);
  const logs = [];
  const log = Object.assign((...a) => logs.push(a.join(" ")), {
    info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push("ERR " + m), debug: (m) => logs.push("DBG " + m),
  });
  const platform = new api.Platform(log, config, api);
  await platform.start();
  const named = (name) => api.registered.find((a) => a.displayName === name);
  const stop = () => {
    api.emit("shutdown");
    broker.close();
  };
  return { platform, api, robotLog, logs, named, stop, sent: (m) => robotLog.filter((r) => r.method === m) };
}

const DOCKED = { state: 8, in_cleaning: 0, fan_power: 102, water_box_mode: 200, battery: 90, error_code: 0 };

test("extras are off by default", async () => {
  const t = await startPlatform({}, { status: DOCKED });
  for (const name of ["S8 Spot Clean", "S8 Maintenance", "S8 Error", "S8 Do Not Disturb", "S8 Volume", "S8 Stuck", "S8 Dock Not Found", "S8 Clean Not Finished"]) assert.ok(!t.named(name), name);
  t.stop();
});

test("spot clean: a fan; on sets the suction and starts, off stops and sends to the dock; follows the robot", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ spotClean: true }, robot);
  const a = t.named("S8 Spot Clean");
  assert.ok(a, t.api.registered.map((x) => x.displayName).join(", "));
  const fan = a.getService("Fanv2");
  await fan.getCharacteristic("RotationSpeed").setFn(50); // balanced (4 levels)
  await fan.getCharacteristic("Active").setFn(1);
  assert.deepEqual(t.sent("set_custom_mode").at(-1).params, [102]);
  assert.equal(t.sent("app_spot").length, 1);
  assert.equal(fan.getCharacteristic("Active").getFn(), 1);
  await fan.getCharacteristic("Active").setFn(0);
  assert.equal(t.sent("app_stop").length, 1);
  assert.equal(t.sent("app_charge").length, 1);
  // Started from the robot or the app: shown on, then off when done.
  const extras = t.platform.extras.get(DUID);
  extras.statusChanged({ ...DOCKED, state: 11 });
  assert.equal(fan.getCharacteristic("Active").value, 1);
  extras.statusChanged({ ...DOCKED, state: 8 });
  assert.equal(fan.getCharacteristic("Active").value, 0);
  t.stop();
});

test("maintenance: life left per part, a sensor that opens when one is due, reset after a replacement", async () => {
  const robot = { status: DOCKED, wear: { main_brush_work_time: 150 * 3600, side_brush_work_time: 0, filter_work_time: 151 * 3600, sensor_dirty_time: 3 * 3600 } };
  const t = await startPlatform({ maintenance: true, spotClean: true, language: "he" }, robot);
  const spot = t.named("ניקוי נקודתי S8");
  const m = t.named("תחזוקת S8");
  assert.ok(spot && m);
  const extras = t.platform.extras.get(DUID);
  await extras.readConsumables();
  const life = (key) => spot.getServiceById("FilterMaintenance", key).getCharacteristic("FilterLifeLevel").value;
  assert.equal(life("main_brush_work_time"), 50);
  assert.equal(life("side_brush_work_time"), 100);
  assert.equal(life("filter_work_time"), 0);
  assert.equal(life("sensor_dirty_time"), 90);
  assert.equal(spot.getServiceById("FilterMaintenance", "filter_work_time").getCharacteristic("FilterChangeIndication").value, 1);
  assert.equal(m.getService("ContactSensor").getCharacteristic(t.api.hap.Characteristic.ContactSensorState).value, 1, "open: the filter is due");
  assert.ok(t.logs.some((l) => /due for replacement or cleaning: פילטר/.test(l)), t.logs.join("\n"));
  // Replaced: reset from Home.
  await spot.getServiceById("FilterMaintenance", "filter_work_time").getCharacteristic("ResetFilterIndication").setFn(1);
  assert.equal(t.sent("reset_consumable").at(-1).params[0], "filter_work_time");
  assert.equal(life("filter_work_time"), 100);
  assert.equal(m.getService("ContactSensor").getCharacteristic(t.api.hap.Characteristic.ContactSensorState).value, 0, "closed again");
  t.stop();
});

test("error sensor: opens while the robot is in error, says what the error is, closes after", async () => {
  const t = await startPlatform({ errorSensor: true }, { status: DOCKED });
  const s = t.named("S8 Error").getService("ContactSensor");
  const extras = t.platform.extras.get(DUID);
  extras.statusChanged({ ...DOCKED, state: 12, error_code: 8 });
  assert.equal(s.getCharacteristic(t.api.hap.Characteristic.ContactSensorState).value, 1);
  assert.ok(t.logs.some((l) => /S8 Error: open: robot trapped/.test(l)), t.logs.join("\n"));
  extras.statusChanged({ ...DOCKED, state: 5, error_code: 0 });
  assert.equal(s.getCharacteristic(t.api.hap.Characteristic.ContactSensorState).value, 0);
  t.stop();
});

test("stuck and dock sensors: each opens only for its own errors", async () => {
  const t = await startPlatform({ stuckSensor: true, dockSensor: true, language: "he" }, { status: DOCKED });
  const C = t.api.hap.Characteristic.ContactSensorState;
  const stuck = t.named("S8 תקוע").getService("ContactSensor");
  const dock = t.named("S8 לא מוצא עגינה").getService("ContactSensor");
  const extras = t.platform.extras.get(DUID);
  extras.statusChanged({ ...DOCKED, state: 12, error_code: 8 }); // trapped
  assert.equal(stuck.getCharacteristic(C).value, 1);
  assert.equal(dock.getCharacteristic(C).value, 0);
  extras.statusChanged({ ...DOCKED, state: 12, error_code: 23 }); // could not return to the dock
  assert.equal(stuck.getCharacteristic(C).value, 0);
  assert.equal(dock.getCharacteristic(C).value, 1);
  extras.statusChanged({ ...DOCKED, state: 12, error_code: 9 }); // dustbin missing: neither
  assert.equal(stuck.getCharacteristic(C).value, 0);
  assert.equal(dock.getCharacteristic(C).value, 0);
  extras.statusChanged({ ...DOCKED, state: 5, error_code: 0 });
  assert.equal(dock.getCharacteristic(C).value, 0);
  assert.ok(t.logs.some((l) => /S8 תקוע: open: robot trapped/.test(l)), t.logs.join("\n"));
  t.stop();
});

test("clean not finished: opens when the robot's record says the clean was not finished, closes on the next clean", async () => {
  const robot = { status: DOCKED, records: [] };
  const t = await startPlatform({ incompleteSensor: true }, robot);
  const C = t.api.hap.Characteristic.ContactSensorState;
  const s = t.named("S8 Clean Not Finished").getService("ContactSensor");
  const extras = t.platform.extras.get(DUID);
  extras.recordWait = [20, 20];
  const now = () => Math.floor(Date.now() / 1000);
  const run = async (states, record) => {
    for (const st of states) extras.statusChanged({ ...DOCKED, ...st });
    robot.records.push({ begin: now() - 600, end: now() + 1, duration: 600, area: 20e6, error: 0, complete: record.complete, finish_reason: record.reason });
    await wait(300);
  };
  try {
  // Could not reach a room: straight home on its own, record not complete.
  await run([{ state: 18, in_cleaning: 2 }, { state: 6, in_cleaning: 2 }, { state: 8, in_cleaning: 0 }], { complete: 0, reason: 45 });
  assert.equal(s.getCharacteristic(C).value, 1, t.logs.join("\n"));
  // The next clean closes it; this one finishes.
  await run([{ state: 18, in_cleaning: 2 }], { complete: 1, reason: 56 });
  assert.equal(s.getCharacteristic(C).value, 0);
  await run([{ state: 6, in_cleaning: 0 }, { state: 8, in_cleaning: 0 }], { complete: 1, reason: 56 });
  assert.equal(s.getCharacteristic(C).value, 0);
  // Stopped by hand and sent home: not an alert.
  await run([{ state: 18, in_cleaning: 2 }, { state: 10, in_cleaning: 2 }, { state: 6, in_cleaning: 0 }, { state: 8, in_cleaning: 0 }], { complete: 0, reason: 21 });
  assert.equal(s.getCharacteristic(C).value, 0);
  assert.ok(t.logs.some((l) => /ended before it was finished .*finish reason 45/.test(l)), t.logs.join("\n"));
  } finally {
    t.stop();
  }
});

test("Do Not Disturb: on sets the robot's hours, off closes them; read from the robot", async () => {
  const robot = { status: DOCKED, dnd: { start_hour: 23, start_minute: 30, end_hour: 7, end_minute: 0, enabled: 1 } };
  const t = await startPlatform({ dndSwitch: true }, robot);
  const extras = t.platform.extras.get(DUID);
  await extras.readSettings();
  const on = t.named("S8 Do Not Disturb").getService("Switch").getCharacteristic("On");
  assert.equal(on.value, true, "on in the Roborock app");
  await on.setFn(false);
  assert.equal(robot.dnd.enabled, 0);
  await on.setFn(true);
  assert.deepEqual(t.sent("set_dnd_timer").at(-1).params, [23, 30, 7, 0], "the robot's own hours");
  assert.equal(robot.dnd.enabled, 1);
  t.stop();
});

test("volume: a light's brightness; off is silent, on brings the volume back", async () => {
  const robot = { status: DOCKED, volume: 60 };
  const t = await startPlatform({ volumeSlider: true }, robot);
  const extras = t.platform.extras.get(DUID);
  await extras.readSettings();
  const light = t.named("S8 Volume").getService("Lightbulb");
  assert.equal(light.getCharacteristic("Brightness").value, 60);
  await light.getCharacteristic("Brightness").setFn(35);
  assert.equal(robot.volume, 35);
  await light.getCharacteristic("On").setFn(false);
  assert.equal(robot.volume, 0);
  await light.getCharacteristic("On").setFn(true);
  assert.equal(robot.volume, 35);
  t.stop();
});
