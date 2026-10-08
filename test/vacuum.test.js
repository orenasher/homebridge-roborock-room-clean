"use strict";

// The robot as a robot vacuum in Apple Home (Matter): what Home is told about it, and how it is published.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { MatterVacuum, CLEAN_MODES } = require("../lib/vacuum");
const { DUID, fakeHomebridge, addFakeMatter } = require("./helpers");
const { wait, DOCKED, startPlatform } = require("./vacuum-harness");

test("the robot vacuum is added only when asked for, and only where Matter is on", async () => {
  // Not asked for: nothing is published, also where Matter is on.
  const off = await startPlatform({}, { status: DOCKED });
  await wait(300);
  assert.equal(off.home.accessories.size, 0);
  assert.equal(off.platform.vacuums.size, 0);
  const accessories = off.api.registered.map((a) => a.displayName).sort();
  off.stop();

  // Asked for on a bridge without Matter: said once, with what to do; everything else works as before.
  const none = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { matter: false });
  await wait(300);
  assert.equal(none.said().filter((l) => /Matter is not turned on for this plugin's bridge/.test(l)).length, 1, none.said().join("\n"));
  assert.deepEqual(none.api.registered.map((a) => a.displayName).sort(), accessories);
  assert.ok(!none.logs.some((l) => l.startsWith("ERR")));
  none.stop();

  // A Homebridge whose Matter has no robot vacuums.
  const old = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { matter: true });
  old.stop();
  const older = fakeHomebridge(os.tmpdir());
  addFakeMatter(older).deviceTypes = {};
  require("../index.js")(older);
  const lines = [];
  const platform = new older.Platform({ info() {}, warn: (m) => lines.push(m), error: (m) => lines.push(m), debug() {} }, { matterVacuum: true }, older);
  assert.equal(platform.setupMatterVacuum({ duid: "x", name: "R" }, {}, [], false, null), null);
  assert.match(lines[0], /has no robot vacuums in its Matter support/);
});

