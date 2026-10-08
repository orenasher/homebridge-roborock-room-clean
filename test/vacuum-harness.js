"use strict";

// Shared by the tests of the robot vacuum (Matter): a platform with a fake robot and a fake Homebridge behind it.
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cloud = require("../lib/cloud");
const { LOCAL_KEY, DUID, RRIOT, startFakeBroker, fakeHomebridge, addFakeMatter } = require("./helpers");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Home is told a moment after something changes (and the error a moment after the state).
const TOLD = 700;

const HOME = {
  devices: [{ duid: DUID, name: "S8", localKey: LOCAL_KEY, pv: "1.0", productId: "p", sn: "SN123", fv: "02.16.12" }],
  products: [{ id: "p", category: "robot.vacuum.cleaner", name: "Roborock S8" }],
  rooms: [{ id: 111, name: "סלון" }, { id: 222, name: "מטבח" }],
};
const DOCKED = { state: 8, in_cleaning: 0, fan_power: 101, water_box_mode: 202, battery: 87 };

/**
 * `matter`: false for a bridge without Matter. `keepDir`: start again with what an earlier start kept.
 * `setup(home)`: prepare Homebridge's Matter side before the plugin starts. `home`: the Roborock account.
 * `checkMs`: how often what Homebridge holds is compared with what it was told (off when not given).
 */
async function startPlatform(config, robot, { matter = true, routines = [], keepDir = null, setup = null, home: account = HOME, checkMs = 0 } = {}) {
  const robotLog = [];
  const broker = await startFakeBroker(robotLog, robot);
  const storage = keepDir ? path.dirname(keepDir) : fs.mkdtempSync(path.join(os.tmpdir(), "rrc-"));
  const dir = path.join(storage, "roborock-room-clean");
  if (!keepDir) fs.mkdirSync(dir);
  const rriot = { ...RRIOT, r: { ...RRIOT.r, m: `tcp://127.0.0.1:${broker.address().port}` } };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ email: "a@b.c", baseUrl: "https://x", userData: { token: "t", rriot } }));
  cloud.getHomeData = async () => account;
  cloud.getRoutines = async () => routines;
  const api = fakeHomebridge(storage);
  const home = matter ? addFakeMatter(api) : null;
  if (home && setup) setup(home, api);
  require("../index.js")(api);
  const logs = [];
  const log = Object.assign((...a) => logs.push(a.join(" ")), { info: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m), error: (m) => logs.push("ERR " + m), debug: (m) => logs.push("DBG " + m) });
  const platform = new api.Platform(log, { platform: "RoborockRoomClean", ...config }, api);
  platform.externalWaits = [0, 300, 300];
  platform.dockRetryMs = 150;
  // What Homebridge holds is compared with what it was told only in the tests that ask for it
  // (checkMs): elsewhere it would put right, unseen, what a test is there to catch.
  platform.vacuumCheckMs = checkMs || 3600000;
  await platform.start();
  const monitor = platform.monitors.get(DUID);
  // The robot's status as the plugin reads it at its next check.
  const report = async (status) => {
    robot.status = status;
    monitor.full = null;
    await platform.readStatus(DUID, monitor.channel, 0);
    await wait(TOLD);
  };
  const vacuum = () => (home ? [...home.accessories.values()][0] : null);
  const published = async () => {
    for (let n = 0; n < 50 && !(platform.vacuums.get(DUID) || {}).published; n++) await wait(100);
    assert.ok(platform.vacuums.get(DUID).published, logs.join("\n"));
    await wait(TOLD + 300); // everything is told once more after publishing
    return vacuum();
  };
  // Apple Home sends a command, and a moment passes.
  const press = async (cluster, name, args) => {
    await home.command(vacuum().UUID, cluster, name, args);
    await wait(TOLD);
  };
  const sent = (...methods) => robotLog.filter((r) => methods.includes(r.method)).map((r) => [r.method, r.params]);
  const byName = (name) => [...platform.programs.values()].find((p) => p.name === name);
  const stop = () => {
    api.emit("shutdown");
    broker.close();
  };
  const said = () => logs.filter((l) => !l.startsWith("DBG"));
  // What Home shows: [run mode, operational state], and the rooms of the clean as { room: status }.
  const shown = () => [vacuum().clusters.rvcRunMode.currentMode, vacuum().clusters.rvcOperationalState.operationalState];
  const rooms = () => Object.fromEntries(vacuum().clusters.serviceArea.progress.map((p) => [p.areaId, p.status]));
  return { platform, api, home, robotLog, logs, said, dir, monitor, report, vacuum, published, press, sent, byName, stop, shown, rooms };
}

module.exports = { wait, TOLD, HOME, DOCKED, startPlatform };
