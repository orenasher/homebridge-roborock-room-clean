"use strict";

// The map camera: reading the map, drawing it, the camera in Apple Home.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dgram = require("dgram");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const cloud = require("../lib/cloud");
const { parseMap, hasFloorPlan } = require("../lib/rrmap");
const { cleaningSegments } = require("../lib/map");
const { makePicture, statusItems } = require("../lib/picture");
const { resolveTheme, THEMES, COLOR_KEYS, parseColor } = require("../lib/themes");
const { visualOrder, Canvas } = require("../lib/canvas");
const { demoMap, demoRooms } = require("../lib/demo-map");
const { Painter } = require("../lib/painter");
const { MapView } = require("../lib/mapview");
const { PictureCamera, findFfmpeg, ffmpegCandidates } = require("../lib/camera");
const { LOCAL_KEY, DUID, RRIOT, fakeMap, startFakeBroker, fakeHomebridge, readPng } = require("./helpers");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const near = (a, b, by = 3) => a.every((v, i) => Math.abs(v - b[i]) <= by);

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

test("the whole map is read: floor plan, rooms, dock, robot, path", () => {
  const map = parseMap(demoMap({ cleaning: [16] }));
  assert.deepEqual([map.image.width, map.image.height, map.image.left, map.image.top], [131, 101, 400, 400]);
  const rooms = new Set();
  let walls = 0;
  for (const p of map.image.pixels) {
    if ((p & 7) === 1) walls++;
    else if (p & 7) rooms.add(p >> 3);
  }
  assert.deepEqual([...rooms].sort(), [16, 17, 18, 19, 20, 21]);
  assert.ok(walls > 500);
  assert.deepEqual(map.cleaningRooms, [16]);
  assert.equal(map.charger.x, (4 + 400) * 50 + 25);
  assert.ok(map.robot && map.path.length >= 8);
  // The same map still answers the older question (which rooms are being cleaned).
  assert.deepEqual(cleaningSegments(demoMap({ cleaning: [17, 18] })), [17, 18]);
  // A map without a floor plan, and things that are no map.
  assert.equal(parseMap(fakeMap([16])).image, null);
  assert.throws(() => parseMap(Buffer.from("not a map at all, sorry")), /not a Roborock map/);
  // A floor plan that claims to be bigger than the data is not believed.
  const lying = Buffer.from(demoMap());
  lying.writeInt32LE(5000, 20 + 8 + 16); // width
  assert.equal(parseMap(lying).image, null);
  // Cut short anywhere: never an exception from reading past the end.
  const whole = demoMap({ cleaning: [16] });
  for (const cut of [21, 30, 60, 500, whole.length - 30]) assert.doesNotThrow(() => parseMap(whole.subarray(0, cut)));

  // More blocks, as real robots send them: a go-to target, a no-go zone, a virtual wall, and a zone block cut off at the very end.
  const block = (type, header, data) => {
    const head = Buffer.alloc(8 + header.length);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(8 + header.length, 2);
    head.writeUInt32LE(data.length, 4);
    header.copy(head, 8);
    return Buffer.concat([head, data]);
  };
  const u16 = (...v) => Buffer.from(new Uint16Array(v).buffer);
  const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);
  const withBlocks = (...blocks) => {
    const base = demoMap();
    const body = Buffer.concat([base.subarray(20, base.length - 20), ...blocks]);
    const head = Buffer.from(base.subarray(0, 20));
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const more = parseMap(withBlocks(block(7, Buffer.alloc(0), u16(25874, 26218)), block(9, u32(1), u16(1, 2, 3, 4, 5, 6, 7, 8)), block(10, u32(1), u16(10, 20, 30, 40)), block(6, u32(5), u16(1, 2, 3, 4))));
  assert.deepEqual(more.gotoTarget, { x: 25874, y: 26218 });
  assert.deepEqual(more.noGo, [[1, 2, 3, 4, 5, 6, 7, 8]]);
  assert.deepEqual(more.virtualWalls, [[10, 20, 30, 40]]);
  assert.deepEqual(more.zones, [[1, 2, 3, 4]], "a count bigger than the data is not believed");
  const short = parseMap(withBlocks(block(9, Buffer.alloc(0), Buffer.alloc(2))));
  assert.deepEqual(short.noGo, []);
  assert.ok(short.image, "a broken block at the end does not cost the floor plan");
  assert.equal(makePicture(withBlocks(block(9, Buffer.alloc(0), Buffer.alloc(2))), { size: 320 }).hasMap, true);

  assert.equal(hasFloorPlan(demoMap()), true);
  assert.equal(hasFloorPlan(fakeMap([16])), false);
  assert.equal(hasFloorPlan(Buffer.from("no map")), false);
  assert.equal(hasFloorPlan(lying), false);
});

