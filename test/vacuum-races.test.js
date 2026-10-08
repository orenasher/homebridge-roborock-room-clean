"use strict";

// The robot as a robot vacuum in Apple Home (Matter): commands that cross each other, and robots that do not do as told.
const test = require("node:test");
const assert = require("node:assert");
const { DUID } = require("./helpers");
const { wait, TOLD, DOCKED, startPlatform } = require("./vacuum-harness");

const CLEANING = { ...DOCKED, state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200 };
const order = (t, ...methods) => t.sent(...methods).map((c) => c[0]);

test("a newer clean is never stopped by an older one that was called off", async () => {
  // The robot takes a while to answer a start.
  const robot = { status: DOCKED, slow: { app_segment_clean: 900 } };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });

  // Play, and while the start is on its way a fan is turned on in Home: the fan's clean is not stopped.
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(300);
  const living = t.byName("Clean סלון");
  living.service.getCharacteristic("Active").setFn(1);
  await wait(3500);
  assert.equal(living.running, true);
  assert.deepEqual(order(t, "app_stop"), [], "nothing stopped the fan's clean");
  assert.deepEqual(order(t, "app_segment_clean").length, 2);
  living.service.getCharacteristic("Active").setFn(0);
  await wait(5500);

  // Play, stop, play again before the first start was answered: the robot ends up cleaning.
  t.robotLog.length = 0;
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(200);
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 0 });
  await wait(150);
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(4500);
  const last = order(t, "app_stop", "app_segment_clean").pop();
  assert.equal(last, "app_segment_clean", order(t, "app_stop", "app_segment_clean", "app_charge").join(" "));
  assert.deepEqual(t.shown(), [1, 1]);
  assert.ok(t.platform.vacuums.get(DUID).job, "the second clean is the vacuum's own");
  // The stop's putting back of the settings did not land in the middle of the new clean.
  assert.deepEqual(t.sent("set_custom_mode").filter((c) => c[1][0] === 101), []);
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("send to dock, then play at once: the robot is not sent home from the new clean", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await t.report(CLEANING);
  t.robotLog.length = 0;
  await t.home.command(t.vacuum().UUID, "rvcOperationalState", "goHome");
  await wait(200);
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(4000);
  assert.deepEqual(order(t, "app_stop", "app_charge", "app_segment_clean"), ["app_stop", "app_stop", "app_segment_clean"]);
  t.stop();
});

test("a fan turned off just before a start from the vacuum: the robot is not sent home, and its own settings are kept", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  await t.published();
  const kitchen = t.byName("Clean מטבח");
  kitchen.service.getCharacteristic("Active").setFn(1);
  await wait(3000);
  assert.deepEqual(kitchen.restore, { fanPower: 101, waterBoxMode: 202 });
  await t.report(CLEANING);
  // Off in Home, and a moment later play on the vacuum.
  kitchen.service.getCharacteristic("Active").setFn(0);
  await wait(300);
  t.robotLog.length = 0;
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(5000);
  assert.deepEqual(order(t, "app_charge"), [], "the fan's trip to the dock was dropped");
  assert.equal(order(t, "app_segment_clean").length, 1);
  assert.deepEqual(t.sent("set_custom_mode").filter((c) => c[1][0] === 101), [], "nothing was put back in the middle of the clean");
  assert.deepEqual(t.platform.vacuums.get(DUID).job.restore, { fanPower: 101, waterBoxMode: 202 }, "the robot's own settings are put back when the vacuum's clean ends");
  t.stop();
});

test("the settings of a start are judged on the robot's status as it is now", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 }); // max: 104
  robot.status = CLEANING;
  // Stopped, quiet chosen, and played again before the settings were put back.
  await t.press("rvcRunMode", "changeToMode", { newMode: 0 });
  await t.press("rvcCleanMode", "changeToMode", { newMode: 3 });
  robot.status = { ...CLEANING, state: 3, in_cleaning: 0 };
  t.robotLog.length = 0;
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(3500);
  assert.deepEqual(t.sent("set_custom_mode"), [["set_custom_mode", [101]]], "quiet is sent: the robot is at max");
  assert.deepEqual(t.platform.vacuums.get(DUID).job.restore, { fanPower: 101, waterBoxMode: 202 }, "and what is put back afterwards is still the robot's own");
  t.stop();
});

