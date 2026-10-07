"use strict";

// Cleans started outside Apple Home (Roborock app, schedule) and the language setting.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cloud = require("../lib/cloud");
const { cleaningSegments, decodeMapAnswer, mapAnswerId } = require("../lib/map");
const { LOCAL_KEY, DUID, RRIOT, fakeMap, mapAnswer, startFakeBroker, fakeHomebridge } = require("./helpers");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = {
  devices: [{ duid: DUID, name: "S8", localKey: LOCAL_KEY, pv: "1.0", productId: "p" }],
  products: [{ id: "p", category: "robot.vacuum.cleaner" }],
  rooms: [{ id: 111, name: "סלון" }, { id: 222, name: "מטבח" }],
};

/** A routine as the Roborock cloud lists it. */
function scene(id, name, method, params) {
  return { id, name, enabled: true, param: JSON.stringify({ triggers: [], action: { type: "S", items: [{ id: 1, type: "CMD", param: JSON.stringify({ id: 1, method, params }) }] } }) };
}

async function startPlatform(config, robot, routines = []) {
  const robotLog = [];
  const broker = await startFakeBroker(robotLog, robot);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "rrc-"));
  const dir = path.join(storage, "roborock-room-clean");
  fs.mkdirSync(dir);
  const rriot = { ...RRIOT, r: { ...RRIOT.r, m: `tcp://127.0.0.1:${broker.address().port}` } };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ email: "a@b.c", baseUrl: "https://x", userData: { token: "t", rriot } }));
  cloud.getHomeData = async () => HOME;
  cloud.getRoutines = async () => routines;
  const api = fakeHomebridge(storage);
  require("../index.js")(api);
  const logs = [];
  const log = Object.assign((...a) => logs.push(a.join(" ")), {
    info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push("ERR " + m), debug: (m) => logs.push("DBG " + m),
  });
  const platform = new api.Platform(log, config, api);
  platform.externalRetryMs = 300;
  platform.dockRetryMs = 150;
  await platform.start();
  const byName = (name) => [...platform.programs.values()].find((p) => p.name === name);
  const stop = () => {
    api.emit("shutdown");
    broker.close();
  };
  return { platform, api, robotLog, logs, byName, stop };
}

test("map: rooms being cleaned are read from the live map", () => {
  assert.deepEqual(cleaningSegments(fakeMap([21, 22, 27])), [21, 22, 27]);
  assert.deepEqual(cleaningSegments(fakeMap([])), []);
  assert.throws(() => cleaningSegments(Buffer.from("not a map at all, sorry")), /not a Roborock map/);
  // A truncated map never reads past its end.
  assert.deepEqual(cleaningSegments(fakeMap([21, 22]).subarray(0, 44)), []);

  const nonce = Buffer.alloc(16, 7);
  const answer = mapAnswer(12345, nonce.toString("hex"), fakeMap([16]));
  assert.equal(mapAnswerId(answer), 12345);
  assert.deepEqual(cleaningSegments(decodeMapAnswer(answer, nonce)), [16]);
  assert.equal(decodeMapAnswer(answer, Buffer.alloc(16, 8)), null, "a map encrypted for someone else is not ours");
  assert.equal(decodeMapAnswer(Buffer.alloc(10), nonce), null);
});