test("drawing: a PNG in the chosen colours, rooms next to each other differ", () => {
  const rooms = demoRooms("en");
  const out = makePicture(demoMap(), { theme: "roborock", rooms, status: { state: 8, battery: 100 }, size: 640 });
  assert.equal(out.hasMap, true);
  const png = readPng(out.png);
  assert.deepEqual([png.width, png.height], [out.width, out.height]);
  assert.equal(Math.max(png.width, png.height), 640);
  assert.ok(png.width % 2 === 0 && png.height % 2 === 0, "video needs even sizes");
  // The corner is background, and every room is drawn in the colour reported for it.
  assert.ok(near(png.at(2, 2), parseColor(THEMES.roborock.background[0]), 6));
  assert.equal(out.rooms.length, 6);
  const colors = new Map(out.rooms.map((r) => [r.name, r.color]));
  assert.equal(new Set(colors.values()).size, 6, "six rooms, six colours");
  let found = 0;
  for (const color of colors.values()) {
    const want = parseColor(color);
    search: for (let y = 0; y < png.height; y += 3) {
      for (let x = 0; x < png.width; x += 3) {
        if (near(png.at(x, y), want, 1)) {
          found++;
          break search;
        }
      }
    }
  }
  assert.equal(found, 6);

  // Another style gives another picture; own colours and a room's own colour are used.
  const dark = makePicture(demoMap(), { theme: "dark", rooms, size: 640 });
  assert.ok(near(readPng(dark.png).at(2, 2), parseColor(THEMES.dark.background[0]), 6));
  const own = makePicture(demoMap(), { theme: "dark", colors: { background: "#102030", walls: "nonsense" }, roomColors: [{ room: "kitchen", color: "#ff00aa" }, { room: "Bedroom", color: "oops" }], rooms, size: 640 });
  assert.ok(near(readPng(own.png).at(2, 2), [0x10, 0x20, 0x30]));
  assert.equal(own.rooms.find((r) => r.name === "Kitchen").color, "#ff00aa");
  assert.equal(own.rooms.find((r) => r.name === "Kitchen").own, true);
  assert.equal(own.rooms.find((r) => r.name === "Bedroom").own, false, "what is not a colour is ignored");
  // An unknown style falls back to the default one.
  assert.deepEqual(makePicture(demoMap(), { theme: "no-such", rooms, size: 640 }).png, makePicture(demoMap(), { rooms, size: 640 }).png);

  // Turned by a quarter, a wide home becomes a tall picture.
  const turned = makePicture(demoMap(), { rotation: 90, rooms, size: 640 });
  assert.ok(out.width > out.height && turned.height > turned.width);
  // Labels and the status line can be left out.
  const bare = makePicture(demoMap(), { rooms, labels: false, statusBar: false, status: { state: 8, battery: 100 }, size: 640 });
  assert.notDeepEqual(bare.png, out.png);

  // While rooms are being cleaned, the others are toned down - unless asked not to.
  const status = { state: 18, battery: 60, clean_area: 9e6, clean_time: 540 };
  const cleaning = makePicture(demoMap({ cleaning: [16] }), { rooms, status, size: 640 });
  const plain = makePicture(demoMap({ cleaning: [16] }), { rooms, status, size: 640, highlight: false });
  assert.notDeepEqual(cleaning.png, plain.png);

  // No map, a map without a floor plan, rubbish: a picture that says so instead of an error.
  for (const nothing of [null, fakeMap([16]), Buffer.from("rubbish")]) {
    const empty = makePicture(nothing, { language: "he", status: { state: 8, battery: 90 } });
    assert.equal(empty.hasMap, false);
    assert.ok(readPng(empty.png).width === 1280);
  }
  // Names the built-in letters cannot write are left out, the rest of the picture is drawn.
  assert.doesNotThrow(() => makePicture(demoMap(), { rooms: [{ segmentId: 16, name: "客厅" }, { segmentId: 17, name: "Küche" }, { segmentId: 18, name: "Спальня" }], size: 640 }));
  assert.equal(Canvas.canWrite("客厅"), false);
  assert.equal(Canvas.canWrite("חדר שינה (הורים) 2 – Küche Спальня"), true);
});

