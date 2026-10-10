"use strict";

/**
 * Draws the robot's map as a picture: the rooms in colour with soft edges,
 * walls, the path driven, the robot and its dock, the areas marked in the
 * Roborock app, room names and a status line.
 *
 * Everything is drawn here in plain JavaScript; the colours come from a
 * style (lib/themes.js).
 */

const { Canvas, clamp01 } = require("./canvas");
const { mixColor } = require("./themes");
const { MM_PER_PIXEL } = require("./rrmap");

const PAD = 4; // empty cells kept around the floor plan

/** Room ids of a floor-plan byte. Old robots mark "no rooms" as 31 on every pixel. */
function buildGrid(image, extra, cut) {
  const { width, height, pixels } = image;
  // Specks far from the home (stray readings of the laser) are left out: they would shrink the real plan.
  const keep = new Uint8Array(width * height);
  const groups = [];
  const stackAll = [];
  for (let start = 0; start < width * height; start++) {
    if (!(pixels[start] & 7) || keep[start]) continue;
    const cells = [start];
    keep[start] = 1;
    stackAll.push(start);
    while (stackAll.length) {
      const k = stackAll.pop();
      const x = k % width;
      for (const j of [k - width, k + width, x ? k - 1 : -1, x < width - 1 ? k + 1 : -1, x ? k - width - 1 : -1, x < width - 1 ? k - width + 1 : -1, x ? k + width - 1 : -1, x < width - 1 ? k + width + 1 : -1]) {
        if (j < 0 || j >= width * height || keep[j] || !(pixels[j] & 7)) continue;
        keep[j] = 1;
        cells.push(j);
        stackAll.push(j);
      }
    }
    groups.push(cells);
  }
  const largest = groups.reduce((n, g) => Math.max(n, g.length), 0);
  for (const cells of groups) {
    if (cells.length >= Math.max(40, largest * 0.025)) continue;
    for (const k of cells) keep[k] = 0;
  }
  const beyond = cut ? hideBeyondWalls(image, keep, cut) : null;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  const seen = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!keep[y * width + x]) continue;
      const p = pixels[y * width + x];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if ((p & 7) !== 1) seen.add(p >> 3);
    }
  }
  if (x1 < 0) return null;
  // The robot and the dock are part of the picture even when they stand outside the mapped floor.
  for (const place of extra) {
    if (!place) continue;
    const px = Math.floor(place.x / MM_PER_PIXEL) - image.left;
    const py = Math.floor(place.y / MM_PER_PIXEL) - image.top;
    if (px < -40 || py < -40 || px > width + 40 || py > height + 40) continue; // nonsense position
    x0 = Math.min(x0, px - 4);
    x1 = Math.max(x1, px + 4);
    y0 = Math.min(y0, py - 4);
    y1 = Math.max(y1, py + 4);
  }
  const noRooms = seen.size === 1 && seen.has(31);
  const w = x1 - x0 + 1 + PAD * 2;
  const h = y1 - y0 + 1 + PAD * 2;
  const inside = new Uint8Array(w * h);
  const wall = new Uint8Array(w * h);
  const room = new Uint8Array(w * h); // room id of floor cells (0: floor that belongs to no room)
  for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      const p = pixels[y * width + x];
      const kind = p & 7;
      if (!kind || !keep[y * width + x]) continue;
      const k = (y - y0 + PAD) * w + (x - x0 + PAD);
      inside[k] = 1;
      if (kind === 1) wall[k] = 1;
      else room[k] = noRooms ? 0 : p >> 3;
    }
  }
  // Small specks of "wall" in the middle of a room are chair and table legs, not walls: they are drawn faintly.
  const clutter = new Uint8Array(w * h);
  const seenWall = new Uint8Array(w * h);
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!wall[start] || seenWall[start]) continue;
    const cells = [];
    let outer = false;
    stack.push(start);
    seenWall[start] = 1;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      for (const j of [k - 1, k + 1, k - w, k + w, k - w - 1, k - w + 1, k + w - 1, k + w + 1]) {
        if (j < 0 || j >= w * h) continue;
        if (!inside[j]) outer = true; // touches the outside: part of the outline
        else if (wall[j] && !seenWall[j]) {
          seenWall[j] = 1;
          stack.push(j);
        }
      }
    }
    if (!outer && cells.length <= 14) {
      for (const k of cells) {
        clutter[k] = 1;
        wall[k] = 0;
      }
    }
  }
  return { w, h, inside, wall, clutter, room, originX: x0 - PAD, originY: y0 - PAD, beyond };
}

/**
 * Leave out what lies beyond a virtual wall (a line drawn in the Roborock
 * app): typically what the robot's laser saw through a window or in a
 * mirror, which shows as a patch of floor outside the home.
 *
 * Two things count as "beyond", both measured from where the robot is known
 * to stand (its dock, the robot itself):
 *  - floor the robot could drive to if the wall was not there, and cannot
 *    with it (a wall across a doorway or through a room);
 *  - anything that hangs on to the home only across the wall, real walls
 *    included (a patch outside a window: the window itself is a wall on
 *    the map, so the robot never could drive there).
 *
 * Only a piece of a room is ever left out. A room that lies beyond a wall
 * as a whole is a real room that was closed off, and stays on the map. When
 * the walls would take away a large part of the home, something is not as
 * expected and nothing is left out.
 *
 * `cut`: { walls: [[x1, y1, x2, y2] in mm], from: [{ x, y } in mm] }.
 * Returns { walls, cells }: how many walls there are and how many floor
 * cells were left out.
 */
