"use strict";

/**
 * From the robot's raw map and its status to the finished PNG of the map
 * camera. Used by the camera (in a worker thread, so Homebridge never waits
 * for a drawing) and by the preview in the plugin settings.
 */

const { parseMap } = require("./rrmap");
const { drawMap } = require("./render");
const { Canvas } = require("./canvas");
const { resolveTheme, parseColor } = require("./themes");

const CLEANING = new Set([5, 11, 17, 18]);

const WORDS = {
  en: {
    states: {
      1: "Starting", 2: "Idle", 3: "Idle", 4: "Remote control", 5: "Cleaning", 6: "Returning to the dock", 7: "Remote control",
      8: "Charging", 9: "Charging problem", 10: "Paused", 11: "Cleaning", 12: "Error", 13: "Shutting down", 14: "Updating",
      15: "Returning to the dock", 16: "Going to the target", 17: "Cleaning", 18: "Cleaning", 22: "Emptying the bin",
      23: "Washing the mop", 26: "Going to wash the mop", 29: "Mapping", 100: "Charged",
    },
    area: (m2) => `${m2} m²`,
    minutes: (n) => `${n} min`,
    noMap: "No map yet",
    mapFrom: (time) => `Map from ${time}`,
  },
  he: {
    states: {
      1: "מתחיל", 2: "ממתין", 3: "ממתין", 4: "שליטה ידנית", 5: "מנקה", 6: "חוזר לעגינה", 7: "שליטה ידנית",
      8: "בטעינה", 9: "תקלה בטעינה", 10: "בהשהיה", 11: "מנקה", 12: "תקלה", 13: "נכבה", 14: "מתעדכן",
      15: "חוזר לעגינה", 16: "בדרך ליעד", 17: "מנקה", 18: "מנקה", 22: "מרוקן את המיכל",
      23: "שוטף את המופ", 26: "בדרך לשטיפת המופ", 29: "ממפה", 100: "טעון",
    },
    area: (m2) => `${m2} מ״ר`,
    minutes: (n) => `${n} דק׳`,
    noMap: "אין עדיין מפה",
    mapFrom: (time) => `המפה מ-${time}`,
  },
};

const DOT = { 5: "green", 11: "green", 17: "green", 18: "green", 8: "blue", 100: "blue", 6: "amber", 15: "amber", 10: "amber", 16: "amber", 26: "amber", 22: "amber", 23: "amber", 9: "red", 12: "red" };

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Rooms for the drawing: [{ id, name, color }], with the colours the user gave single rooms (by name or number). */
function roomList(rooms, roomColors) {
  const own = new Map();
  for (const item of Array.isArray(roomColors) ? roomColors : []) {
    const color = item && parseColor(item.color);
    if (color && item.room != null) own.set(norm(item.room), color);
  }
  return (Array.isArray(rooms) ? rooms : []).filter((r) => r && typeof r === "object").map((r) => ({
    id: Number(r.segmentId),
    name: r.name,
    color: own.get(norm(r.name)) || own.get(String(r.segmentId)) || null,
  }));
}

/** The short texts of the status line, most important first. */
function statusItems(status, map, rooms, options) {
  const words = options.language === "he" ? WORDS.he : WORDS.en;
  const items = [];
  if (!status || typeof status !== "object") return items;
  const state = Number(status.state);
  const cleaning = CLEANING.has(state);
  if (words.states[state]) items.push({ text: words.states[state], dot: DOT[state] || "grey", keep: true });
  if (typeof status.battery === "number") items.push({ battery: status.battery, text: `${Math.round(status.battery)}%`, charging: state === 8, keep: true });
  if (cleaning && map && map.cleaningRooms.length) {
    const names = map.cleaningRooms.map((id) => (rooms.find((r) => r.id === id) || {}).name).filter(Boolean);
    if (names.length && names.length <= 3) items.push({ text: names.join(", ") });
  }
  if ((cleaning || state === 6 || state === 15 || state === 10) && status.clean_time > 0) {
    const parts = [];
    // The area from one square metre on: "0 m²" at the start of a clean says nothing.
    if (Math.round(status.clean_area / 1e6) >= 1) parts.push(words.area(Math.round(status.clean_area / 1e6)));
    parts.push(words.minutes(Math.max(1, Math.round(status.clean_time / 60))));
    items.push({ text: parts.join(" · ") });
  }
  // A map that is not current while the robot is moving: say from when it is.
  if (options.mapAt && options.now && state !== 8 && state !== 100 && options.now - options.mapAt > 90000) {
    const d = new Date(options.mapAt);
    const two = (n) => String(n).padStart(2, "0");
    // With the day when it is not from the last few hours.
    const day = options.now - options.mapAt > 12 * 3600 * 1000 ? `${two(d.getDate())}/${two(d.getMonth() + 1)} ` : "";
    items.push({ text: words.mapFrom(`${day}${two(d.getHours())}:${two(d.getMinutes())}`) });
  }
  return items;
}