test("floor beyond a virtual wall can be left out; a whole room behind one stays", () => {
  const rooms = demoRooms("en");
  const kitchen = (png) => {
    const want = parseColor(THEMES.roborock.rooms[1]);
    let n = 0;
    for (let y = 0; y < png.height; y += 2) for (let x = 0; x < png.width; x += 2) if (near(png.at(x, y), want, 1)) n++;
    return n / (png.width * png.height);
  };
  // The laser saw "kitchen" through the window: a patch outside the home, a virtual wall across the window.
  const ghost = demoMap({ ghost: true });
  assert.equal(parseMap(ghost).virtualWalls.length, 1);
  const shown = makePicture(ghost, { rooms, size: 640 });
  const hidden = makePicture(ghost, { rooms, size: 640, hideBeyondWalls: true });
  const plain = makePicture(demoMap(), { rooms, size: 640 });
  assert.ok(shown.height > shown.width, "with the patch the picture is tall");
  assert.deepEqual([hidden.width, hidden.height], [plain.width, plain.height], "without it the home fills the picture as if the patch was never there");
  const share = kitchen(readPng(hidden.png));
  assert.ok(Math.abs(share - kitchen(readPng(plain.png))) < 0.005, "the kitchen itself is all there");
  assert.equal(hidden.rooms.length, 6);
  // No virtual wall: the option changes nothing.
  assert.deepEqual(makePicture(demoMap(), { rooms, size: 640, hideBeyondWalls: true }).png, plain.png);

  // Hand-made walls on the plain home.
  const withWalls = (...lines) => {
    const base = demoMap();
    const data = Buffer.from(new Uint16Array(lines.flat().map((v) => (v + 400) * 50 + 25)).buffer);
    const head = Buffer.alloc(12);
    head.writeUInt16LE(10, 0);
    head.writeUInt16LE(12, 2);
    head.writeUInt32LE(data.length, 4);
    head.writeUInt32LE(lines.length, 8);
    const body = Buffer.concat([base.subarray(20, base.length - 20), head, data]);
    const start = Buffer.from(base.subarray(0, 20));
    start.writeUInt32LE(body.length, 4);
    return Buffer.concat([start, body]);
  };
  // A wall across the bedroom door closes off the whole bedroom: a real room, it stays.
  const closed = makePicture(withWalls([44, 36, 44, 48]), { rooms, size: 640, hideBeyondWalls: true });
  assert.equal(closed.rooms.length, 6);
  assert.deepEqual(closed.png, makePicture(withWalls([44, 36, 44, 48]), { rooms, size: 640 }).png);
  // A wall through the middle of the kitchen: the far part of that room is left out.
  const split = makePicture(withWalls([74, 80, 130, 80]), { rooms, size: 640, hideBeyondWalls: true });
  const part = kitchen(readPng(split.png));
  assert.ok(part > share * 0.45 && part < share * 0.8, `only the near part of the kitchen is drawn (${part} of ${share})`);
  // A wall that does not close anything off (it ends in the middle of the room): nothing is left out.
  const open = withWalls([100, 80, 130, 80]);
  assert.deepEqual(makePicture(open, { rooms, size: 640, hideBeyondWalls: true }).png, makePicture(open, { rooms, size: 640 }).png);
  // Walls with nonsense coordinates are no problem.
  assert.doesNotThrow(() => makePicture(withWalls([-399, -399, 900, 900], [5, 5, 5, 5]), { rooms, size: 320, hideBeyondWalls: true }));
});

test("every colour style is complete", () => {
  assert.ok(Object.keys(THEMES).length >= 6);
  for (const name of Object.keys(THEMES)) {
    const theme = resolveTheme(name);
    assert.equal(theme.name, name);
    assert.ok(THEMES[name].title.en && THEMES[name].title.he, `${name} has a name in both languages`);
    for (const key of ["shadow", "floor", "walls", "divider", "path", "robot", "robotRing", "dock", "noGo", "noMop", "zone", "text", "textBack"]) {
      assert.ok(Array.isArray(theme[key]) && theme[key].length === 3 && theme[key].every(Number.isFinite), `${name}.${key}`);
    }
    assert.ok(theme.rooms.length >= 6 && theme.rooms.every((c) => c && c.length === 3), `${name}.rooms`);
    assert.equal(theme.background.length, 2);
    for (const key of COLOR_KEYS) assert.ok(parseColor(key === "background" ? THEMES[name].background[0] : THEMES[name][key]), `${name}.${key} can be replaced`);
  }
  assert.equal(resolveTheme("nope").name, "roborock");
  // Names every object has are not styles.
  for (const odd of ["constructor", "toString", "__proto__", "", null, 5]) assert.equal(resolveTheme(odd).name, "roborock");
  assert.equal(makePicture(demoMap(), { theme: "constructor", language: "toString", size: 320 }).hasMap, true);
  assert.deepEqual(resolveTheme("dark", { walls: "#abc", rooms: ["#010203", "nope"] }).walls, [0xaa, 0xbb, 0xcc]);
  assert.deepEqual(resolveTheme("dark", { rooms: ["#010203", "nope"] }).rooms, [[1, 2, 3]]);
  // Text that would vanish into its own background gets a background it can be read on.
  const clash = resolveTheme("light", { text: "#ffffff" });
  assert.ok(clash.textBack[0] < 60);
});