test("pause pressed while the clean is still being started; play pressed right after pause", async () => {
  const robot = { status: DOCKED, slow: { app_segment_clean: 900 } };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(300);
  await t.press("rvcOperationalState", "pause");
  assert.deepEqual(t.shown(), [1, 2], "paused, at once");
  await wait(1200);
  assert.deepEqual(order(t, "app_segment_clean", "app_pause"), ["app_segment_clean", "app_pause"], "paused once the robot took the start");
  await t.report({ ...CLEANING, state: 10 });
  assert.deepEqual(t.shown(), [1, 2]);

  // Paused, and play pressed before the robot's status shows the pause: the clean goes on, it is not started anew.
  await t.report(CLEANING);
  t.robotLog.length = 0;
  await t.home.command(v.UUID, "rvcOperationalState", "pause", {});
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  assert.deepEqual(order(t, "app_pause", "resume_segment_clean", "app_stop", "app_segment_clean", "app_start"), ["app_pause", "resume_segment_clean"]);
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("a robot that goes into error, recharges halfway, or names its rooms: Home follows it", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  // It took the start, then stopped with an error: Home is not shown a clean for the next 90 seconds.
  await t.report({ ...DOCKED, state: 12, in_cleaning: 3, error_code: 9 });
  assert.deepEqual([...t.shown(), v.clusters.rvcOperationalState.operationalError.errorStateId], [0, 3, 66], "bin missing");
  await t.report(CLEANING);
  assert.deepEqual(t.rooms(), { 16: 1 });

  // Back to the dock halfway to charge, and on again: the room is still the one being cleaned.
  await t.report({ ...CLEANING, state: 6 });
  await t.report({ ...CLEANING, state: 8 });
  assert.deepEqual(t.shown(), [0, 65]);
  await t.report(CLEANING);
  assert.deepEqual([t.shown(), t.rooms(), v.clusters.serviceArea.currentArea], [[1, 1], { 16: 1 }, 16]);
  await t.report({ ...DOCKED, state: 8 });

  // Two rooms; the robot says it is in the first, then in the second: the first is done.
  await t.press("serviceArea", "selectAreas", { newAreas: [] });
  t.platform.vacuums.get(DUID).job = null;
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await t.report({ ...CLEANING, state: 5, in_cleaning: 1, cleaning_info: { segment_id: 16 } });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 1, 17: 0 }, 16]);
  await t.report({ ...CLEANING, state: 5, in_cleaning: 1, cleaning_info: { segment_id: 17 } });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 3, 17: 1 }, 17]);
  t.stop();
});

test("resume, stop and the kind of clean, judged on what the robot does", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  // "Vacuum" chosen: the robot cleans with the suction from the settings (max), and Home still shows "Vacuum".
  await t.press("rvcCleanMode", "changeToMode", { newMode: 0 });
  await t.report({ ...CLEANING, in_cleaning: 1, state: 5 });
  t.platform.vacuums.get(DUID).modeSetAt = 0;
  await t.report({ ...CLEANING, in_cleaning: 1, state: 5, battery: 80 });
  assert.equal(v.clusters.rvcCleanMode.currentMode, 0);
  // Paused in the middle of a zone clean: taken up where it stopped. A kind of clean chosen while paused is sent at once.
  await t.report({ ...CLEANING, state: 10, in_cleaning: 2 });
  t.robotLog.length = 0;
  await t.press("rvcCleanMode", "changeToMode", { newMode: 3 });
  assert.deepEqual(t.sent("set_custom_mode"), [["set_custom_mode", [101]]]);
  await t.press("rvcOperationalState", "resume");
  assert.deepEqual(order(t, "resume_zoned_clean", "app_start"), ["resume_zoned_clean"]);
  // Paused on its way to the dock, with no clean going on: resume takes it on to the dock, it does not start a clean.
  await t.report({ ...DOCKED, state: 10, in_cleaning: 0 });
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "resume");
  assert.deepEqual(order(t, "app_charge", "app_start"), ["app_charge"]);
  assert.equal(v.clusters.rvcOperationalState.operationalState, 64);

  // Stop, while what is known here says "on the dock" but the robot is out cleaning: the robot is asked, and stopped.
  await t.report(DOCKED);
  robot.status = { ...CLEANING, in_cleaning: 1, state: 5 };
  t.robotLog.length = 0;
  await t.press("rvcRunMode", "changeToMode", { newMode: 0 });
  assert.deepEqual(order(t, "app_stop"), ["app_stop"]);
  t.stop();
});

test("send to dock that the robot refuses: said in the log, and the robot's settings are still put back", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 }); // max: 104, water off
  await t.report(CLEANING);
  robot.refuse = { app_charge: 5 };
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "goHome");
  await wait(5500);
  assert.ok(t.logs.some((l) => /ERR S8: could not send the robot to the dock/.test(l)), t.logs.join("\n"));
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode"), [["set_custom_mode", [101]], ["set_water_box_custom_mode", [202]]]);
  assert.ok(TOLD > 0);
  t.stop();
});

test("a clean started elsewhere while the robot drives home: Home shows its rooms, not those of the clean before", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await t.report(CLEANING);
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 1 }, 16]);
  await t.press("rvcOperationalState", "goHome");
  await t.report({ ...CLEANING, state: 6, in_cleaning: 0 });
  assert.deepEqual(t.shown(), [1, 64]);
  // On its way home, the kitchen is started in the Roborock app.
  robot.cleaning = [17];
  await t.report({ ...CLEANING, state: 18, in_cleaning: 3 });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 1, 17: 1 }, null], "the living room clean is over; which rooms this one cleans is not known");
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, [], "shown as a clean of the whole home");
  t.stop();
});

test("a fan turned on while the robot drives home from the vacuum's clean: Home shows the fan's room", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await t.report(CLEANING);
  await t.press("rvcOperationalState", "goHome");
  await t.report({ ...CLEANING, state: 6, in_cleaning: 0 });
  // The kitchen fan in Home.
  t.byName("Clean מטבח").service.getCharacteristic("Active").setFn(1);
  await wait(3000);
  await t.report({ ...CLEANING, state: 18, in_cleaning: 3 });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 17: 1 }, 17]);
  // Home names the clean from the rooms shown as chosen: the fan's, while it runs.
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, [17]);
  // Over: what was chosen on the vacuum is shown again.
  t.platform.vacuums.get(DUID); // (the vacuum's own choice was the living room)
  t.byName("Clean מטבח").startedAt -= 61000;
  await t.report({ ...DOCKED });
  await t.platform.poll(t.byName("Clean מטבח"));
  await t.report({ ...DOCKED, battery: 86 });
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, [16]);
  t.stop();
});