test("routines: rooms and settings are read from the routine", () => {
  const two = scene(5, "x", "do_scenes_segments", {
    data: [
      { tid: "1", segs: [{ sid: 19 }, { sid: 18 }], fan_power: 105, water_box_mode: 201, repeat: 1 },
      { tid: "2", segs: [{ sid: 22 }], fan_power: 102, water_box_mode: 200, repeat: 2 },
    ],
    source: 101,
  });
  assert.deepEqual(cloud.routineSteps(JSON.parse(two.param)), [
    { kind: "segments", segments: [18, 19], fanPower: 105, waterBoxMode: 201, partial: true },
    { kind: "segments", segments: [22], fanPower: 102, waterBoxMode: 200, partial: true },
    { kind: "segments", segments: [18, 19, 22], fanPower: 105, waterBoxMode: 201 },
  ]);
  // One group of rooms: nothing is "a part".
  const one = scene(7, "z", "do_scenes_segments", { data: [{ tid: "1", segs: [{ sid: 21 }, { sid: 22 }], fan_power: 108, water_box_mode: 200 }] });
  assert.deepEqual(cloud.routineSteps(JSON.parse(one.param)), [{ kind: "segments", segments: [21, 22], fanPower: 108, waterBoxMode: 200 }]);
  const all = scene(6, "y", "do_scenes_app_start", [{ fan_power: 104, water_box_mode: 200 }]);
  assert.deepEqual(cloud.routineSteps(JSON.parse(all.param)), [{ kind: "all", fanPower: 104, waterBoxMode: 200 }]);
  assert.deepEqual(cloud.routineSteps(null), []);
  assert.deepEqual(cloud.routineSteps({ action: { items: [{ param: "{broken" }, null] } }), []);
});

test("matching: a part of a bigger routine does not take a plain room clean away from its fan", () => {
  const { RoborockRoomCleanPlatform } = require("../index.js");
  const match = (candidates, rooms, status) => RoborockRoomCleanPlatform.prototype.matchExternal.call({}, candidates, "segments", rooms, status);
  const evening = {
    kind: "routine",
    name: "Evening",
    steps: [
      { kind: "segments", segments: [17], fanPower: 104, waterBoxMode: 200, partial: true },
      { kind: "segments", segments: [16], fanPower: 101, waterBoxMode: 203, partial: true },
      { kind: "segments", segments: [16, 17], fanPower: 104, waterBoxMode: 200 },
    ],
  };
  const kitchenFan = { name: "Clean kitchen", segments: [17] };
  const bothFan = { name: "Both", segments: [17, 16] };
  const all = [kitchenFan, bothFan, evening];
  // Kitchen only, with other settings than the routine's kitchen group: the fan.
  assert.equal(match(all, [17], { fan_power: 102, water_box_mode: 200 }), kitchenFan);
  // Kitchen only, with exactly the routine's kitchen settings: the routine (its first group is running).
  assert.equal(match(all, [17], { fan_power: 104, water_box_mode: 200 }), evening);
  // All rooms of the routine: the routine, whatever the settings, even though a combination has the same rooms.
  assert.equal(match(all, [16, 17], { fan_power: 102, water_box_mode: 201 }), evening);
  // A part of the routine and no fan for it: still the routine.
  assert.equal(match([bothFan, evening], [16], { fan_power: 102, water_box_mode: 200 }), evening);
  // Rooms nobody knows.
  assert.equal(match(all, [30], { fan_power: 102, water_box_mode: 200 }), null);
});