test("the status line: what the robot does, battery, and the area only once there is some", () => {
  const texts = (status, language = "en") => statusItems(status, null, [], { language }).map((i) => i.text);
  assert.deepEqual(texts({ state: 18, battery: 98, clean_area: 12.4e6, clean_time: 845 }), ["Cleaning", "98%", "12 m² · 14 min"]);
  assert.deepEqual(texts({ state: 6, battery: 98, clean_area: 0.2e6, clean_time: 180 }, "he"), ["חוזר לעגינה", "98%", "3 דק׳"]);
  assert.deepEqual(texts({ state: 8, battery: 100, clean_area: 12e6, clean_time: 845 }), ["Charging", "100%"]);
  assert.deepEqual(texts(null), []);
});

test("Hebrew is written right to left, numbers and Latin words stay readable", () => {
  assert.equal(visualOrder("Kitchen 2").join(""), "Kitchen 2");
  assert.equal(visualOrder("חדר 12").join(""), "12 רדח");
  assert.equal(visualOrder("S8 מנקה").join(""), "הקנמ S8");
  assert.equal(visualOrder("סוללה 82%").join(""), "82% הללוס");
  assert.equal(visualOrder("חדר (הורים)").join(""), "(םירוה) רדח");
  assert.ok(Canvas.textWidth("חדר שינה", 20) > Canvas.textWidth("חדר", 20));
});

test("pictures are drawn off the main thread, with the same result", async () => {
  const painter = new Painter(quiet);
  const options = { theme: "pastel", rooms: demoRooms("he"), language: "he", status: { state: 8, battery: 55 }, size: 480 };
  const [a, b] = await Promise.all([painter.paint(demoMap(), options), painter.paint(null, options)]);
  assert.equal(painter.inline, false, "a worker thread did the drawing");
  assert.deepEqual(a.png, makePicture(demoMap(), options).png);
  assert.equal(a.hasMap, true);
  assert.equal(b.hasMap, false);
  painter.close();
  // Without worker threads the picture is drawn in place.
  const plain = new Painter(quiet);
  plain.inline = true;
  assert.deepEqual((await plain.paint(demoMap(), options)).png, a.png);

  // A drawing that takes far too long is given up; the next one is drawn by a fresh worker.
  const slow = new Painter(quiet);
  slow.jobMs = 1;
  await assert.rejects(slow.paint(demoMap(), options), /took longer/);
  assert.equal(slow.worker, null);
  slow.jobMs = 20000;
  assert.deepEqual((await slow.paint(demoMap(), options)).png, a.png);
  assert.equal(slow.inline, false);
  // A worker that dies gives up what it was drawing (it is not drawn again on the main thread) and is replaced.
  const dying = slow.paint(demoMap(), options);
  dying.catch(() => {});
  for (let n = 0; n < 200 && !slow.jobs.size; n++) await wait(5);
  assert.equal(slow.jobs.size, 1, "the worker has the job");
  slow.worker.emit("error", new Error("out of memory"));
  await assert.rejects(dying, /out of memory/);
  assert.equal(slow.inline, false);
  assert.equal((await slow.paint(null, options)).hasMap, false);
  slow.close();
});

function fakeChannel() {
  const channel = { asked: 0, map: demoMap(), fail: null, onMap: null };
  channel.getMap = async () => {
    channel.asked++;
    if (channel.fail) throw new Error(channel.fail);
    const map = Buffer.from(channel.map);
    if (channel.onMap) channel.onMap(map);
    return map;
  };
  return channel;
}