function hideBeyondWalls(image, keep, cut) {
  const { width, height, pixels, left, top } = image;
  const size = width * height;
  const walls = (cut.walls || []).filter((line) => Array.isArray(line) && line.length >= 4 && line.slice(0, 4).every(Number.isFinite));
  const result = { walls: walls.length, cells: 0 };
  if (!walls.length) return result;
  const floor = (k) => keep[k] && (pixels[k] & 7) > 1;
  // Cells the walls run through. A little thicker and longer than drawn, so nothing slips past diagonally or at the ends.
  const barrier = new Uint8Array(size);
  for (const line of walls) {
    let ax = line[0] / MM_PER_PIXEL - left, ay = line[1] / MM_PER_PIXEL - top;
    let bx = line[2] / MM_PER_PIXEL - left, by = line[3] / MM_PER_PIXEL - top;
    const length = Math.hypot(bx - ax, by - ay);
    if (length > 0) {
      const ex = ((bx - ax) / length) * 2, ey = ((by - ay) / length) * 2;
      ax -= ex;
      ay -= ey;
      bx += ex;
      by += ey;
    }
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const yEnd = Math.min(height - 1, Math.ceil(Math.max(ay, by) + 2));
    const xEnd = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + 2));
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - 2)); y <= yEnd; y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - 2)); x <= xEnd; x++) {
        const wx = x + 0.5 - ax, wy = y + 0.5 - ay;
        const t = len2 ? Math.min(1, Math.max(0, (wx * dx + wy * dy) / len2)) : 0;
        if (Math.hypot(wx - dx * t, wy - dy * t) <= 1) barrier[y * width + x] = 1;
      }
    }
  }
  // Where the robot is known to be able to stand: the floor cell at (or right next to) its dock or itself.
  const starts = [];
  for (const place of cut.from || []) {
    if (!place) continue;
    const px = Math.floor(place.x / MM_PER_PIXEL) - left, py = Math.floor(place.y / MM_PER_PIXEL) - top;
    let best = -1, bestFar = Infinity;
    for (let y = Math.max(0, py - 8); y <= Math.min(height - 1, py + 8); y++) {
      for (let x = Math.max(0, px - 8); x <= Math.min(width - 1, px + 8); x++) {
        const k = y * width + x;
        const far = Math.hypot(x - px, y - py);
        if (floor(k) && !barrier[k] && far < bestFar) {
          best = k;
          bestFar = far;
        }
      }
    }
    if (best >= 0) starts.push(best);
  }
  if (!starts.length) return result;
  // What can be got to from there. `throughWalls`: real walls are no obstacle and steps may be diagonal
  // (what hangs together at all); otherwise over floor only, in straight steps (where the robot can drive).
  const reach = (blocked, throughWalls) => {
    const seen = new Uint8Array(size);
    const stack = [];
    for (const k of starts) {
      seen[k] = 1;
      stack.push(k);
    }
    while (stack.length) {
      const k = stack.pop();
      const x = k % width;
      const l = x ? k - 1 : -1, r = x < width - 1 ? k + 1 : -1;
      const next = throughWalls ? [k - width, k + width, l, r, l < 0 ? -1 : l - width, l < 0 ? -1 : l + width, r < 0 ? -1 : r - width, r < 0 ? -1 : r + width] : [k - width, k + width, l, r];
      for (const j of next) {
        if (j < 0 || j >= size || seen[j] || !keep[j] || (!throughWalls && !floor(j)) || (blocked && barrier[j])) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    return seen;
  };
  const gone = new Uint8Array(size);
  let total = 0, count = 0;
  for (let k = 0; k < size; k++) if (floor(k)) total++;
  for (const throughWalls of [false, true]) {
    const walled = reach(true, throughWalls);
    const open = reach(false, throughWalls);
    // Per room: how much of its floor is still within reach.
    const reached = new Map();
    for (let k = 0; k < size; k++) if (walled[k] && floor(k)) reached.set(pixels[k] >> 3, (reached.get(pixels[k] >> 3) || 0) + 1);
    for (let k = 0; k < size; k++) {
      if (gone[k] || !floor(k) || !open[k] || walled[k] || barrier[k]) continue; // within reach, or never was
      const id = pixels[k] >> 3;
      if (id && id !== 31 && !reached.get(id)) continue; // a whole room beyond the wall: it stays
      gone[k] = 1;
      count++;
    }
  }
  if (!count || count > total * 0.4) return result;
  // The strip the wall itself runs through belongs to the side it touches: cells of it that
  // touch only what was left out go too (again and again: the strip is two or three cells deep).
  const touches = (k, test) => {
    const x = k % width;
    for (const j of [k - width, k + width, x ? k - 1 : -1, x < width - 1 ? k + 1 : -1, x ? k - width - 1 : -1, x ? k + width - 1 : -1, x < width - 1 ? k - width + 1 : -1, x < width - 1 ? k + width + 1 : -1]) {
      if (j >= 0 && j < size && test(j)) return true;
    }
    return false;
  };
  for (let pass = 0; pass < 3; pass++) {
    const more = [];
    for (let k = 0; k < size; k++) {
      if (!barrier[k] || gone[k] || !floor(k)) continue;
      if (touches(k, (j) => gone[j]) && !touches(k, (j) => floor(j) && !gone[j] && !barrier[j])) more.push(k);
    }
    if (!more.length) break;
    for (const k of more) {
      gone[k] = 1;
      count++;
    }
  }
  for (let k = 0; k < size; k++) if (gone[k]) keep[k] = 0;
  // The walls around what was left out go with it: wall cells that now have no floor near them.
  const near = (k, test) => {
    const x = k % width, y = (k - x) / width;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) if (test(yy * width + xx)) return true;
    }
    return false;
  };
  const drop = [];
  for (let k = 0; k < size; k++) {
    if (!keep[k] || (pixels[k] & 7) !== 1) continue;
    if (near(k, (j) => gone[j]) && !near(k, (j) => floor(j))) drop.push(k);
  }
  for (const k of drop) keep[k] = 0;
  result.cells = count;
  return result;
}