/** The picture shown while there is no map to draw. */
function emptyPicture(theme, options, items) {
  const words = options.language === "he" ? WORDS.he : WORDS.en;
  const size = options.size || 1280;
  const width = size;
  const height = Math.round((size * 3) / 4 / 2) * 2;
  const canvas = new Canvas(width, height);
  canvas.background(theme.background[0], theme.background[1]);
  const unit = size / 1280;
  const letter = 34 * unit;
  const lines = [words.noMap].concat(items.filter((i) => i.text && !i.battery).slice(0, 1).map((i) => i.text));
  lines.forEach((line, n) => {
    const w = Canvas.textWidth(line, letter);
    const boxW = w + letter * 1.6, boxH = letter * 1.9;
    const x = (width - boxW) / 2, y = height / 2 - boxH / 2 + (n - (lines.length - 1) / 2) * boxH * 1.25;
    canvas.roundRect(x, y, boxW, boxH, boxH / 2, theme.textBack, theme.textBackOpacity);
    canvas.text(line, x + letter * 0.8, y + boxH / 2 + letter * 0.35, letter, theme.text, 1);
  });
  return canvas;
}

/**
 * Draw the camera's picture.
 *
 * options: theme (name), colors, roomColors, rooms ([{ segmentId, name }]),
 * rotation, labels, statusBar, hideBeyondWalls, size, language, status (the robot's status),
 * mapAt and now (times in ms), highlight (false: rooms being cleaned are not set off).
 * Returns { png, width, height, hasMap, rooms: [{ id, name, color, own }] }.
 */
function makePicture(mapBuffer, options = {}) {
  const theme = resolveTheme(options.theme, options.colors);
  let map = null;
  if (mapBuffer) {
    try {
      map = parseMap(Buffer.isBuffer(mapBuffer) ? mapBuffer : Buffer.from(mapBuffer));
    } catch {
      map = null;
    }
  }
  const rooms = roomList(options.rooms, options.roomColors);
  const items = options.statusBar === false ? [] : statusItems(options.status, map, rooms, options);
  const state = options.status ? Number(options.status.state) : NaN;
  let canvas = null;
  if (map) {
    canvas = drawMap(map, {
      theme,
      rotation: Number(options.rotation) || 0,
      size: options.size,
      rooms,
      labels: options.labels !== false,
      hideBeyondWalls: options.hideBeyondWalls === true,
      active: options.highlight !== false && CLEANING.has(state) ? map.cleaningRooms : [],
      status: options.statusBar === false ? null : { items },
      rtl: options.language === "he",
    });
  }
  const hasMap = !!canvas;
  if (!canvas) canvas = emptyPicture(theme, options, items);
  // The colour each room got, for the colour pickers in the settings.
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const used = hasMap ? rooms.filter((r) => canvas.roomColors.has(r.id)).map((r) => ({ id: r.id, name: r.name, color: hex(canvas.roomColors.get(r.id)), own: !!r.color })) : [];
  return { png: canvas.toPNG(), width: canvas.width, height: canvas.height, hasMap, rooms: used, background: hex(theme.background[0]) };
}

module.exports = { makePicture, statusItems, roomList };