test("the map is only asked for while somebody is looking, and is kept over a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrc-map-"));
  const file = path.join(dir, "map-x.bin");
  const painter = new Painter(quiet);
  const channel = fakeChannel();
  let status = { state: 8, battery: 100 };
  const said = [];
  const make = () => {
    const view = new MapView({ log: { ...quiet, info: (m) => said.push(m) }, name: "Map", channel, painter, file, options: () => ({ theme: "roborock", rooms: demoRooms("en"), size: 480 }), status: () => status });
    channel.onMap = (map) => view.offer(map);
    return view;
  };
  const view = make();
  assert.equal(view.load(), false);
  await wait(150);
  assert.equal(channel.asked, 0, "nobody looks: the robot is left alone");

  // Home asks for the tile's picture: the map is read once and drawn.
  const first = await view.snapshot();
  assert.equal(channel.asked, 1);
  assert.equal(readPng(first).width, 480);
  assert.ok(view.size.width === 480);
  // Asked again right away: the robot stands still, the same picture is good for a minute.
  assert.equal(await view.snapshot(), first);
  assert.equal(channel.asked, 1);

  // The status changes: the picture is redrawn (new status line) without asking the robot.
  status = { state: 18, battery: 97, clean_area: 2e6, clean_time: 120 };
  view.statusChanged({ state: 8, battery: 100 }, status);
  await view.draw();
  assert.notEqual(view.picture(), first);
  assert.equal(view.moving(), true);

  // Live view while the robot drives: the map is read again and again; it stops when the live view closes.
  view.nextFetchAt = 0;
  view.setLive(true);
  await wait(300);
  assert.equal(channel.asked, 2);
  view.nextFetchAt = 0;
  await wait(1200);
  assert.equal(channel.asked, 3);
  view.setLive(false);
  view.nextFetchAt = 0;
  await wait(1300);
  assert.equal(channel.asked, 3, "live view closed: no more reads");

  // A map without a floor plan (the robot sends those now and then) does not take the picture away.
  const good = view.raw;
  view.offer(fakeMap([16]));
  assert.equal(view.raw, good);

  // The robot stops answering (the Roborock app is open): the last picture stays, the tries thin out, it is said once.
  channel.fail = "no answer";
  const kept = view.picture();
  for (let n = 0; n < 4; n++) {
    view.nextFetchAt = 0;
    await view.snapshot();
  }
  assert.equal(view.picture(), kept);
  assert.equal(said.filter((m) => /not sending its map/.test(m)).length, 1);
  assert.ok(view.nextFetchAt - Date.now() > 30000, "a robot that does not answer is asked less often");
  channel.fail = null;

  // A clean that ends while nobody looks: one last read, so the tile shows how it ended.
  view.watchUntil = 0;
  const before = channel.asked;
  status = { state: 8, battery: 80 };
  view.statusChanged({ state: 6, battery: 80 }, status);
  await wait(3400);
  assert.equal(channel.asked, before + 1);

  // After a restart the kept map is there at once, without asking the robot.
  view.close();
  assert.ok(fs.existsSync(file));
  const again = make();
  assert.equal(again.load(), true);
  const asked = channel.asked;
  again.nextFetchAt = Date.now() + 60000;
  const png = await again.snapshot();
  assert.equal(channel.asked, asked);
  assert.equal(makePicture(zlib.gunzipSync(fs.readFileSync(file)), { size: 480 }).hasMap, true);
  assert.equal(readPng(png).width, 480);
  again.close();

  // A new install with a robot that does not answer: Home's tile refreshes do not turn into a request each.
  const silent = fakeChannel();
  silent.fail = "no answer";
  const fresh = new MapView({ log: quiet, name: "Map", channel: silent, painter, file: path.join(dir, "none.bin"), options: () => ({ size: 320 }), status: () => null });
  for (let n = 0; n < 6; n++) assert.ok(await fresh.snapshot(), "there is always a picture, even if it says there is no map yet");
  assert.equal(silent.asked, 1);

  // A picture that cannot be drawn: said once, not tried again until something changes, and the camera is never without a picture.
  const warned = [];
  const broken = { calls: 0, paint: (map, options) => (broken.calls++, map ? Promise.reject(new Error("boom")) : painter.paint(null, options)) };
  const stuck = new MapView({ log: { ...quiet, warn: (m) => warned.push(m) }, name: "Map", channel: fakeChannel(), painter: broken, file: path.join(dir, "none2.bin"), options: () => ({ size: 320 }), status: () => null });
  stuck.offer(demoMap());
  for (let n = 0; n < 3; n++) await stuck.draw();
  assert.equal(warned.length, 1);
  assert.equal(broken.calls, 2, "one failed drawing, one stand-in picture");
  assert.equal(readPng(stuck.picture()).width, 320);
  stuck.close();
  fresh.close();
  painter.close();
});