test("a routine started in the Roborock app turns its switch on, and off when it ends", async () => {
  // Docked at first; the routine is started from the Roborock app a moment later.
  const robot = { status: { state: 8, in_cleaning: 0, fan_power: 102, water_box_mode: 200, battery: 90 }, cleaning: [16, 17] };
  const steps = (rooms, fan) => [{ kind: "segments", segments: rooms, fanPower: fan, waterBoxMode: 200 }];
  const routines = [
    { id: 101, name: "מטבח וסלון", steps: steps([16, 17], 104) },
    { id: 102, name: "מטבח וסלון עדין", steps: steps([16, 17], 101) }, // same rooms, other suction
    { id: 103, name: "מטבח", steps: steps([17], 104) },
  ];
  const { platform, robotLog, logs, byName, stop } = await startPlatform(
    { statusInterval: 30, routines: [{ id: "102" }, { id: "101" }, { id: "103" }] },
    robot,
    routines
  );
  const both = byName("מטבח וסלון");
  const gentle = byName("מטבח וסלון עדין");
  const kitchen = byName("מטבח");
  assert.ok(both && gentle && kitchen, "three routine switches");
  await wait(2600); // first status check: on the dock
  assert.equal(robotLog.filter((r) => r.method === "get_map_v1").length, 0, "no map is read while the robot is not cleaning");

  robot.status = { state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 88 };
  platform.monitors.get(DUID).full = null;
  await platform.readStatus(DUID, both.channel);
  await wait(400);
  assert.equal(robotLog.filter((r) => r.method === "get_map_v1").length, 1, "the map is read once");
  assert.equal(both.running, true, "the switch of the routine that is running is on");
  assert.equal(both.service.getCharacteristic("On").value, true);
  assert.equal(gentle.running, false, "same rooms but other suction: stays off");
  assert.equal(kitchen.running, false);
  assert.ok(logs.some((l) => l.includes("started outside Apple Home")), logs.join("\n"));
  assert.deepEqual(robotLog.filter((r) => /^(app_|set_)/.test(r.method)), [], "nothing is sent to the robot");

  // Still cleaning: the same clean is not looked at twice.
  platform.monitors.get(DUID).full = null;
  await platform.poll(both);
  assert.equal(robotLog.filter((r) => r.method === "get_map_v1").length, 1);
  assert.equal(both.running, true);

  // The routine ends: two idle checks in a row turn the switch off, nothing is "restored".
  robot.status = { state: 6, in_cleaning: 0, fan_power: 104, water_box_mode: 200, battery: 70 };
  platform.monitors.get(DUID).full = null;
  await platform.poll(both);
  assert.equal(both.running, true, "one idle check is not enough for a routine");
  platform.monitors.get(DUID).full = null;
  await platform.poll(both);
  assert.equal(both.running, false);
  assert.equal(both.service.getCharacteristic("On").value, false);
  assert.deepEqual(robotLog.filter((r) => /^(app_|set_)/.test(r.method)), []);

  // Turning an adopted switch off in Home stops the robot.
  robot.status = { state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 70 };
  platform.monitors.get(DUID).full = null;
  await platform.readStatus(DUID, both.channel);
  await wait(400);
  assert.equal(both.running, true, "the next outside clean is noticed again");
  both.service.getCharacteristic("On").setFn(false);
  await wait(300);
  assert.equal(both.running, false);
  assert.ok(robotLog.some((r) => r.method === "app_stop"));
  // The robot still says "cleaning" for a moment after the stop: not a new clean.
  platform.monitors.get(DUID).job = null;
  platform.monitors.get(DUID).full = null;
  await platform.readStatus(DUID, both.channel);
  await wait(400);
  assert.equal(both.running, false, "the switch does not jump back on after it was turned off");

  stop();
  assert.ok(!logs.some((l) => l.startsWith("ERR")), logs.join("\n"));
});

test("an outside room clean shows on the fan for those rooms; the plugin's own cleans are left alone", async () => {
  const robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 }, cleaning: [17] };
  const { platform, robotLog, logs, byName, stop } = await startPlatform({ programs: [{ name: "הכול", rooms: ["מטבח", "סלון"] }] }, robot);
  await wait(2800);
  const kitchen = byName("Clean מטבח");
  assert.equal(kitchen.running, true, "the kitchen fan is on");
  assert.equal(kitchen.service.getCharacteristic("Active").value, 1);
  assert.equal(byName("Clean סלון").running, false);
  assert.equal(byName("הכול").running, false);

  // A fan started from Home takes over; the clean it starts is ours, so no map is read for it.
  const maps = () => robotLog.filter((r) => r.method === "get_map_v1").length;
  const before = maps();
  const salon = byName("Clean סלון");
  salon.service.getCharacteristic("Active").setFn(1);
  await wait(3200);
  assert.equal(salon.running, true);
  assert.equal(kitchen.running, false, "only one fan per robot is on");
  robot.status = { state: 8, in_cleaning: 0, fan_power: 104, water_box_mode: 200, battery: 80 };
  platform.monitors.get(DUID).full = null;
  await platform.readStatus(DUID, salon.channel);
  robot.status = { state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 80 };
  platform.monitors.get(DUID).full = null;
  await platform.readStatus(DUID, salon.channel);
  await wait(300);
  assert.equal(maps(), before, "no map read for a clean started from Home");
  assert.equal(salon.running, true);

  stop();
  assert.ok(!logs.some((l) => l.startsWith("ERR")), logs.join("\n"));
});