test("the vacuum Home is told about: rooms, kinds of clean, battery, state", async () => {
  const t = await startPlatform({ matterVacuum: true }, { status: DOCKED });
  const v = await t.published();
  assert.equal(v.displayName, "S8");
  assert.equal(v.manufacturer, "Roborock");
  assert.equal(v.model, "Roborock S8");
  assert.equal(v.serialNumber, "SN123");
  assert.equal(v.firmwareRevision, "02.16.12");
  assert.deepEqual(v.clusters.serviceArea.supportedAreas.map((a) => [a.areaId, a.areaInfo.locationInfo.locationName]), [[16, "סלון"], [17, "מטבח"]]);
  assert.deepEqual(v.clusters.serviceArea.selectedAreas, []);
  // Home is offered the progress per room on the day the vacuum is added, or never.
  assert.deepEqual(t.home.features, { progress: true, cleanModes: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(v.clusters.serviceArea.progress, []);
  // The robot reports a water setting, so mopping is offered; Max+ is not turned on in the settings.
  assert.deepEqual(v.clusters.rvcCleanMode.supportedModes.map((m) => m.mode), [0, 1, 2, 3, 4, 5, 6]);
  // Home names the kinds of clean from the tags: vacuum / mop / both, and quiet / auto / quick / max.
  const tags = Object.fromEntries(v.clusters.rvcCleanMode.supportedModes.map((m) => [m.mode, m.modeTags.map((x) => x.value)]));
  assert.deepEqual(tags, { 0: [16385], 1: [16386], 2: [16385, 16386], 3: [16385, 2], 4: [16385, 0], 5: [16385, 1], 6: [16385, 7] });
  assert.equal(v.clusters.rvcCleanMode.currentMode, 6, "the suction from the plugin settings (max) is the one chosen to start with");
  assert.equal(v.clusters.rvcRunMode.currentMode, 0);
  assert.equal(v.clusters.rvcOperationalState.operationalState, 65, "charging");
  assert.equal(v.clusters.powerSource.batPercentRemaining, 174, "87%, in Matter's half percents");
  // Once after the start the battery is shown as unknown for a moment, then as it is: Home keeps the
  // percentage it read when the vacuum was added until it finds the battery changed.
  const battery = t.home.updates.filter((u) => u.cluster === "powerSource").map((u) => u.attributes.batPercentRemaining);
  assert.deepEqual(battery.slice(0, 2), [null, 174]);
  assert.equal(v.clusters.powerSource.batChargeState, 1);
  assert.ok(t.said().some((l) => /published as a robot vacuum for Apple Home/.test(l) && /Manual Code/.test(l)));
  // The same robot is always the same accessory.
  const uuid = v.UUID;

  // What the robot does shows in Home.
  // A new percentage: again shown as unknown for a moment, then as it is (Home takes it then), at most once a minute.
  t.platform.vacuums.get(DUID).nudgedAt = 0;
  await t.report({ ...DOCKED, state: 100, battery: 100 });
  const again = t.home.updates.filter((u) => u.cluster === "powerSource").map((u) => u.attributes.batPercentRemaining);
  assert.deepEqual(again.slice(-2), [null, 200]);
  assert.equal(v.clusters.rvcOperationalState.operationalState, 66, "docked, full");
  assert.deepEqual([v.clusters.powerSource.batPercentRemaining, v.clusters.powerSource.batChargeState], [200, 2]);
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, fan_power: 103, water_box_mode: 200, battery: 99 });
  assert.deepEqual(t.shown(), [1, 1]);
  assert.equal(v.clusters.rvcCleanMode.currentMode, 5, "while it cleans, the kind of clean is the robot's own (turbo)");
  // Started somewhere else, and which rooms is not known: every room counts as being cleaned, none is named.
  // (With nothing marked as being cleaned Home would say "on its way to the room" for the whole clean.)
  assert.deepEqual(t.rooms(), { 16: 1, 17: 1 });
  assert.equal(v.clusters.serviceArea.currentArea, null);
  await t.report({ ...DOCKED, state: 10, in_cleaning: 3, fan_power: 103, water_box_mode: 200 });
  assert.deepEqual(t.shown(), [1, 2], "paused is still the same run");
  await t.report({ ...DOCKED, state: 22, in_cleaning: 3 });
  assert.deepEqual(t.shown(), [1, 1], "emptying the bin in the middle of a clean is not its end");
  await t.report({ ...DOCKED, state: 12, in_cleaning: 3, error_code: 5 });
  assert.deepEqual([v.clusters.rvcOperationalState.operationalState, v.clusters.rvcOperationalState.operationalError.errorStateId], [3, 65], "stuck");
  await t.report({ ...DOCKED, state: 18, in_cleaning: 3, battery: 15 });
  assert.equal(v.clusters.rvcOperationalState.operationalError.errorStateId, 0);
  assert.equal(v.clusters.powerSource.batChargeLevel, 1, "low battery");
  await t.report({ ...DOCKED, state: 6, in_cleaning: 0 });
  assert.deepEqual(t.shown(), [1, 64], "driving home: the run ends when it is on the dock");
  assert.deepEqual(t.rooms(), { 16: 1, 17: 1 });
  await t.report({ ...DOCKED });
  assert.deepEqual(t.shown(), [0, 65]);
  assert.deepEqual(t.rooms(), { 16: 3, 17: 3 }, "over: every room is done");
  assert.equal(v.clusters.rvcCleanMode.currentMode, 6, "back on the dock: the kind of clean chosen for the next one");
  // Nothing was sent to the robot for any of this, and no map was read: these were cleans of the plugin's own fans or of the app.
  assert.deepEqual(t.sent("app_start", "app_stop", "app_charge", "set_custom_mode"), []);
  // The same status again tells Home nothing new.
  const told = t.home.updates.length;
  await t.report({ ...DOCKED });
  assert.equal(t.home.updates.length, told);
  assert.equal(t.home.refused || 0, 0, t.home.lines.join("\n"));
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));

  // With Max+ in the settings there is one more kind of clean; a name from the settings is used.
  const plus = await startPlatform({ matterVacuum: true, enableMaxPlus: true, suction: "max_plus", matterVacuumName: "שואב" }, { status: DOCKED });
  const p = await plus.published();
  assert.equal(p.UUID, uuid);
  assert.equal(p.displayName, "שואב");
  assert.deepEqual(p.clusters.rvcCleanMode.supportedModes.map((m) => m.mode), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(p.clusters.rvcCleanMode.currentMode, 7);
  plus.stop();
});

test("a robot that does not mop: vacuuming only; and the list of kinds of clean never changes afterwards", async () => {
  const robot = { status: { state: 8, in_cleaning: 0, fan_power: 102, battery: 50 } };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const v = await t.published();
  assert.deepEqual(v.clusters.rvcCleanMode.supportedModes.map((m) => m.mode), [0, 3, 4, 5, 6]);
  await t.press("serviceArea", "selectAreas", { newAreas: [17] });
  await assert.rejects(t.home.command(v.UUID, "rvcCleanMode", "changeToMode", { newMode: 1 }), /not one of this vacuum's/);
  // Started: the water setting is left alone on a robot that has none.
  await t.press("rvcRunMode", "changeToMode", { newMode: 1 });
  assert.deepEqual(t.sent("set_water_box_custom_mode"), []);
  assert.deepEqual(t.sent("app_segment_clean"), [["app_segment_clean", [{ segments: [17], repeat: 2 }]]]);
  t.stop();
  // After a restart the same list is offered, whatever the robot says now; and what was chosen is still chosen.
  const again = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { keepDir: t.dir });
  const a = await again.published();
  assert.deepEqual(a.clusters.rvcCleanMode.supportedModes.map((m) => m.mode), [0, 3, 4, 5, 6]);
  assert.deepEqual(a.clusters.serviceArea.selectedAreas, [17]);
  again.stop();
});