/** Which rooms touch (also across a wall), for giving neighbours different colours. */
function neighbours(grid) {
  const { w, h, wall, room, inside } = grid;
  const pairs = new Map(); // id -> Set of ids
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!pairs.has(a)) pairs.set(a, new Set());
    if (!pairs.has(b)) pairs.set(b, new Set());
    pairs.get(a).add(b);
    pairs.get(b).add(a);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const a = room[k];
      if (!a) continue;
      // Look right and down, through up to three wall cells.
      for (const step of [1, w]) {
        let j = k;
        for (let n = 0; n < 4; n++) {
          j += step;
          if (j >= w * h || !inside[j]) break;
          if (wall[j]) continue;
          link(a, room[j]);
          break;
        }
      }
    }
  }
  return pairs;
}

/** For every room: how many cells it has and the spot deepest inside it (where its name goes). */
function roomSpots(grid) {
  const { w, h, wall, room, inside } = grid;
  const depth = new Uint16Array(w * h);
  const same = (k, j) => inside[j] && !wall[j] && room[j] === room[k];
  const BIG = 60000;
  for (let k = 0; k < w * h; k++) depth[k] = inside[k] && !wall[k] ? BIG : 0;
  // Two sweeps: distance (3 per step, 4 per diagonal step) to the nearest cell that is not this room.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (!depth[k]) continue;
      let d = BIG;
      d = Math.min(d, (same(k, k - 1) ? depth[k - 1] : 0) + 3, (same(k, k - w) ? depth[k - w] : 0) + 3);
      d = Math.min(d, (same(k, k - w - 1) ? depth[k - w - 1] : 0) + 4, (same(k, k - w + 1) ? depth[k - w + 1] : 0) + 4);
      depth[k] = d;
    }
  }
  for (let y = h - 2; y > 0; y--) {
    for (let x = w - 2; x > 0; x--) {
      const k = y * w + x;
      if (!depth[k]) continue;
      let d = depth[k];
      d = Math.min(d, (same(k, k + 1) ? depth[k + 1] : 0) + 3, (same(k, k + w) ? depth[k + w] : 0) + 3);
      d = Math.min(d, (same(k, k + w + 1) ? depth[k + w + 1] : 0) + 4, (same(k, k + w - 1) ? depth[k + w - 1] : 0) + 4);
      depth[k] = d;
    }
  }
  const spots = new Map(); // id -> { cells, sumX, sumY, best, x, y }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const id = room[k];
      if (!id) continue;
      let spot = spots.get(id);
      if (!spot) spots.set(id, (spot = { id, cells: 0, sumX: 0, sumY: 0, best: 0, picks: [] }));
      spot.cells++;
      spot.sumX += x;
      spot.sumY += y;
      if (depth[k] > spot.best) spot.best = depth[k];
    }
  }
  // Among the deepest cells, the one nearest the room's middle.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const spot = spots.get(room[k]);
      if (!spot || depth[k] < spot.best * 0.85) continue;
      const far = Math.hypot(x - spot.sumX / spot.cells, y - spot.sumY / spot.cells);
      if (spot.far === undefined || far < spot.far) {
        spot.far = far;
        spot.x = x + 0.5;
        spot.y = y + 0.5;
      }
    }
  }
  for (const spot of spots.values()) spot.depth = spot.best / 3;
  return spots;
}