test("outside cleans: nothing matches, the robot sends no map, or the option is off", async () => {
  // Rooms that no switch or fan covers.
  let robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 }, cleaning: [16, 17] };
  let run = await startPlatform({}, robot);
  await wait(2800);
  assert.ok([...run.platform.programs.values()].every((p) => !p.running));
  assert.ok(run.logs.some((l) => l.includes("no routine switch or fan matches")), run.logs.join("\n"));
  // Every outside clean leaves a first line in the log, whatever comes of it.
  assert.ok(run.logs.some((l) => l.includes("a clean was started outside Apple Home (in_cleaning=3, state=18); finding out what it is.")), run.logs.join("\n"));
  run.stop();

  // The robot answers "ok" but never sends the map: three tries, then give up quietly.
  robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 } };
  run = await startPlatform({}, robot);
  const channel = run.platform.monitors.get(DUID).channel;
  const original = channel.getMap.bind(channel);
  channel.getMap = (ms, attempt) => original(200, attempt);
  await wait(4200);
  assert.equal(run.robotLog.filter((r) => r.method === "get_map_v1").length, 3);
  assert.ok([...run.platform.programs.values()].every((p) => !p.running));
  const failure = run.logs.find((l) => l.includes("did not report which rooms"));
  assert.ok(failure, run.logs.join("\n"));
  // The log says what each try came to, asked both ways, and what the robot's status was.
  assert.match(failure, /Tries: 1\) the robot said ok but sent no map \(own endpoint\); 2\) the robot said ok but sent no map \(account endpoint\); 3\) .*own endpoint/);
  assert.match(failure, /Status: in_cleaning=3, state=18\./);
  assert.equal(channel.cloudTimeouts, 0, "a missing map does not slow the other requests down");
  // The next step of the same routine (idle in between) does not ask again for a while.
  robot.status = { ...robot.status, in_cleaning: 0 };
  run.platform.monitors.get(DUID).full = null;
  await run.platform.readStatus(DUID, channel);
  robot.status = { ...robot.status, in_cleaning: 3 };
  run.platform.monitors.get(DUID).full = null;
  await run.platform.readStatus(DUID, channel);
  await wait(300);
  assert.equal(run.robotLog.filter((r) => r.method === "get_map_v1").length, 3, "no more map requests after the robot sent none");
  run.stop();

  // A fan is used in Home while the plugin is still finding out: the outside clean is dropped.
  robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 } };
  run = await startPlatform({}, robot);
  const ch = run.platform.monitors.get(DUID).channel;
  const plain = ch.getMap.bind(ch);
  ch.getMap = (ms, attempt) => plain(200, attempt);
  await wait(2300); // first try failed, second one is waiting
  run.platform.quiet(DUID); // what turning a fan on and off again in Home does
  robot.cleaning = [17]; // the second try would now find the kitchen
  await wait(900);
  assert.ok([...run.platform.programs.values()].every((p) => !p.running), "nothing is switched on after the user used Home");
  assert.ok(run.logs.some((l) => l.includes("stopped looking into the clean started outside Apple Home")), "and the log says it gave up");
  run.stop();

  // Turned off in the settings.
  robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 }, cleaning: [17] };
  run = await startPlatform({ followExternal: false }, robot);
  await wait(2800);
  assert.equal(run.robotLog.filter((r) => r.method === "get_map_v1").length, 0);
  assert.ok([...run.platform.programs.values()].every((p) => !p.running));
  run.stop();
});