test("a kind of clean that was offered once stays: Homebridge does not bring the vacuum up without the one it kept", async () => {
  const first = await startPlatform({ matterVacuum: true, enableMaxPlus: true }, { status: DOCKED });
  await first.published();
  await first.press("rvcCleanMode", "changeToMode", { newMode: 7 });
  first.stop();
  // Max+ is turned off in the settings. Homebridge still holds "Max+" as the kind of clean chosen.
  const again = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { keepDir: first.dir, setup: (home) => (home.kept = { rvcCleanMode: { currentMode: 7 } }) });
  const a = await again.published();
  assert.deepEqual(a.clusters.rvcCleanMode.supportedModes.map((m) => m.mode), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(a.clusters.rvcCleanMode.currentMode, 7);
  assert.deepEqual(again.home.lines.filter((l) => /Failed/.test(l)), []);
  again.stop();
});

test("what Homebridge kept from before a restart is put right at once", async () => {
  // Before the restart the robot was cleaning the living room, quietly. Now it is on the dock.
  const kept = { rvcRunMode: { currentMode: 1 }, rvcCleanMode: { currentMode: 3 }, rvcOperationalState: { operationalState: 1 }, serviceArea: { currentArea: 16, progress: [{ areaId: 16, status: 1 }] } };
  const t = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { setup: (home) => (home.kept = kept) });
  const v = await t.published();
  assert.deepEqual(t.shown(), [0, 65]);
  assert.equal(v.clusters.rvcCleanMode.currentMode, 6);
  assert.deepEqual([v.clusters.serviceArea.currentArea, v.clusters.serviceArea.progress], [null, []]);
  // An error the robot has when Homebridge starts comes with the first update, not with the registration.
  t.stop();
  const faulty = await startPlatform({ matterVacuum: true }, { status: { ...DOCKED, state: 12, error_code: 5 } });
  const f = await faulty.published();
  assert.deepEqual([f.clusters.rvcOperationalState.operationalState, f.clusters.rvcOperationalState.operationalError.errorStateId], [3, 65]);
  faulty.stop();
});

test("what Homebridge holds is checked: a lost update is told again, a standing error is left alone", async () => {
  const t = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { checkMs: 400 });
  const v = await t.published();
  // Homebridge loses an update (it only writes a line in its own log): the next check puts it right.
  let lost = 0;
  t.home.drop = (cluster) => cluster === "powerSource" && lost++ === 0;
  await t.report({ ...DOCKED, battery: 50 });
  await wait(1300);
  assert.equal(lost, 2, "told once, lost, and told once more");
  assert.equal(v.clusters.powerSource.batPercentRemaining, 100);
  // The same for the state, which is otherwise written only when it changes.
  lost = 0;
  t.home.drop = (cluster, attributes) => cluster === "rvcOperationalState" && "operationalState" in attributes && lost++ === 0;
  await t.report({ ...DOCKED, state: 100, battery: 100 });
  await wait(1300);
  assert.equal(v.clusters.rvcOperationalState.operationalState, 66);
  t.home.drop = null;

  // A standing error is not taken back and raised again by the checks (Home would notify every time).
  await t.report({ ...DOCKED, state: 12, in_cleaning: 0, error_code: 5 });
  assert.deepEqual([v.clusters.rvcOperationalState.operationalState, v.clusters.rvcOperationalState.operationalError.errorStateId], [3, 65]);
  const written = () => t.home.updates.filter((u) => u.cluster === "rvcOperationalState").length;
  const before = written();
  const told = t.home.updates.length;
  await wait(1500);
  assert.equal(written(), before);
  assert.equal(t.home.updates.length, told, "when all is as told, the checks tell nothing");
  assert.equal(v.clusters.rvcOperationalState.operationalError.errorStateId, 65);

  // Something Homebridge turns down every time is not tried for ever.
  t.home.drop = (cluster) => cluster === "powerSource";
  await t.report({ ...DOCKED, state: 100, battery: 99 });
  await wait(4000);
  const tries = t.home.lines.filter((l) => /dropped/.test(l)).length;
  await wait(1300);
  assert.equal(t.home.lines.filter((l) => /dropped/.test(l)).length, tries);
  assert.ok(tries <= 9, `tried ${tries} times`);
  t.stop();
  assert.ok(!t.logs.some((l) => l.startsWith("ERR")), t.logs.join("\n"));
});