/** The floor plan's shadow: the plan itself, blurred. */
function blurred(grid) {
  const { w, h, inside } = grid;
  let a = new Float32Array(w * h);
  let b = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) a[k] = inside[k];
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let d = -R; d <= R; d++) {
          const xx = x + d;
          if (xx >= 0 && xx < w) s += a[y * w + xx];
        }
        b[y * w + x] = s / (R * 2 + 1);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let d = -R; d <= R; d++) {
          const yy = y + d;
          if (yy >= 0 && yy < h) s += b[yy * w + x];
        }
        a[y * w + x] = s / (R * 2 + 1);
      }
    }
  }
  return a;
}

const TURNS = {
  0: [1, 0, 0, -1],
  90: [0, 1, 1, 0],
  180: [-1, 0, 0, 1],
  270: [0, -1, -1, 0],
};

/**
 * Picture size for a floor plan: as wide or tall as the plan itself, within
 * what a camera in Apple Home shows well (between 3:4 upright and 16:9 wide).
 */
function pictureSize(planW, planH, longSide, barSpace) {
  const ratio = Math.min(16 / 9, Math.max(3 / 4, planW / (planH * (1 + barSpace))));
  let width = ratio >= 1 ? longSide : longSide * ratio;
  let height = ratio >= 1 ? longSide / ratio : longSide;
  width = Math.round(width / 2) * 2;
  height = Math.round(height / 2) * 2;
  return { width, height };
}

/**
 * Draw a parsed map (lib/rrmap.js).
 *
 * options:
 *   theme       colours (resolveTheme)
 *   rotation    0, 90, 180 or 270 (degrees, clockwise)
 *   size        length of the picture's long side in pixels
 *   rooms       [{ id, name, color }] names (and own colours) of rooms; optional
 *   labels      draw the room names
 *   active      ids of the rooms being cleaned now (the others are toned down)
 *   hideBeyondWalls  leave out the pieces of rooms that lie beyond a virtual wall (see hideBeyondWalls)
 *   carpets     false: carpets are not marked
 *   lastCarpet  { width, height, left, top, data } carpets seen on an earlier map, used when this one has none
 *   status      { items: [{ text, dot, battery }] } short texts for the status line; leave out for a picture without one
 *   rtl         lay the status line out right to left
 *
 * Returns a Canvas, or null when the map holds no floor plan.
 */