test("the camera: published on its own, snapshots, and no live view without ffmpeg", async () => {
  const api = fakeHomebridge(os.tmpdir());
  const png = makePicture(demoMap(), { size: 480 }).png;
  const watching = [];
  const said = [];
  const camera = new PictureCamera({
    api, log: { ...quiet, warn: (m) => said.push(m) }, pluginName: "p", name: "S8 Map", id: "duid-1", info: { model: "S8", serial: "SN1", firmware: "02.16.12" },
    ffmpegPath: "/nonexistent/ffmpeg-for-the-test", snapshot: async () => png, picture: () => png, size: () => ({ width: 480, height: 406 }), watching: (on) => watching.push(on),
  });
  const accessory = camera.publish();
  assert.equal(api.external.length, 1);
  assert.equal(accessory.category, 17);
  assert.equal(accessory.displayName, "S8 Map");
  assert.equal(accessory.controller.options.delegate, camera);
  assert.ok(accessory.controller.options.streamingOptions.video.resolutions.length >= 6);
  // The same robot always gives the same accessory, whatever the camera is called.
  const other = new PictureCamera({ api, log: quiet, pluginName: "p", name: "Renamed", id: "duid-1", info: {}, snapshot: async () => png, picture: () => png, size: () => null });
  assert.equal(other.publish().UUID, accessory.UUID);

  // A wrong ffmpeg path in the settings is passed over, never an error (a folder cannot be run at all).
  assert.ok([null, "ffmpeg"].includes(await findFfmpeg(`${os.tmpdir()}/`)));
  assert.ok([null, "ffmpeg"].includes(await findFfmpeg("bad\0path")));
  assert.equal(ffmpegCandidates(" /opt/x/ffmpeg ", os.tmpdir())[0], "/opt/x/ffmpeg");
  assert.equal(ffmpegCandidates("", "/no/such/folder").pop(), "ffmpeg");
  for (let n = 0; n < 100 && camera.ffmpeg === undefined; n++) await wait(100);
  camera.ffmpeg = null; // this test is about a computer without ffmpeg

  const shot = await new Promise((resolve, reject) => camera.handleSnapshotRequest({ width: 480, height: 270 }, (err, buf) => (err ? reject(err) : resolve(buf))));
  assert.equal(shot, png, "without ffmpeg the snapshot is the PNG itself");
  // A failing snapshot is an error for Home, not a crash.
  camera.snapshot = async () => null;
  await assert.rejects(new Promise((resolve, reject) => camera.handleSnapshotRequest({}, (err, buf) => (err ? reject(err) : resolve(buf)))));
  camera.snapshot = async () => png;

  // What the log said about ffmpeg at start: missing altogether, or not where the settings point.
  assert.equal(said.filter((m) => (hasFfmpeg ? /was not found at/ : /ffmpeg was not found, so/).test(m)).length, 1, said.join("\n"));
  const prepared = await new Promise((resolve, reject) =>
    camera.prepareStream({ sessionID: "s1", targetAddress: "127.0.0.1", video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) } }, (err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.equal(prepared.video.port, 50000);
  assert.ok(prepared.video.ssrc > 0);
  await assert.rejects(new Promise((resolve, reject) => camera.handleStreamRequest({ sessionID: "s1", type: "start", video: { width: 1280, height: 720 } }, (err) => (err ? reject(err) : resolve()))), /ffmpeg/);
  assert.equal(camera.sessions.size, 0);
  assert.deepEqual(watching, []);
  // A live view that is prepared and never started does not stay around for ever.
  await new Promise((resolve) => camera.prepareStream({ sessionID: "s2", targetAddress: "127.0.0.1", video: { port: 50000, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) } }, resolve));
  assert.ok(camera.sessions.get("s2").unused, "it has a timer that forgets it");
  await new Promise((resolve) => camera.handleStreamRequest({ sessionID: "s2", type: "stop" }, resolve));
  assert.equal(camera.sessions.size, 0);
  // Stopping something that is not running is fine.
  await new Promise((resolve) => camera.handleStreamRequest({ sessionID: "nope", type: "stop" }, resolve));
});

