"use strict";

// The robot as a robot vacuum in Apple Home (Matter): cleans started, stopped and followed from it.
const test = require("node:test");
const assert = require("node:assert");
const { DUID } = require("./helpers");
const { wait, DOCKED, startPlatform } = require("./vacuum-harness");

test("starting from the vacuum: the chosen rooms in the chosen kind of clean; the room's fan shows it", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true, roomSettings: [{ room: "מטבח", repeat: 3 }] }, robot);
  const v = await t.published();
  // Home: rooms > kitchen, quiet, play.
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.press("rvcCleanMode", "changeToMode", { newMode: 3 });
  assert.deepEqual(t.sent("set_custom_mode"), [], "chosen while the robot is on the dock: nothing is sent yet");
  // Play, pressed twice.
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  // Shown as cleaning at once, although the robot still says "charging".
  assert.deepEqual(t.shown(), [1, 1]);
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 17: 1 }, 17], "Home's line: cleaning the kitchen");
  // Quiet is already the robot's suction (101): only the water is turned off, then the room is cleaned with its own passes. Once.
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode", "app_segment_clean", "app_start"), [
    ["set_water_box_custom_mode", [200]],
    ["app_segment_clean", [{ segments: [17], repeat: 3 }]],
  ]);
  assert.equal(t.byName("Clean מטבח").running, true, "the kitchen fan is on");
  assert.equal(t.byName("Clean סלון").running, false);
  assert.ok(Date.now() - t.byName("Clean מטבח").startedAt < 5000, "and is given the time a robot needs to get going");
  assert.ok(t.said().some((l) => /Clean מטבח: started from the robot vacuum in Apple Home/.test(l)));
  // The robot is under way. Its status is the plugin's own doing: no map is read to find out what this clean is.
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, water_box_mode: 200 });
  assert.deepEqual(t.shown(), [1, 1]);
  assert.equal(v.clusters.serviceArea.currentArea, 17);
  assert.equal(v.clusters.rvcCleanMode.currentMode, 3);
  assert.deepEqual(t.sent("get_map_v1"), []);
  assert.ok(!t.said().some((l) => /started outside Apple Home/.test(l)));

  // Suction changed in Home while it cleans: sent at once.
  await t.press("rvcCleanMode", "changeToMode", { newMode: 6 });
  assert.deepEqual(t.sent("set_custom_mode"), [["set_custom_mode", [104]]]);
  assert.equal(v.clusters.rvcCleanMode.currentMode, 6);
  // Pause and go on.
  await t.press("rvcOperationalState", "pause");
  assert.equal(v.clusters.rvcOperationalState.operationalState, 2);
  assert.deepEqual(t.sent("app_pause"), [["app_pause", []]]);
  await t.report({ ...DOCKED, state: 10, in_cleaning: 3, fan_power: 104, water_box_mode: 200 });
  await t.press("rvcOperationalState", "resume");
  assert.deepEqual(t.sent("resume_segment_clean", "app_start"), [["resume_segment_clean", []]], "a paused room clean is taken up where it stopped");
  assert.equal(v.clusters.rvcOperationalState.operationalState, 1);
  // A resume the robot refuses is not turned into a plain start: that would clean the whole home.
  await t.report({ ...DOCKED, state: 10, in_cleaning: 3, fan_power: 104, water_box_mode: 200 });
  robot.refuse = { resume_segment_clean: 1 };
  await t.press("rvcOperationalState", "resume");
  assert.deepEqual(t.sent("app_start"), []);
  assert.ok(t.logs.some((l) => /ERR S8: could not resume/.test(l)));
  assert.equal(v.clusters.rvcOperationalState.operationalState, 2, "still paused");
  t.logs.length = 0;
  // Play on a paused clean goes on with it as well.
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  assert.equal(t.sent("resume_segment_clean").length, 3);
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200 });

  // The clean ends by itself: Home shows it, the fan goes off, and the robot's own settings are put back.
  t.platform.vacuums.get(DUID).job.startedAt -= 61000;
  t.byName("Clean מטבח").startedAt -= 61000;
  await t.report({ ...DOCKED, state: 8, in_cleaning: 0, fan_power: 104, water_box_mode: 200 });
  await t.platform.poll(t.byName("Clean מטבח"));
  await wait(300);
  assert.deepEqual(t.shown(), [0, 65]);
  assert.equal(t.byName("Clean מטבח").running, false);
  assert.equal(t.platform.vacuums.get(DUID).job, null);
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode").slice(-2), [["set_custom_mode", [101]], ["set_water_box_custom_mode", [202]]]);
  assert.equal(v.clusters.serviceArea.currentArea, null);
  assert.deepEqual(t.rooms(), { 17: 3 });
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, [17], "the rooms chosen stay chosen");
  assert.equal(t.home.refused || 0, 0, t.home.lines.join("\n"));
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("no rooms chosen (or all of them): the whole home; mopping sets the water; stop, and send to dock", async () => {
  const robot = { status: { ...DOCKED, water_box_mode: 200 } };
  const routines = [{ id: 9, name: "הכול", steps: [{ kind: "all", segments: [], fanPower: 104, waterBoxMode: 200 }] }];
  const t = await startPlatform({ matterVacuum: true, routines: [{ id: "9", name: "הכול" }], programs: [{ name: "שניהם", rooms: ["מטבח", "סלון"] }] }, robot, { routines });
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [16, 17] });
  await t.press("rvcCleanMode", "changeToMode", { newMode: 2 }); // vacuum and mop
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode", "app_segment_clean", "app_start"), [
    ["set_custom_mode", [104]], // the suction from the plugin settings
    ["set_water_box_custom_mode", [202]], // the robot's water was off
    ["app_start", []],
  ]);
  assert.equal(t.byName("הכול").running, true, "the whole-home routine switch shows it");
  assert.equal(t.byName("שניהם").running, false);
  await t.report({ ...DOCKED, state: 5, in_cleaning: 1, fan_power: 104, water_box_mode: 202 });
  assert.equal(v.clusters.rvcCleanMode.currentMode, 2, "vacuum and mop, as chosen (not the suction level it comes to)");
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 1, 17: 1 }, null]);
  // A robot that says which room it is in: Home follows it.
  await t.report({ ...DOCKED, state: 5, in_cleaning: 1, fan_power: 104, water_box_mode: 202, cleaning_info: { segment_id: 17 } });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 0, 17: 1 }, 17]);
  await t.report({ ...DOCKED, state: 5, in_cleaning: 1, fan_power: 104, water_box_mode: 202, cleaning_info: { segment_id: 16 } });
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 16: 1, 17: 3 }, 16]);
  // Asked to start again while it runs: nothing happens.
  const before = t.robotLog.length;
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  assert.deepEqual(t.robotLog.slice(before).filter((r) => r.method !== "get_status"), []);

  // Mop only, chosen while it runs: suction off, water stays as it is.
  await t.press("rvcCleanMode", "changeToMode", { newMode: 1 });
  assert.deepEqual(t.sent("set_custom_mode").slice(-1), [["set_custom_mode", [105]]]);
  assert.equal(t.sent("set_water_box_custom_mode").length, 1);

  // Stopped from Home (run mode idle): the robot stops where it is, and its own settings come back. The switch goes off.
  t.robotLog.length = 0;
  await t.press("rvcRunMode", "changeToMode", { newMode: 0 });
  assert.deepEqual(t.shown(), [0, 0], "stopped, at once");
  assert.equal(t.byName("הכול").running, false);
  assert.deepEqual(t.rooms(), { 16: 3, 17: 3 });
  robot.status = { ...DOCKED, state: 3, in_cleaning: 0, fan_power: 105, water_box_mode: 202 };
  await wait(3200);
  assert.deepEqual(t.sent("app_stop", "app_charge", "set_custom_mode", "set_water_box_custom_mode"), [
    ["app_stop", []],
    ["set_custom_mode", [101]],
    ["set_water_box_custom_mode", [200]],
  ]);
  // The robot winding down is not taken for a clean started elsewhere.
  await t.report({ ...DOCKED, state: 3, in_cleaning: 0, water_box_mode: 200 });
  assert.ok(!t.said().some((l) => /started outside Apple Home/.test(l)), t.said().join("\n"));
  assert.deepEqual(t.shown(), [0, 0]);

  // "Send to dock" in Home: on its way at once; what Home showed (idle) stays until it is there.
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "goHome");
  assert.deepEqual(t.shown(), [0, 64]);
  await wait(1500);
  assert.deepEqual(t.sent("app_stop", "app_charge"), [["app_charge", []]], "nothing to stop: it was standing still");
  await t.report({ ...DOCKED, state: 6, in_cleaning: 0, water_box_mode: 200 });
  assert.deepEqual(t.shown(), [0, 64]);
  await t.report({ ...DOCKED, state: 8, in_cleaning: 0, water_box_mode: 200 });
  assert.deepEqual(t.shown(), [0, 65]);
  // On the dock already: "send to dock" asks the robot (what is known here may be old), and has nothing to do.
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "goHome");
  assert.deepEqual(t.sent("app_stop", "app_charge"), []);
  assert.equal(t.sent("get_status").length, 1);
  // ... unless the robot turns out to be out and about.
  robot.status = { ...DOCKED, state: 5, in_cleaning: 1 };
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "goHome");
  await wait(1800);
  assert.deepEqual(t.sent("app_stop", "app_charge"), [["app_stop", []], ["app_charge", []]]);
  assert.equal(t.home.refused || 0, 0, t.home.lines.join("\n"));
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("a stop that comes while the clean is still being started is not lost", async () => {
  // The robot takes a while to answer the start.
  const robot = { status: DOCKED, slow: { app_segment_clean: 900 } };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(300);
  assert.deepEqual(t.sent("app_segment_clean").length, 1, "the start is on its way to the robot");
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 0 });
  await wait(1500);
  // Stopped at once, and once more after the robot took the start.
  assert.deepEqual(t.sent("app_segment_clean", "app_stop", "app_charge").map((c) => c[0]), ["app_segment_clean", "app_stop", "app_stop"]);
  assert.equal(t.byName("Clean מטבח").running, false, "the fan never came on");
  assert.equal(t.platform.vacuums.get(DUID).job, null);
  await wait(2500);
  // What the start had already changed is put back.
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode"), [
    ["set_custom_mode", [104]],
    ["set_water_box_custom_mode", [200]],
    ["set_custom_mode", [101]],
    ["set_water_box_custom_mode", [202]],
  ]);
  await t.report({ ...DOCKED });
  assert.deepEqual(t.shown(), [0, 65]);

  // The same with "send to dock": the robot is sent home after it took the start
  // (here the start takes longer than the trip to the dock takes to be sent).
  robot.slow = { app_segment_clean: 2000 };
  t.robotLog.length = 0;
  await t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(300);
  await t.home.command(v.UUID, "rvcOperationalState", "goHome");
  await wait(4500);
  const order = t.sent("app_segment_clean", "app_stop", "app_charge").map((c) => c[0]);
  assert.equal(order[0], "app_segment_clean");
  assert.equal(order.filter((m) => m === "app_stop").length, 2, order.join(" "));
  assert.ok(order.lastIndexOf("app_charge") > order.lastIndexOf("app_stop"), order.join(" "));
  assert.equal(t.byName("Clean מטבח").running, false);
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("two rooms without a fan of their own: no switch is shown, and the clean is still not taken for someone else's", async () => {
  const robot = { status: DOCKED, cleaning: [16, 17] };
  const t = await startPlatform({ matterVacuum: true }, robot);
  await t.published();
  // Only one of the two rooms: a clean of part of the home.
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  // Turn the fan it lit off again, as if no fan matched (a combination that has none).
  const fan = t.byName("Clean סלון");
  assert.equal(fan.running, true);
  clearTimeout(fan.pollTimer);
  t.platform.setRunning(fan, false);
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200 });
  await wait(600);
  assert.deepEqual(t.sent("get_map_v1"), [], "no map is read for the vacuum's own clean");
  assert.ok(!t.said().some((l) => /started outside Apple Home/.test(l)), t.said().join("\n"));
  assert.deepEqual(t.rooms(), { 16: 1 });
  // A fan turned on in Home takes over: the vacuum's clean is over, and its settings are the fan's to put back.
  const kitchen = t.byName("Clean מטבח");
  kitchen.service.getCharacteristic("Active").setFn(1);
  await wait(3000);
  assert.equal(kitchen.running, true);
  assert.equal(t.platform.vacuums.get(DUID).job, null);
  assert.deepEqual(kitchen.restore, { fanPower: 101, waterBoxMode: 202 });
  // Home's line follows: it is the kitchen that is being cleaned now.
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200 });
  assert.deepEqual([t.rooms(), t.vacuum().clusters.serviceArea.currentArea], [{ 17: 1 }, 17]);

  // Sent to the dock from the vacuum while the fan's clean runs: the fan goes off, and what the fan
  // meant to put back (the robot's own suction and water) is still put back.
  t.robotLog.length = 0;
  await t.press("rvcOperationalState", "goHome");
  assert.equal(kitchen.running, false);
  assert.deepEqual(t.shown(), [1, 64], "the run is over when the robot is on the dock");
  await wait(5000);
  assert.deepEqual(t.sent("app_stop", "app_charge", "set_custom_mode", "set_water_box_custom_mode"), [
    ["app_stop", []],
    ["app_charge", []],
    ["set_custom_mode", [101]],
    ["set_water_box_custom_mode", [202]],
  ]);
  t.stop();
});

