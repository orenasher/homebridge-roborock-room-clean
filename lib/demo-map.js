"use strict";

/**
 * A made-up home in the robot's own map format. The plugin settings show it
 * in the preview of the colour styles until the robot's real map is there.
 */

const ROOMS = [
  // id, left, bottom, right, top (in map pixels of 5 cm), English and Hebrew name
  { id: 16, box: [2, 50, 76, 98], en: "Living room", he: "סלון" },
  { id: 17, box: [76, 50, 128, 98], en: "Kitchen", he: "מטבח" },
  { id: 18, box: [2, 2, 44, 50], en: "Bedroom", he: "חדר שינה" },
  { id: 19, box: [44, 2, 80, 34], en: "Bathroom", he: "אמבטיה" },
  { id: 20, box: [44, 34, 128, 50], en: "Hallway", he: "מסדרון" },
  { id: 21, box: [80, 2, 128, 34], en: "Kids' room", he: "חדר ילדים" },
];

// Openings between rooms: x, y, width, height, and the room whose floor fills them.
const DOORS = [
  [76, 62, 1, 18, 16], // living room - kitchen (wide opening)
  [54, 50, 10, 1, 16], // living room - hallway
  [44, 38, 1, 8, 20], // bedroom - hallway
  [56, 34, 8, 1, 19], // bathroom - hallway
  [96, 34, 8, 1, 21], // kids' room - hallway
  [100, 50, 10, 1, 17], // kitchen - hallway
];

function block(type, header, data) {
  const head = Buffer.alloc(8 + header.length);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(8 + header.length, 2);
  head.writeUInt32LE(data.length, 4);
  header.copy(head, 8);
  return Buffer.concat([head, data]);
}

function int32(...values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32LE(v, i * 4));
  return b;
}

/**
 * Build a map. `cleaning`: room ids marked as being cleaned (with a path in
 * the first of them); empty: the robot sits on its dock after a clean.
 */
function demoMap({ cleaning = [] } = {}) {
  const width = 131, height = 101, left = 400, top = 400;
  const pixels = Buffer.alloc(width * height);
  const set = (x, y, value) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = value;
  };
  for (const room of ROOMS) {
    const [x0, y0, x1, y1] = room.box;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) set(x, y, x === x0 || x === x1 || y === y0 || y === y1 ? 1 : (room.id << 3) | 7);
    }
  }
  for (const [x, y, w, h, id] of DOORS) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, (id << 3) | 7);
  }
  // A table with four legs in the living room, a bed-side cupboard in the bedroom.
  for (const [x, y] of [[26, 68], [40, 68], [26, 80], [40, 80]]) set(x, y, 1);
  for (let y = 30; y < 40; y++) for (let x = 6; x < 10; x++) set(x, y, 1);

  const mm = (px, py) => [(px + left) * 50 + 25, (py + top) * 50 + 25];
  const dock = mm(4, 90);
  const pathPixels = [];
  const active = ROOMS.find((r) => r.id === cleaning[0]);
  if (active) {
    // Back and forth through the room being cleaned.
    const [x0, y0, x1, y1] = active.box;
    pathPixels.push([6, 90], [x0 + 5, y0 + 5]);
    let leftToRight = true;
    for (let y = y0 + 5; y <= y1 - 5 - (y1 - y0) * 0.35; y += 4) {
      pathPixels.push(leftToRight ? [x0 + 5, y] : [x1 - 5, y], leftToRight ? [x1 - 5, y] : [x0 + 5, y]);
      leftToRight = !leftToRight;
    }
  } else {
    pathPixels.push([90, 42], [59, 42], [59, 56], [20, 60], [6, 90]);
  }
  const path = Buffer.alloc(pathPixels.length * 4);
  pathPixels.forEach(([px, py], i) => {
    const [x, y] = mm(px, py);
    path.writeUInt16LE(x, i * 4);
    path.writeUInt16LE(y, i * 4 + 2);
  });
  const last = pathPixels[pathPixels.length - 1];
  const robot = active ? mm(last[0], last[1]) : mm(7, 90);

  const blocks = Buffer.concat([
    block(2, int32(ROOMS.length, top, left, height, width), pixels),
    block(1, Buffer.alloc(0), int32(dock[0], dock[1], 0)),
    block(8, Buffer.alloc(0), int32(robot[0], robot[1], 0)),
    block(3, int32(pathPixels.length, 0, 0), path),
    block(11, int32(cleaning.length), Buffer.from(cleaning)),
  ]);
  const head = Buffer.alloc(20);
  head.write("rr", 0, "ascii");
  head.writeUInt16LE(20, 2);
  head.writeUInt32LE(blocks.length, 4);
  return Buffer.concat([head, blocks, Buffer.alloc(20)]);
}

/** The rooms of the made-up home, named in the given language: [{ segmentId, name }]. */
function demoRooms(language) {
  return ROOMS.map((room) => ({ segmentId: room.id, name: language === "he" ? room.he : room.en }));
}

module.exports = { demoMap, demoRooms };