function drawMap(map, options = {}) {
  const theme = options.theme;
  const image = map.image;
  const cut = options.hideBeyondWalls ? { walls: map.virtualWalls, from: [map.charger, map.robot] } : null;
  const grid = image ? buildGrid(image, [map.robot, map.charger], cut) : null;
  if (!grid) return null;

  const turn = TURNS[options.rotation] || TURNS[0];
  const [ta, tb, tc, td] = turn;
  const sideways = ta === 0;
  const planW = sideways ? grid.h : grid.w;
  const planH = sideways ? grid.w : grid.h;
  // Room for the status line is kept whenever it is turned on, also while there is nothing to say:
  // the picture must not change its shape when the first status arrives (a live view is running at one size).
  const bar = !!options.status;
  const status = bar && options.status.items && options.status.items.length ? options.status : null;
  const { width, height } = pictureSize(planW, planH, options.size || 1280, bar ? 0.13 : 0);
  const canvas = new Canvas(width, height);
  canvas.background(theme.background[0], theme.background[1]);

  const unit = Math.max(width, height) / 1280; // everything scales with the picture
  const barHeight = bar ? Math.round(72 * unit) : 0;
  const margin = Math.round(22 * unit);
  const areaW = width - margin * 2;
  const areaH = height - margin * 2 - (barHeight ? barHeight + Math.round(10 * unit) : 0);
  const scale = Math.min(areaW / planW, areaH / planH, 14 * unit);
  // Cell (gx, gy) of the grid -> picture: X = scale * (ta*gx + tb*gy) + tx.
  const corners = [[0, 0], [grid.w, 0], [0, grid.h], [grid.w, grid.h]].map(([x, y]) => [ta * x + tb * y, tc * x + td * y]);
  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const tx = margin + (areaW - planW * scale) / 2 - minX * scale;
  const ty = margin + (areaH - planH * scale) / 2 - minY * scale;
  const toX = (gx, gy) => scale * (ta * gx + tb * gy) + tx;
  const toY = (gx, gy) => scale * (tc * gx + td * gy) + ty;
  // Millimetres -> picture.
  const mmX = (x, y) => toX(x / MM_PER_PIXEL - image.left - grid.originX, y / MM_PER_PIXEL - image.top - grid.originY);
  const mmY = (x, y) => toY(x / MM_PER_PIXEL - image.left - grid.originX, y / MM_PER_PIXEL - image.top - grid.originY);

  // ----- colours of the rooms
  const spots = roomSpots(grid);
  const ids = [...spots.keys()].sort((a, b) => a - b);
  const near = neighbours(grid);
  const own = new Map((options.rooms || []).filter((r) => r && r.color).map((r) => [Number(r.id), r.color]));
  const paletteIndex = new Map();
  ids.forEach((id, order) => {
    const taken = new Set([...(near.get(id) || [])].map((other) => paletteIndex.get(other)).filter((v) => v !== undefined));
    let pick = order % theme.rooms.length;
    for (let n = 0; n < theme.rooms.length && taken.has(pick); n++) pick = (pick + 1) % theme.rooms.length;
    paletteIndex.set(id, pick);
  });
  const active = new Set((options.active || []).map(Number).filter((id) => spots.has(id)));
  const backdrop = mixColor(theme.background[0], theme.background[1], 0.5);
  const shade = new Float32Array(256 * 3); // colour per room id; 0 is floor without a room
  const roomColor = new Map();
  for (let id = 0; id < 256; id++) {
    let color = theme.floor;
    if (spots.has(id)) {
      color = own.get(id) || theme.rooms[paletteIndex.get(id)];
      roomColor.set(id, color);
      if (active.size && !active.has(id)) color = mixColor(color, backdrop, 0.55);
    }
    shade.set(color, id * 3);
  }

  // ----- the floor plan, sampled smoothly from the robot's coarse grid
  const { w: gw, h: gh, inside, wall, clutter, room } = grid;
  // Walls take the colour of the room next to them, so no gap shows under their soft edge.
  const owner = new Int16Array(gw * gh).fill(-1);
  for (let k = 0; k < gw * gh; k++) if (inside[k] && !wall[k]) owner[k] = room[k];
  for (let pass = 0; pass < 3; pass++) {
    const next = owner.slice();
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const k = y * gw + x;
        if (!inside[k] || owner[k] >= 0) continue;
        for (const j of [k - 1, k + 1, k - gw, k + gw, k - gw - 1, k - gw + 1, k + gw - 1, k + gw + 1]) {
          if (owner[j] >= 0) {
            next[k] = owner[j];
            break;
          }
        }
      }
    }
    owner.set(next);
  }
  const shadow = blurred(grid);
  // Carpets: from this map, or (the robot does not send them every time) the ones last seen on the same floor plan.
  let carpet = options.carpets === false ? null : map.carpet;
  const kept = options.carpets === false ? null : options.lastCarpet;
  if (!carpet && kept && kept.width === image.width && kept.height === image.height && kept.left === image.left && kept.top === image.top && kept.data && kept.data.length >= image.width * image.height) carpet = kept.data;
  const data = canvas.data;
  const bx = [toX(0, 0), toX(gw, 0), toX(0, gh), toX(gw, gh)];
  const by = [toY(0, 0), toY(gw, 0), toY(0, gh), toY(gw, gh)];
  const left = Math.max(0, Math.floor(Math.min(...bx)));
  const right = Math.min(width - 1, Math.ceil(Math.max(...bx)));
  const top = Math.max(0, Math.floor(Math.min(...by)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...by)));
  const edge = Math.max(1, scale); // grid weight -> pixels
  const wallGain = Math.max(1, scale * 0.9);
  const dividerHalf = Math.max(0.6, 0.9 * unit);
  const shadowDrop = (6 * unit) / scale; // cells
  const wallColor = theme.walls;
  const divider = theme.divider;
  const slotS = new Int16Array(4);
  const slotW = new Float32Array(4);
  for (let Y = top; Y <= bottom; Y++) {
    for (let X = left; X <= right; X++) {
      const dx = (X + 0.5 - tx) / scale;
      const dy = (Y + 0.5 - ty) / scale;
      const gx = ta * dx + tc * dy - 0.5;
      const gy = tb * dx + td * dy - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      if (i0 < 0 || j0 < 0 || i0 >= gw - 1 || j0 >= gh - 1) continue;
      const wx = gx - i0;
      const wy = gy - j0;
      const k = j0 * gw + i0;
      const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
      const i = (Y * width + X) * 3;

      // shadow, a little below the plan
      const sgx = gx - tc * shadowDrop, sgy = gy - td * shadowDrop;
      const si = Math.floor(sgx), sj = Math.floor(sgy);
      if (si >= 0 && sj >= 0 && si < gw - 1 && sj < gh - 1) {
        const fx = sgx - si, fy = sgy - sj, sk = sj * gw + si;
        const sv = (shadow[sk] * (1 - fx) + shadow[sk + 1] * fx) * (1 - fy) + (shadow[sk + gw] * (1 - fx) + shadow[sk + gw + 1] * fx) * fy;
        if (sv > 0.004) {
          const a = sv * theme.shadowOpacity;
          data[i] += (theme.shadow[0] - data[i]) * a;
          data[i + 1] += (theme.shadow[1] - data[i + 1]) * a;
          data[i + 2] += (theme.shadow[2] - data[i + 2]) * a;
        }
      }

      const wIn = inside[k] * w00 + inside[k + 1] * w10 + inside[k + gw] * w01 + inside[k + gw + 1] * w11;
      if (wIn <= 0) continue;
      const aIn = clamp01((wIn - 0.5) * edge + 0.5);
      if (aIn <= 0) continue;

      // the two rooms that share this pixel most
      let n = 0;
      for (let c = 0; c < 4; c++) {
        const cell = c === 0 ? k : c === 1 ? k + 1 : c === 2 ? k + gw : k + gw + 1;
        const o = owner[cell];
        if (o < 0) continue;
        const weight = c === 0 ? w00 : c === 1 ? w10 : c === 2 ? w01 : w11;
        let found = false;
        for (let m = 0; m < n; m++) {
          if (slotS[m] === o) {
            slotW[m] += weight;
            found = true;
            break;
          }
        }
        if (!found) {
          slotS[n] = o;
          slotW[n++] = weight;
        }
      }
      let r, g, b;
      if (!n) {
        r = theme.floor[0];
        g = theme.floor[1];
        b = theme.floor[2];
      } else {
        let first = 0;
        for (let m = 1; m < n; m++) if (slotW[m] > slotW[first]) first = m;
        let second = -1;
        for (let m = 0; m < n; m++) if (m !== first && (second < 0 || slotW[m] > slotW[second])) second = m;
        const a3 = slotS[first] * 3;
        r = shade[a3];
        g = shade[a3 + 1];
        b = shade[a3 + 2];
        if (second >= 0) {
          const apart = ((slotW[first] - slotW[second]) / (slotW[first] + slotW[second])) * edge * 0.5; // pixels from the border between them
          const t = clamp01(apart + 0.5);
          const b3 = slotS[second] * 3;
          r = shade[b3] + (r - shade[b3]) * t;
          g = shade[b3 + 1] + (g - shade[b3 + 1]) * t;
          b = shade[b3 + 2] + (b - shade[b3 + 2]) * t;
          const line = clamp01(dividerHalf - apart + 0.5) * theme.dividerOpacity;
          if (line > 0) {
            r += (divider[0] - r) * line;
            g += (divider[1] - g) * line;
            b += (divider[2] - b) * line;
          }
        }
      }
      if (carpet) {
        // carpets: fine diagonal stripes
        const cx = Math.round(gx) + grid.originX, cy = Math.round(gy) + grid.originY;
        if (cx >= 0 && cy >= 0 && cx < image.width && cy < image.height && carpet[cy * image.width + cx]) {
          const stripe = Math.abs(((X + Y) / (5 * unit)) % 2 - 1);
          const a = clamp01((stripe - 0.55) * 4) * 0.16;
          r += (wallColor[0] - r) * a;
          g += (wallColor[1] - g) * a;
          b += (wallColor[2] - b) * a;
        }
      }
      const wClutter = clutter[k] * w00 + clutter[k + 1] * w10 + clutter[k + gw] * w01 + clutter[k + gw + 1] * w11;
      if (wClutter > 0) {
        const a = clamp01((wClutter - 0.42) * wallGain + 0.5) * 0.28;
        r += (wallColor[0] - r) * a;
        g += (wallColor[1] - g) * a;
        b += (wallColor[2] - b) * a;
      }
      const wWall = wall[k] * w00 + wall[k + 1] * w10 + wall[k + gw] * w01 + wall[k + gw + 1] * w11;
      if (wWall > 0) {
        const a = clamp01((wWall - 0.42) * wallGain + 0.5);
        r += (wallColor[0] - r) * a;
        g += (wallColor[1] - g) * a;
        b += (wallColor[2] - b) * a;
      }
      data[i] += (r - data[i]) * aIn;
      data[i + 1] += (g - data[i + 1]) * aIn;
      data[i + 2] += (b - data[i + 2]) * aIn;
    }
  }

  // ----- areas marked in the Roborock app
  const shape = (corners) => {
    const out = [];
    for (let n = 0; n + 1 < corners.length; n += 2) out.push(mmX(corners[n], corners[n + 1]), mmY(corners[n], corners[n + 1]));
    return out;
  };
  const box = ([x1, y1, x2, y2]) => shape([x1, y1, x2, y1, x2, y2, x1, y2]);
  const lineWidth = Math.max(1.5, 2.5 * unit);
  for (const zone of map.zones) canvas.polygon(box(zone), theme.zone, 0.16, { width: lineWidth, color: theme.zone, opacity: 0.9 });
  for (const zone of map.noMop) canvas.polygon(shape(zone), theme.noMop, 0.2, { width: lineWidth, color: theme.noMop, opacity: 0.9 });
  for (const zone of map.noGo) canvas.polygon(shape(zone), theme.noGo, 0.22, { width: lineWidth, color: theme.noGo, opacity: 0.9 });
  for (const line of map.virtualWalls) canvas.polyline(shape(line), Math.max(2.5, 4 * unit), theme.noGo, 0.95);

  // ----- the path driven
  const track = (points, thickness, opacity) => {
    if (!points || points.length < 2) return;
    const out = [];
    let lastX = NaN, lastY = NaN;
    for (let n = 0; n + 1 < points.length; n += 2) {
      const x = mmX(points[n], points[n + 1]);
      const y = mmY(points[n], points[n + 1]);
      if (Math.abs(x - lastX) + Math.abs(y - lastY) < 0.4) continue; // closer than half a pixel: skip
      out.push((lastX = x), (lastY = y));
    }
    canvas.polyline(out, thickness, theme.path, opacity);
  };
  const pathWidth = Math.max(1.4, Math.min(scale * 0.42, 3.2 * unit));
  track(map.path, pathWidth, theme.pathOpacity);
  track(map.gotoPath, pathWidth, theme.pathOpacity);
  track(map.predictedPath, pathWidth, theme.pathOpacity * 0.45);
  if (map.gotoTarget) {
    const x = mmX(map.gotoTarget.x, map.gotoTarget.y), y = mmY(map.gotoTarget.x, map.gotoTarget.y);
    canvas.circle(x, y, 7 * unit, theme.zone, 0.9);
    canvas.circle(x, y, 3 * unit, theme.robot, 1);
  }

  // ----- dock and robot
  const body = Math.max(scale * 3.5, 13 * unit); // radius: the robot is 35 cm across
  if (map.charger) {
    const x = mmX(map.charger.x, map.charger.y), y = mmY(map.charger.x, map.charger.y);
    const radius = body * 0.82;
    canvas.circle(x, y + 1.5 * unit, radius + 2 * unit, theme.shadow, 0.25);
    canvas.circle(x, y, radius, theme.dock, 1);
    canvas.ring(x, y, radius - 0.75 * unit, 1.5 * unit, theme.robot, 0.9);
    // a lightning bolt
    const u = radius / 10;
    const bolt = [1.2, -6.2, -3.8, 1, -0.6, 1, -1.4, 6.2, 3.8, -1.2, 0.6, -1.2];
    canvas.polygon(bolt.map((v, n) => (n % 2 ? y : x) + v * u), theme.robot, 1);
  }
  if (map.robot) {
    const x = mmX(map.robot.x, map.robot.y), y = mmY(map.robot.x, map.robot.y);
    // Facing: the direction of the last stretch of the path, when there is one.
    let facing = null;
    const path = map.path;
    if (path && path.length >= 4) {
      const n = path.length;
      for (let back = 4; back <= Math.min(n, 40); back += 2) {
        const hx = mmX(path[n - 2], path[n - 1]) - mmX(path[n - back], path[n - back + 1]);
        const hy = mmY(path[n - 2], path[n - 1]) - mmY(path[n - back], path[n - back + 1]);
        if (Math.hypot(hx, hy) > 1.5) {
          facing = Math.atan2(hy, hx);
          break;
        }
      }
    }
    canvas.circle(x, y + 2 * unit, body + 2.5 * unit, theme.shadow, 0.28);
    canvas.circle(x, y, body, theme.robot, 1);
    canvas.ring(x, y, body - unit, 2 * unit, theme.robotRing, 0.95);
    const lx = facing === null ? x : x + Math.cos(facing) * body * 0.3;
    const ly = facing === null ? y : y + Math.sin(facing) * body * 0.3;
    canvas.ring(lx, ly, body * 0.36, Math.max(1.4, 1.8 * unit), theme.robotRing, 0.95);
  }

  // ----- room names
  if (options.labels !== false && options.rooms && options.rooms.length) {
    const names = new Map(options.rooms.map((r) => [Number(r.id), String(r.name || "").trim()]));
    const placed = [];
    const list = [...spots.values()].filter((s) => names.get(s.id) && Canvas.canWrite(names.get(s.id))).sort((a, b) => b.cells - a.cells);
    const base = 25 * unit;
    for (const spot of list) {
      const name = names.get(spot.id);
      let size = base;
      const room = spot.depth * scale * 2.6; // about how wide a name fits
      const natural = Canvas.textWidth(name, size);
      if (natural > room) size = Math.max(base * 0.72, (size * room) / natural);
      const textW = Canvas.textWidth(name, size);
      const padX = size * 0.55, boxH = size * 1.55, boxW = textW + padX * 2;
      const cx = toX(spot.x, spot.y);
      let cy = toY(spot.x, spot.y);
      const clash = (y) => placed.some((p) => Math.abs(p.x - cx) < (p.w + boxW) / 2 + 3 * unit && Math.abs(p.y - y) < (p.h + boxH) / 2 + 3 * unit);
      if (clash(cy)) {
        for (const move of [1, -1, 2, -2]) {
          const y = cy + move * boxH * 0.75;
          if (!clash(y)) {
            cy = y;
            break;
          }
        }
      }
      const x0 = Math.min(Math.max(cx - boxW / 2, 4 * unit), width - boxW - 4 * unit);
      const y0 = Math.min(Math.max(cy - boxH / 2, 4 * unit), height - boxH - 4 * unit);
      placed.push({ x: x0 + boxW / 2, y: y0 + boxH / 2, w: boxW, h: boxH });
      const dim = active.size && !active.has(spot.id) ? 0.6 : 1;
      canvas.roundRect(x0, y0 + 1.5 * unit, boxW, boxH, boxH / 2, theme.shadow, 0.16 * dim);
      canvas.roundRect(x0, y0, boxW, boxH, boxH / 2, theme.textBack, theme.textBackOpacity * dim);
      canvas.text(name, x0 + padX, y0 + boxH / 2 + size * 0.35, size, theme.text, dim);
    }
  }

  // ----- status line
  if (status) drawStatus(canvas, theme, status, { unit, barHeight, margin, rtl: !!options.rtl });
  canvas.roomColors = roomColor; // id -> colour used (before any toning down)
  canvas.beyond = grid.beyond; // { walls, cells } when floor beyond virtual walls was to be left out
  return canvas;
}