test("the vacuum cannot be published: said once, and the rest of the plugin goes on", async () => {
  // Homebridge takes the vacuum and then fails to bring it up: it says so in its own log only.
  const t = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { setup: (home) => (home.failPublish = true) });
  const vacuum = t.platform.vacuums.get(DUID);
  for (let n = 0; n < 80 && !vacuum.failed; n++) await wait(100);
  assert.equal(vacuum.published, false);
  assert.ok(!t.said().some((l) => /published as a robot vacuum/.test(l)), "it does not say it is published when it is not");
  assert.equal(t.said().filter((l) => /ERR S8: Homebridge did not bring the robot vacuum for Apple Home up/.test(l)).length, 1, t.logs.concat(t.home.lines).join("\n"));
  await t.report({ ...DOCKED, battery: 80 });
  await t.report({ ...DOCKED, battery: 79 });
  assert.equal(t.logs.filter((l) => l.startsWith("ERR")).length, 1);
  assert.equal(t.home.lines.filter((l) => /not found/.test(l)).length, 0, "nothing is told about a vacuum that is not there");
  assert.equal(t.byName("Clean מטבח").running, false);
  t.stop();

  // A Homebridge before 2.4.0 cannot be relied on to answer: it is not asked, and the vacuum is taken as published.
  const older = await startPlatform({ matterVacuum: true }, { status: DOCKED }, {
    setup: (home, api) => {
      home.getAccessoryState = async () => undefined;
      api.versionGreaterOrEqual = () => false;
    },
  });
  await older.published();
  older.stop();

  // Matter is on somewhere in this Homebridge, but not for the bridge the plugin runs on.
  const other = await startPlatform({ matterVacuum: true }, { status: DOCKED }, { setup: (home) => (home.ready = false) });
  await wait(300);
  await other.report({ ...DOCKED, battery: 80 });
  await other.report({ ...DOCKED, battery: 79 });
  const errors = other.logs.filter((l) => l.startsWith("ERR"));
  assert.equal(errors.length, 1, other.logs.join("\n"));
  assert.match(errors[0], /could not be published: .*Matter is not enabled on this bridge.*need Matter turned on for the bridge this plugin runs on/);
  other.stop();
});

test("the robot is offline at start, or has no rooms: the vacuum is published once enough is known", async () => {
  const robot = { status: DOCKED };
  const t = await startPlatform({ matterVacuum: true }, robot);
  const host = t.platform.vacuums.get(DUID).host;
  // As if the status had not been read yet.
  const fresh = new MatterVacuum({ ...host, store: { read: () => null, write() {} }, status: () => ({ state: 8, battery: 80, fullAt: 0 }) });
  fresh.start();
  assert.equal(fresh.publishing, false, "whether it mops is not known yet: not published");
  fresh.host.status = () => ({ ...DOCKED, fullAt: Date.now() });
  fresh.statusChanged();
  assert.equal(fresh.publishing, true);
  fresh.close();

  // No rooms: Home does not take a vacuum with an empty list of rooms, so none is published. Said once.
  const lines = [];
  const bare = new MatterVacuum({ ...host, rooms: [], log: { ...host.log, warn: (m) => lines.push(m) }, store: { read: () => null, write() {} } });
  bare.start();
  bare.statusChanged();
  assert.equal(bare.publishing, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /rooms are not known/);
  bare.close();

  // Two rooms with one name, a room without one, a very long one: Matter wants names that differ and fit.
  const odd = new MatterVacuum({
    ...host,
    rooms: [{ segmentId: 16, name: "חדר" }, { segmentId: 17, name: "חדר" }, { segmentId: 18, name: "" }, { segmentId: 16, name: "again" }, { segmentId: 19, name: "ארוך ".repeat(40) }],
    store: { read: () => null, write() {} },
  });
  const areas = odd.clusters().serviceArea.supportedAreas;
  assert.deepEqual(areas.map((a) => a.areaId), [16, 17, 18, 19]);
  assert.deepEqual(areas.slice(0, 3).map((a) => a.areaInfo.locationInfo.locationName), ["חדר", "חדר 2", "Room 18"]);
  assert.ok(Buffer.byteLength(areas[3].areaInfo.locationInfo.locationName) <= 100);
  odd.close();
  t.stop();
});

test("the kinds of clean keep their numbers", () => {
  // Home remembers these numbers from the day the vacuum was added.
  assert.deepEqual(CLEAN_MODES.map((m) => [m.mode, m.fan, m.mop]), [[0, null, false], [1, 105, true], [2, null, true], [3, 101, false], [4, 102, false], [5, 103, false], [6, 104, false], [7, 108, false]]);
});