test("a whole-home routine started in the Roborock app turns its switch on", async () => {
  // Whole home: the map marks no rooms.
  const robot = { status: { state: 5, in_cleaning: 1, fan_power: 104, water_box_mode: 200, battery: 80 }, cleaning: [] };
  const routines = [
    { id: 7, name: "מטבח", steps: [{ kind: "segments", segments: [17], fanPower: 104, waterBoxMode: 200 }] },
    { id: 8, name: "כל הבית", steps: [{ kind: "all", fanPower: 104, waterBoxMode: 200 }] },
  ];
  const run = await startPlatform({ routines: [{ id: "7" }, { id: "8" }] }, robot, routines);
  await wait(2800);
  assert.equal(run.byName("כל הבית").running, true);
  assert.equal(run.byName("מטבח").running, false);
  assert.equal(run.robotLog.filter((r) => r.method === "get_map_v1").length, 0, "a whole-home routine is recognised without the map");
  run.stop();
  assert.ok(!run.logs.some((l) => l.startsWith("ERR")), run.logs.join("\n"));
});

test("the robot's own report makes an outside clean show within seconds, over the home network only", async () => {
  const robot = { status: { state: 8, in_cleaning: 0, fan_power: 104, water_box_mode: 200, battery: 100 }, cleaning: [17] };
  const routines = [
    { id: 7, name: "מטבח", steps: [{ kind: "segments", segments: [17], fanPower: 104, waterBoxMode: 200 }] },
    { id: 8, name: "כל הבית", steps: [{ kind: "all", fanPower: 104, waterBoxMode: 200 }] },
  ];
  // The regular check is a minute apart: only the quick reads can notice the clean in time.
  const run = await startPlatform({ statusInterval: 60, routines: [{ id: "7" }, { id: "8" }] }, robot, routines);
  const monitor = run.platform.monitors.get(DUID);
  const channel = monitor.channel;
  // A robot on the home network: every command is answered there.
  let localReads = 0;
  channel.local = {
    host: "10.0.0.9",
    connect: async () => {},
    close() {},
    send: async (method) => {
      if (method === "get_status") localReads++;
      return { result: method === "get_status" ? [robot.status] : ["ok"] };
    },
  };
  await wait(2500); // first regular check: on the dock, read over the home network
  assert.equal(localReads, 1);
  const cloudReads = () => run.robotLog.filter((r) => r.method === "get_status").length;
  const cloudBefore = cloudReads();

  // The routine is pressed in the Roborock app. The robot first reports "starting",
  // and only says "cleaning" a few seconds later.
  robot.status = { ...robot.status, state: 1 };
  channel.onPush({ state: 1 });
  await wait(2000);
  assert.equal(localReads, 2, "looked right after the robot's report");
  assert.equal(run.byName("כל הבית").running, false);
  robot.status = { ...robot.status, state: 5, in_cleaning: 1 };
  await wait(4500);
  assert.equal(run.byName("כל הבית").running, true, "noticed by a quick follow-up read, long before the next regular check");
  assert.ok(run.logs.some((l) => /showing it as on\. \d+s after the robot reported it\./.test(l)), run.logs.join("\n"));
  const readsWhenFound = localReads;
  await wait(4500);
  assert.equal(localReads, readsWhenFound, "the quick reads stop once the clean is recognised");
  assert.equal(cloudReads(), cloudBefore, "none of this went through the cloud");

  // Without a working home-network connection the robot's reports do not cause quick reads.
  run.byName("כל הבית").service.getCharacteristic("On").setFn(false);
  await wait(200);
  monitor.quietUntil = 0;
  monitor.job = null;
  channel.lastVia = "cloud";
  const before = localReads;
  channel.onPush({ state: 3 });
  channel.onPush({ state: 5 });
  await wait(2500);
  assert.equal(localReads, before, "no quick reads when the last command had to go through the cloud");
  run.stop();
  assert.ok(!run.logs.some((l) => l.startsWith("ERR")), run.logs.join("\n"));
});