const DOTS = { green: [34, 197, 94], blue: [59, 130, 246], amber: [245, 158, 11], red: [239, 68, 68], grey: [148, 163, 184] };

/**
 * The status line at the bottom: a rounded bar with short items, for example
 * "● Cleaning  Kitchen  12 m² · 14 min  🔋 82%".
 * items: [{ text, dot?: colour name, battery?: 0-100 }]
 */
function drawStatus(canvas, theme, status, { unit, barHeight, margin, rtl }) {
  const size = 32 * unit;
  const gap = 26 * unit;
  const padX = 28 * unit;
  const dotR = 8.5 * unit;
  const battW = 64 * unit, battH = 30 * unit;
  const maxWidth = canvas.width - margin * 2;
  let items = status.items.filter((item) => item && (item.text || item.battery != null)).map((item) => ({ ...item, text: Canvas.canWrite(item.text || "") ? item.text || "" : "" }));
  const inner = 11 * unit;
  const partsOf = (item) => {
    const parts = [];
    if (item.dot) parts.push({ kind: "dot", w: dotR * 2 });
    if (item.battery != null) parts.push({ kind: "battery", w: battW });
    if (item.text) parts.push({ kind: "text", w: Canvas.textWidth(item.text, size) });
    return rtl ? parts.reverse() : parts;
  };
  const measure = (item) => partsOf(item).reduce((sum, part) => sum + part.w, 0) + inner * Math.max(0, partsOf(item).length - 1);
  let widths = items.map(measure);
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + padX * 2;
  // Too long for the picture: drop the least important items (they are listed most important first, the battery is kept).
  while (items.length > 1 && total() > maxWidth) {
    let drop = items.length - 1;
    while (drop > 0 && items[drop].keep) drop--;
    if (drop === 0) break;
    items.splice(drop, 1);
    widths.splice(drop, 1);
  }
  const barW = Math.min(maxWidth, total());
  const x0 = (canvas.width - barW) / 2;
  const y0 = canvas.height - margin - barHeight + 4 * unit;
  canvas.roundRect(x0, y0 + 2 * unit, barW, barHeight, barHeight / 2, theme.shadow, 0.18);
  canvas.roundRect(x0, y0, barW, barHeight, barHeight / 2, theme.textBack, Math.min(1, theme.textBackOpacity + 0.08));
  const baseline = y0 + barHeight / 2 + size * 0.35;
  const middle = y0 + barHeight / 2;
  if (rtl) {
    items = items.slice().reverse();
    widths = widths.slice().reverse();
  }
  let x = x0 + padX;
  items.forEach((item, n) => {
    let px = x;
    for (const part of partsOf(item)) {
      if (part.kind === "dot") canvas.circle(px + dotR, middle, dotR, DOTS[item.dot] || DOTS.grey, 1);
      else if (part.kind === "battery") drawBattery(canvas, theme, px, middle - battH / 2, battW, battH, item.battery, unit, item.charging);
      else canvas.text(item.text, px, baseline, size, theme.text, 1);
      px += part.w + inner;
    }
    x += widths[n] + gap;
  });
}