test("a clean started in the Roborock app still lights its fan, and the vacuum shows it too", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  robot.cleaning = [17];
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200 });
  for (let n = 0; n < 30 && !t.byName("Clean מטבח").running; n++) await wait(100);
  assert.equal(t.byName("Clean מטבח").running, true, t.said().join("\n"));
  assert.deepEqual([...t.shown(), v.clusters.rvcCleanMode.currentMode], [1, 1, 4]);
  // Once the fan is found, Home's line names its room.
  await wait(1200);
  assert.deepEqual([t.rooms(), v.clusters.serviceArea.currentArea], [{ 17: 1 }, 17]);
  // Sent home from the vacuum's tile: the fan goes off.
  await t.press("rvcOperationalState", "goHome");
  assert.equal(t.byName("Clean מטבח").running, false);
  assert.deepEqual(t.shown(), [1, 64]);
  await wait(1800);
  assert.deepEqual(t.sent("app_stop", "app_charge"), [["app_stop", []], ["app_charge", []]]);
  t.stop();
});

test("commands that cannot be done: said in the log, Home is put right again", async () => {
  const robot = { status: DOCKED, refuse: { app_segment_clean: 5 } };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  await assert.rejects(t.home.command(v.UUID, "serviceArea", "selectAreas", { newAreas: [16, 99] }), /room 99 is not on the robot's map/);
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, []);
  await assert.rejects(t.home.command(v.UUID, "rvcRunMode", "changeToMode", { newMode: 5 }), /run mode 5/);
  await assert.rejects(t.home.command(v.UUID, "rvcCleanMode", "changeToMode", { newMode: 7 }), /clean mode 7/);
  await t.press("serviceArea", "selectAreas", { newAreas: [16] });
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  await wait(600);
  assert.ok(t.logs.some((l) => /ERR S8: could not start the clean/.test(l)), t.logs.join("\n"));
  // What was changed for the clean that did not start is put back.
  assert.deepEqual(t.sent("set_custom_mode", "set_water_box_custom_mode"), [
    ["set_custom_mode", [104]],
    ["set_water_box_custom_mode", [200]],
    ["set_custom_mode", [101]],
    ["set_water_box_custom_mode", [202]],
  ]);
  await t.report({ ...DOCKED });
  assert.deepEqual(t.shown(), [0, 65]);
  assert.deepEqual(t.rooms(), {});
  assert.equal(t.platform.vacuums.get(DUID).job, null);
  assert.equal(t.byName("Clean סלון").running, false);
  // Identify makes the robot say where it is.
  v.handlers.identify.identify();
  await wait(200);
  assert.deepEqual(t.sent("find_me"), [["find_me", []]]);
  t.stop();
});