test("a clean of ours that was stopped long ago does not hide a new one started elsewhere", async () => {
  const robot = { status: { state: 8, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 90 }, cleaning: [17] };
  const run = await startPlatform({}, robot);
  const monitor = run.platform.monitors.get(DUID);
  // The robot kept "not finished" from a clean the plugin stopped; it sits on the dock.
  monitor.job = { ours: true };
  await wait(2600);
  assert.ok([...run.platform.programs.values()].every((p) => !p.running), "docked with an unfinished clean: nothing is shown");
  // Now it is cleaning the kitchen again, and nobody used Home.
  robot.status = { ...robot.status, state: 18 };
  monitor.full = null;
  await run.platform.readStatus(DUID, monitor.channel);
  await wait(400);
  assert.equal(run.byName("Clean מטבח").running, true);
  run.stop();
});

test("map requests: own endpoint and one key, the account's endpoint as second way, retry answers", async () => {
  const account = require("crypto").createHash("md5").update(RRIOT.k).digest().subarray(8, 14).toString("base64");
  // Asked under an endpoint of our own, always with the same key.
  let robot = { cleaning: [17] };
  let run = await startPlatform({}, robot);
  let channel = run.platform.monitors.get(DUID).channel;
  assert.deepEqual(await channel.getCleaningSegments(2000, 1), [17]);
  assert.deepEqual(await channel.getCleaningSegments(2000, 2), [17], "once a way worked it is kept, whatever the attempt number");
  const asked = run.robotLog.filter((r) => r.method === "get_map_v1");
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0].security.endpoint, account);
  assert.equal(asked[0].security.endpoint, asked[1].security.endpoint);
  assert.equal(asked[0].security.nonce, asked[1].security.nonce);
  assert.match(asked[0].security.nonce, /^[0-9a-f]{32}$/);
  // Ordinary commands are sent as before.
  const plain = run.robotLog.find((r) => r.method === "get_room_mapping");
  assert.equal(plain.security.endpoint, account);
  run.stop();

  // A robot that only answers the account's endpoint: the second try asks that way, and it is remembered.
  robot = { status: { state: 18, in_cleaning: 3, fan_power: 102, water_box_mode: 200, battery: 80 }, cleaning: [17], answersMap: (req) => req.security.endpoint === account };
  run = await startPlatform({}, robot);
  channel = run.platform.monitors.get(DUID).channel;
  const original = channel.getMap.bind(channel);
  channel.getMap = (ms, attempt) => original(300, attempt);
  await wait(3400);
  assert.equal(run.byName("Clean מטבח").running, true, run.logs.join("\n"));
  assert.equal(channel.mapShared, true);
  run.stop();

  // "retry" twice, then the map.
  robot = { cleaning: [16], retries: 2 };
  run = await startPlatform({}, robot);
  channel = run.platform.monitors.get(DUID).channel;
  assert.deepEqual(await channel.getCleaningSegments(8000, 1), [16]);
  assert.equal(run.robotLog.filter((r) => r.method === "get_map_v1").length, 3);
  // Nothing but "retry": the reason says so.
  robot.retries = 99;
  await assert.rejects(channel.getMap(2500, 1), /the robot answered "retry" 2 times \(own endpoint\)/);
  run.stop();
});

test("no map, but the robot's status names the room it is in", async () => {
  const robot = { status: { state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 80, cleaning_info: { target_segment_id: -1, segment_id: 17, fan_power: 104 } } };
  const routines = [
    { id: 1, name: "מטבח וסלון", steps: [{ kind: "segments", segments: [16, 17], fanPower: 104, waterBoxMode: 200 }] },
    { id: 2, name: "סלון", steps: [{ kind: "segments", segments: [16], fanPower: 104, waterBoxMode: 200 }] },
  ];
  // No fan for the kitchen alone, and one routine that includes it.
  let run = await startPlatform({ autoRooms: false, routines: [{ id: "1" }, { id: "2" }] }, robot, routines);
  let channel = run.platform.monitors.get(DUID).channel;
  let original = channel.getMap.bind(channel);
  channel.getMap = (ms, attempt) => original(150, attempt);
  await wait(3800);
  assert.equal(run.byName("מטבח וסלון").running, true, run.logs.join("\n"));
  assert.equal(run.byName("סלון").running, false);
  run.stop();
  // With a fan for exactly that room, the fan is the better answer.
  run = await startPlatform({ routines: [{ id: "1" }] }, robot, routines);
  channel = run.platform.monitors.get(DUID).channel;
  original = channel.getMap.bind(channel);
  channel.getMap = (ms, attempt) => original(150, attempt);
  await wait(3800);
  assert.equal(run.byName("Clean מטבח").running, true, run.logs.join("\n"));
  assert.equal(run.byName("מטבח וסלון").running, false);
  run.stop();
});