function drawBattery(canvas, theme, x, y, w, h, level, unit, charging) {
  const bodyW = w - 3.5 * unit;
  const line = Math.max(1.6, 2.4 * unit);
  // outline
  const cx = x + bodyW / 2, cy = y + h / 2, r = 6 * unit;
  canvas.paint(x - 2, y - 2, x + bodyW + 2, y + h + 2, (px, py) => {
    const qx = Math.abs(px - cx) - (bodyW / 2 - r);
    const qy = Math.abs(py - cy) - (h / 2 - r);
    return Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r + line / 2) - line / 2;
  }, theme.text, 0.9);
  canvas.roundRect(x + bodyW + 1 * unit, y + h * 0.3, 3.2 * unit, h * 0.4, 1.6 * unit, theme.text, 0.9);
  const pct = Math.max(0, Math.min(100, Number(level) || 0));
  const inner = (bodyW - line * 2 - 2.4 * unit) * (pct / 100);
  const color = charging ? DOTS.green : pct <= 20 ? DOTS.red : theme.text;
  if (inner > 0.5) canvas.roundRect(x + line + 1.8 * unit, y + line + 1.8 * unit, inner, h - line * 2 - 3.6 * unit, 3 * unit, color, 0.95);
  // On the dock: a lightning bolt across the battery, as on an iPhone that is charging.
  if (charging) {
    const bh = h * 0.92, bw = bh * 0.62;
    const left = cx - bw / 2, top = cy - bh / 2;
    const bolt = [[0.64, 0], [0.06, 0.58], [0.44, 0.58], [0.32, 1], [0.94, 0.4], [0.56, 0.4]];
    const points = [];
    for (const [px, py] of bolt) points.push(left + px * bw, top + py * bh);
    canvas.polygon(points, [255, 255, 255], 1, { width: Math.max(1.2, 1.6 * unit), color: theme.shadow || [0, 0, 0], opacity: 0.55 });
  }
}

module.exports = { drawMap, pictureSize };
