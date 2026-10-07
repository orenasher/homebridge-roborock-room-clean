"use strict";

/**
 * The robot's map, read in full for drawing: the floor plan (rooms, walls),
 * where the robot and its dock are, the path driven, and the areas marked in
 * the Roborock app (no-go zones, virtual walls, zones being cleaned).
 *
 * Layout (little-endian): a 20-byte header starting with "rr", then blocks of
 * { type u16, header length u16, data length u32, ...header, data }.
 *
 * Positions are in millimetres; one pixel of the floor plan is 50 mm. The
 * floor plan is stored bottom row first (y grows upwards).
 */

const { walkBlocks } = require("./map");

const MM_PER_PIXEL = 50;

const BLOCK = {
  CHARGER: 1,
  IMAGE: 2,
  PATH: 3,
  GOTO_PATH: 4,
  GOTO_PREDICTED_PATH: 5,
  ZONES: 6,
  GOTO_TARGET: 7,
  ROBOT: 8,
  NO_GO: 9,
  VIRTUAL_WALLS: 10,
  CLEANED_ROOMS: 11,
  NO_MOP: 12,
  CARPET_MAP: 17,
  MOP_PATH: 18,
};

// A home is a few hundred pixels a side (the robots' own limit is 1024, about 50 m); anything far beyond is not a floor plan.
const MAX_SIDE = 1536;

// More marked areas or path points than any robot keeps are not drawn: the drawing must stay quick.
const MAX_SHAPES = 64;
const MAX_PATH_POINTS = 60000;

function readPoints(map, start, count) {
  const points = new Float64Array(count * 2);
  for (let i = 0; i < count * 2; i++) points[i] = map.readUInt16LE(start + i * 2);
  return points;
}

/** Shapes of `per` corner coordinates each, as arrays of numbers (mm). */
function readShapes(map, pos, hlength, length, per) {
  if (hlength < 12) return [];
  const count = Math.min(map.readUInt32LE(pos + 8), Math.floor(length / (per * 2)), MAX_SHAPES);
  const shapes = [];
  for (let i = 0; i < count; i++) shapes.push(Array.from(readPoints(map, pos + hlength + i * per * 2, per / 2)));
  return shapes;
}

/**
 * Parse a decrypted and unzipped map. Throws when it is not a map; a map
 * without a floor plan (a robot that has not mapped yet) has `image: null`.
 */
function parseMap(map) {
  const out = {
    image: null, // { top, left, width, height, pixels } - pixels: one byte each, low 3 bits kind (0 outside, 1 wall, else floor), high 5 bits room id
    charger: null, // { x, y, angle } (angle null when not given)
    robot: null,
    path: null, // Float64Array x0, y0, x1, y1, ...
    gotoPath: null,
    predictedPath: null,
    gotoTarget: null, // { x, y }
    mopPath: null, // one byte per path point: 1 while mopping
    zones: [], // [x1, y1, x2, y2] being cleaned
    noGo: [], // [x1, y1, ..., x4, y4]
    noMop: [],
    virtualWalls: [], // [x1, y1, x2, y2]
    carpet: null, // one byte per floor-plan pixel, not 0 where a carpet is
    cleaningRooms: [],
  };
  walkBlocks(map, (type, pos, hlength, length) => {
    const data = pos + hlength;
    switch (type) {
      case BLOCK.IMAGE: {
        if (hlength < 24) break;
        const top = map.readInt32LE(data - 16);
        const left = map.readInt32LE(data - 12);
        const height = map.readInt32LE(data - 8);
        const width = map.readInt32LE(data - 4);
        if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE || width * height > length) break;
        out.image = { top, left, width, height, pixels: map.subarray(data, data + width * height) };
        break;
      }
      case BLOCK.CHARGER:
      case BLOCK.ROBOT: {
        if (length < 8) break;
        const place = { x: map.readInt32LE(data), y: map.readInt32LE(data + 4), angle: length >= 12 ? map.readInt32LE(data + 8) : null };
        if (type === BLOCK.CHARGER) out.charger = place;
        else out.robot = place;
        break;
      }
      case BLOCK.PATH:
      case BLOCK.GOTO_PATH:
      case BLOCK.GOTO_PREDICTED_PATH: {
        // A very long path keeps its newest part.
        const all = Math.floor(length / 4);
        const count = Math.min(all, MAX_PATH_POINTS);
        const points = readPoints(map, data + (all - count) * 4, count);
        if (type === BLOCK.PATH) out.path = points;
        else if (type === BLOCK.GOTO_PATH) out.gotoPath = points;
        else out.predictedPath = points;
        break;
      }
      case BLOCK.GOTO_TARGET:
        if (length >= 4) out.gotoTarget = { x: map.readUInt16LE(data), y: map.readUInt16LE(data + 2) };
        break;
      case BLOCK.ZONES:
        out.zones = readShapes(map, pos, hlength, length, 4);
        break;
      case BLOCK.VIRTUAL_WALLS:
        out.virtualWalls = readShapes(map, pos, hlength, length, 4);
        break;
      case BLOCK.NO_GO:
        out.noGo = readShapes(map, pos, hlength, length, 8);
        break;
      case BLOCK.NO_MOP:
        out.noMop = readShapes(map, pos, hlength, length, 8);
        break;
      case BLOCK.CLEANED_ROOMS: {
        const count = hlength >= 12 ? Math.min(map.readUInt32LE(pos + 8), length) : length;
        const ids = [];
        for (let i = 0; i < count; i++) ids.push(map.readUInt8(data + i));
        out.cleaningRooms = [...new Set(ids)];
        break;
      }
      case BLOCK.CARPET_MAP:
        out.carpet = map.subarray(data, data + length);
        break;
      case BLOCK.MOP_PATH:
        out.mopPath = map.subarray(data, data + length);
        break;
      default:
        break;
    }
    return true;
  });
  if (out.carpet && (!out.image || out.carpet.length < out.image.width * out.image.height)) out.carpet = null;
  if (out.mopPath && (!out.path || out.mopPath.length !== out.path.length / 2)) out.mopPath = null;
  return out;
}

/** True when the map holds a floor plan (checked without reading the whole map). */
function hasFloorPlan(map) {
  let found = false;
  try {
    walkBlocks(map, (type, pos, hlength, length) => {
      if (type !== BLOCK.IMAGE) return true;
      if (hlength >= 24) {
        const height = map.readInt32LE(pos + hlength - 8);
        const width = map.readInt32LE(pos + hlength - 4);
        found = width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= length;
      }
      return false;
    });
  } catch {
    return false;
  }
  return found;
}

/**
 * The carpets marked on a map, with the floor plan they belong to:
 * { width, height, left, top, data }, or null when the map has none.
 * The robot does not send them with every map.
 */
function carpetOf(map) {
  try {
    const parsed = parseMap(map);
    if (!parsed.image || !parsed.carpet) return null;
    const { width, height, left, top } = parsed.image;
    return { width, height, left, top, data: Buffer.from(parsed.carpet.subarray(0, width * height)) };
  } catch {
    return null;
  }
}

module.exports = { parseMap, hasFloorPlan, carpetOf, MM_PER_PIXEL };