test("the camera: live view sends encrypted video and stops cleanly", { skip: hasFfmpeg ? false : "ffmpeg is not installed here" }, async () => {
  const api = fakeHomebridge(os.tmpdir());
  const picture = makePicture(demoMap({ cleaning: [16] }), { size: 640, status: { state: 18, battery: 70 } });
  const watching = [];
  const said = [];
  const log = { ...quiet, warn: (m) => said.push(m) };
  const camera = new PictureCamera({ api, log, pluginName: "p", name: "Map", id: "d", info: {}, snapshot: async () => picture.png, picture: () => picture.png, size: () => ({ width: picture.width, height: picture.height }), watching: (on) => watching.push(on) });
  camera.publish();
  for (let n = 0; n < 50 && camera.ffmpeg === undefined; n++) await wait(100);
  assert.equal(camera.ffmpeg, "ffmpeg");

  // The picture keeps its shape inside what Home asks for, with even sizes.
  const args = camera.streamArguments({ video: { width: 1280, height: 720, fps: 30, max_bit_rate: 299, pt: 99, profile: 2, level: 2, mtu: 1378 } }, { address: "127.0.0.1", port: 1, key: Buffer.alloc(16), salt: Buffer.alloc(14), ssrc: 7 }, { width: 1280, height: 952 });
  assert.ok(args.join(" ").includes("scale=968:720:"));
  assert.ok(args.includes("high") && args.includes("4.0") && args.includes("299k"));

  const socket = dgram.createSocket("udp4");
  const seen = { video: 0, other: 0 };
  socket.on("message", (m) => {
    if ((m[1] & 0x7f) === 99 && m.readUInt32BE(8) === 0x1234567) seen.video++;
    else seen.other++;
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const request = { sessionID: "live", targetAddress: "127.0.0.1", video: { port: socket.address().port, srtp_key: crypto.randomBytes(16), srtp_salt: crypto.randomBytes(14) } };
  await new Promise((resolve, reject) => camera.prepareStream(request, (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve, reject) => camera.handleStreamRequest({ sessionID: "live", type: "start", video: { width: 640, height: 360, fps: 30, max_bit_rate: 300, pt: 99, profile: 1, level: 0, mtu: 1378 } }, (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(watching, [true]);
  // Asked to start once more: still one ffmpeg, one live view.
  const running = camera.sessions.get("live").ffmpeg;
  await new Promise((resolve, reject) => camera.handleStreamRequest({ sessionID: "live", type: "start", video: { width: 640, height: 360 } }, (err) => (err ? reject(err) : resolve())));
  assert.equal(camera.sessions.get("live").ffmpeg, running);
  assert.deepEqual(watching, [true]);
  for (let n = 0; n < 100 && seen.video < 10; n++) await wait(100);
  assert.ok(seen.video >= 10, `video packets arrived (${seen.video})`);
  const child = camera.sessions.get("live").ffmpeg;
  await new Promise((resolve) => camera.handleStreamRequest({ sessionID: "live", type: "stop" }, resolve));
  assert.deepEqual(watching, [true, false]);
  assert.equal(camera.sessions.size, 0);
  for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++) await wait(100);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "ffmpeg is gone");
  assert.deepEqual(said, [], "a wanted stop is not reported as a problem");

  // A live view whose ffmpeg dies by itself is closed on Home's side too.
  await new Promise((resolve, reject) => camera.prepareStream({ ...request, sessionID: "dies" }, (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve, reject) => camera.handleStreamRequest({ sessionID: "dies", type: "start", video: { width: 640, height: 360, max_bit_rate: 300, pt: 99 } }, (err) => (err ? reject(err) : resolve())));
  camera.sessions.get("dies").ffmpeg.kill("SIGKILL");
  for (let n = 0; n < 30 && camera.sessions.size; n++) await wait(100);
  assert.equal(camera.sessions.size, 0);
  assert.deepEqual(camera.controller.forced, ["dies"]);
  assert.deepEqual(watching, [true, false, true, false]);
  assert.equal(said.length, 1);

  // Snapshots: a JPEG, as Home expects, made once per picture.
  const shoot = () => new Promise((resolve, reject) => camera.handleSnapshotRequest({ width: 480, height: 270 }, (err, buf) => (err ? reject(err) : resolve(buf))));
  const jpeg = await shoot();
  assert.deepEqual([jpeg[0], jpeg[1], jpeg[2]], [0xff, 0xd8, 0xff]);
  assert.equal(await shoot(), jpeg);
  // ffmpeg stops working: the PNG itself is sent; it works again: a JPEG again.
  const working = camera.ffmpeg;
  const other = makePicture(demoMap(), { size: 640 });
  camera.snapshot = async () => other.png;
  camera.ffmpeg = `${os.tmpdir()}/`;
  assert.equal(await shoot(), other.png);
  camera.ffmpeg = "/no/such/ffmpeg";
  assert.equal(await shoot(), other.png);
  camera.ffmpeg = working;
  assert.equal((await shoot())[1], 0xd8);
  camera.close();
  socket.close();
});

const HOME = {
  devices: [{ duid: DUID, name: "S8", localKey: LOCAL_KEY, pv: "1.0", productId: "p", sn: "SN123", fv: "02.16.12" }],
  products: [{ id: "p", category: "robot.vacuum.cleaner", name: "Roborock S8" }],
  rooms: [{ id: 111, name: "סלון" }, { id: 222, name: "מטבח" }],
};

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
  const log = Object.assign((...a) => logs.push(a.join(" ")), { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push("ERR " + m), debug: (m) => logs.push("DBG " + m) });
  const platform = new api.Platform(log, config, api);
  platform.externalWaits = [0, 300, 300];
  await platform.start();
  const stop = () => {
    api.emit("shutdown");
    broker.close();
  };
  return { platform, api, robotLog, logs, dir, stop };
}

test("the plugin adds the map camera only when asked, and draws the robot's own map in it", async () => {
  // Off (the default): no camera, the robot is never asked for its map.
  const off = await startPlatform({ platform: "RoborockRoomClean" }, { map: demoMap() });
  assert.equal(off.api.external.length, 0);
  assert.equal(off.platform.views.size, 0);
  await wait(300);
  assert.equal(off.robotLog.filter((r) => r.method === "get_map_v1").length, 0);
  const fans = off.api.registered.map((a) => a.displayName).sort();
  off.stop();

  const robot = { map: demoMap({ cleaning: [16] }), status: { state: 8, in_cleaning: 0, fan_power: 102, water_box_mode: 200, battery: 91 } };
  const on = await startPlatform({ platform: "RoborockRoomClean", language: "he", mapCamera: true, mapTheme: "dark", mapRoomColors: [{ room: "מטבח", color: "#ff00aa" }] }, robot);
  try {
    assert.deepEqual(on.api.registered.map((a) => a.displayName).sort().length, fans.length, "the fans and sensors are the same as without the camera");
    assert.equal(on.api.external.length, 1);
    const accessory = on.api.external[0];
    assert.equal(accessory.displayName, "מפת S8");
    assert.equal(accessory.category, 17);
    assert.ok(on.logs.some((m) => /the map camera is ready/.test(m)));
    const camera = accessory.controller.options.delegate;
    for (let n = 0; n < 100 && camera.ffmpeg === undefined; n++) await wait(100);
    camera.ffmpeg = null; // the picture as drawn (a PNG), whether or not this computer has ffmpeg
    // Home asks for the tile: the robot's map is read and drawn, with the room names the plugin knows.
    const shot = await new Promise((resolve, reject) => camera.handleSnapshotRequest({ width: 480, height: 270 }, (err, buf) => (err ? reject(err) : resolve(buf))));
    const png = readPng(shot);
    assert.equal(Math.max(png.width, png.height), 1280);
    assert.equal(on.robotLog.filter((r) => r.method === "get_map_v1").length, 1);
    assert.ok(near(png.at(3, 3), parseColor(THEMES.dark.background[0]), 6), "the chosen style");
    const view = on.platform.views.get(DUID);
    assert.equal(view.raw.equals(robot.map), true);
    // The kitchen (room 17 on the robot) is drawn in the colour given to it by name.
    let pink = 0;
    for (let y = 0; y < png.height; y += 4) for (let x = 0; x < png.width; x += 4) if (near(png.at(x, y), [0xff, 0x00, 0xaa], 1)) pink++;
    assert.ok(pink > 200, `the room's own colour is used (${pink})`);
    // The map is kept for the next start and for the preview in the settings.
    await wait(300);
    assert.ok(fs.existsSync(path.join(on.dir, `map-${DUID}.bin`)));
  } finally {
    on.stop();
  }
});

test("with the map camera on, a clean started in the Roborock app still lights its fan - and its map reaches the camera", async () => {
  const robot = { status: { state: 8, in_cleaning: 0, fan_power: 102, water_box_mode: 200, battery: 91 } };
  const t = await startPlatform({ platform: "RoborockRoomClean", mapCamera: true }, robot);
  try {
    const view = t.platform.views.get(DUID);
    assert.equal(view.raw, null);
    robot.map = demoMap({ cleaning: [17] });
    robot.status = { state: 18, in_cleaning: 3, fan_power: 103, water_box_mode: 200, battery: 90 };
    await t.platform.readStatus(DUID, t.platform.monitors.get(DUID).channel, 0);
    for (let n = 0; n < 40 && !t.logs.some((m) => /started outside Apple Home \(room 17\)/.test(m)); n++) await wait(100);
    assert.ok(t.logs.some((m) => /started outside Apple Home \(room 17\)/.test(m)), t.logs.filter((m) => !m.startsWith("DBG")).join("\n"));
    const fan = [...t.platform.programs.values()].find((p) => p.name === "Clean מטבח");
    assert.equal(fan.running, true);
    // The map read to find that out is the camera's map now: no second request was needed.
    assert.equal(view.raw.equals(robot.map), true);
    assert.equal(t.robotLog.filter((r) => r.method === "get_map_v1").length, 1);
  } finally {
    t.stop();
  }
});