test("stopping: a robot that refuses to go to the dock for a moment is asked again", async () => {
  // Refused once while it is still stopping, accepted on the second try.
  let robot = { status: { state: 8, in_cleaning: 0, fan_power: 104, water_box_mode: 200, battery: 90 }, refuse: { app_charge: 1 } };
  let run = await startPlatform({}, robot);
  let fan = run.byName("Clean מטבח");
  fan.service.getCharacteristic("Active").setFn(1);
  await wait(1200);
  robot.status = { ...robot.status, state: 18, in_cleaning: 3 };
  fan.service.getCharacteristic("Active").setFn(0);
  await wait(2600);
  assert.equal(run.robotLog.filter((r) => r.method === "app_charge").length, 2);
  assert.ok(!run.logs.some((l) => l.startsWith("ERR")), run.logs.join("\n"));
  run.stop();

  // Refused because it is already on the dock: nothing more to do, and no error.
  robot = { status: { state: 8, in_cleaning: 0, fan_power: 104, water_box_mode: 200, battery: 90 }, refuse: { app_charge: 5 } };
  run = await startPlatform({}, robot);
  fan = run.byName("Clean מטבח");
  fan.service.getCharacteristic("Active").setFn(1);
  await wait(1200);
  fan.service.getCharacteristic("Active").setFn(0);
  await wait(2400);
  assert.equal(run.robotLog.filter((r) => r.method === "app_charge").length, 1);
  assert.ok(!run.logs.some((l) => l.startsWith("ERR")), run.logs.join("\n"));
  run.stop();

  // Refused every time away from the dock: said once, as an error.
  robot = { status: { state: 18, in_cleaning: 3, fan_power: 104, water_box_mode: 200, battery: 90 }, refuse: { app_charge: 9 } };
  run = await startPlatform({ followExternal: false }, robot);
  fan = run.byName("Clean מטבח");
  fan.service.getCharacteristic("Active").setFn(1);
  await wait(3200);
  fan.service.getCharacteristic("Active").setFn(0);
  await wait(2800);
  assert.equal(run.robotLog.filter((r) => r.method === "app_charge").length, 3);
  assert.equal(run.logs.filter((l) => l.startsWith("ERR") && l.includes("action locked")).length, 1, run.logs.join("\n"));
  run.stop();
});

test("language: Hebrew gives Hebrew default names, typed names are kept", async () => {
  const robot = {};
  let run = await startPlatform({ language: "he" }, robot);
  assert.deepEqual(run.api.registered.map((a) => a.displayName).sort(), ["ניקוי מטבח", "ניקוי סלון", "טעינת S8"].sort());
  run.stop();
  run = await startPlatform({ language: "he", nameTemplate: "לנקות {room}", chargingSensorName: "טעינת השואב" }, robot);
  assert.deepEqual(run.api.registered.map((a) => a.displayName).sort(), ["לנקות מטבח", "לנקות סלון", "טעינת השואב"].sort());
  run.stop();
  run = await startPlatform({}, robot);
  assert.deepEqual(run.api.registered.map((a) => a.displayName).sort(), ["Clean מטבח", "Clean סלון", "S8 Charging"].sort());
  run.stop();
});
