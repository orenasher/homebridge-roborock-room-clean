"use strict";

/**
 * Colour styles of the map camera. Every style is a full set of colours; the
 * settings may replace single colours (`mapColors`) and give a room its own
 * colour (`mapRoomColors`).
 *
 * Room colours are handed out so that rooms next to each other differ.
 */

const THEMES = {
  roborock: {
    title: { en: "Roborock", he: "רובורוק" },
    background: ["#f4f7fb", "#e3e9f1"],
    shadow: "#22324a",
    shadowOpacity: 0.2,
    floor: "#c9d3df",
    walls: "#4a5a70",
    rooms: ["#7fb6f2", "#f6c667", "#7fd1b9", "#f29a8e", "#b9a4ee", "#8fd3f4", "#f5a8cf", "#b6d86a"],
    divider: "#ffffff",
    dividerOpacity: 0.55,
    path: "#ffffff",
    pathOpacity: 0.92,
    robot: "#ffffff",
    robotRing: "#3d4b5f",
    dock: "#22b573",
    noGo: "#ef4444",
    noMop: "#a855f7",
    zone: "#2f80ed",
    text: "#243042",
    textBack: "#ffffff",
    textBackOpacity: 0.86,
  },
  light: {
    title: { en: "Bright", he: "בהיר" },
    background: ["#ffffff", "#f3f4f6"],
    shadow: "#64748b",
    shadowOpacity: 0.16,
    floor: "#e5e7eb",
    walls: "#94a3b8",
    rooms: ["#bfdbfe", "#fde68a", "#bbf7d0", "#fecaca", "#ddd6fe", "#a5f3fc", "#fbcfe8", "#d9f99d"],
    divider: "#ffffff",
    dividerOpacity: 0.9,
    path: "#475569",
    pathOpacity: 0.7,
    robot: "#ffffff",
    robotRing: "#334155",
    dock: "#16a34a",
    noGo: "#dc2626",
    noMop: "#9333ea",
    zone: "#2563eb",
    text: "#1f2937",
    textBack: "#ffffff",
    textBackOpacity: 0.9,
  },
  dark: {
    title: { en: "Night", he: "לילה" },
    background: ["#111827", "#0b1220"],
    shadow: "#000000",
    shadowOpacity: 0.45,
    floor: "#374151",
    walls: "#cbd5e1",
    rooms: ["#3b82f6", "#d99a2b", "#14b8a6", "#e2685f", "#8b5cf6", "#0ea5e9", "#db5fa3", "#84b82f"],
    divider: "#0b1220",
    dividerOpacity: 0.6,
    path: "#f8fafc",
    pathOpacity: 0.9,
    robot: "#f8fafc",
    robotRing: "#0b1220",
    dock: "#34d399",
    noGo: "#f87171",
    noMop: "#c084fc",
    zone: "#60a5fa",
    text: "#f1f5f9",
    textBack: "#0b1220",
    textBackOpacity: 0.78,
  },
  pastel: {
    title: { en: "Pastel", he: "פסטל" },
    background: ["#fdf6f0", "#f6ebe4"],
    shadow: "#8a6f5c",
    shadowOpacity: 0.18,
    floor: "#e9ddd3",
    walls: "#8d7b6f",
    rooms: ["#f7c5cc", "#c5dff8", "#cdeac0", "#ffe5b4", "#d9c8f2", "#bfe8e2", "#f9d5a7", "#e4c1f9"],
    divider: "#fffaf5",
    dividerOpacity: 0.85,
    path: "#7a665b",
    pathOpacity: 0.6,
    robot: "#ffffff",
    robotRing: "#7a665b",
    dock: "#6bbf8a",
    noGo: "#e5737f",
    noMop: "#b08ae0",
    zone: "#6fa8dc",
    text: "#4b3f37",
    textBack: "#fffaf5",
    textBackOpacity: 0.88,
  },
  blueprint: {
    title: { en: "Blueprint", he: "שרטוט" },
    background: ["#12366b", "#0c2750"],
    shadow: "#051226",
    shadowOpacity: 0.45,
    floor: "#1d4a8c",
    walls: "#e6f0ff",
    rooms: ["#2a5fad", "#2f6fc4", "#2b7fbf", "#3466b8", "#2f78d1", "#3b6fb0", "#2a69a8", "#3a7fd6"],
    divider: "#cfe1ff",
    dividerOpacity: 0.5,
    path: "#ffe27a",
    pathOpacity: 0.9,
    robot: "#ffffff",
    robotRing: "#0c2750",
    dock: "#7df0b0",
    noGo: "#ff7b7b",
    noMop: "#d6a5ff",
    zone: "#9fd0ff",
    text: "#f2f7ff",
    textBack: "#0c2750",
    textBackOpacity: 0.72,
  },
  mono: {
    title: { en: "Grey", he: "אפור" },
    background: ["#f5f5f5", "#e7e7e7"],
    shadow: "#000000",
    shadowOpacity: 0.16,
    floor: "#d4d4d4",
    walls: "#404040",
    rooms: ["#c4c4c4", "#a8a8a8", "#dcdcdc", "#b6b6b6", "#cfcfcf", "#9c9c9c", "#e2e2e2", "#bdbdbd"],
    divider: "#ffffff",
    dividerOpacity: 0.8,
    path: "#ffffff",
    pathOpacity: 0.95,
    robot: "#ffffff",
    robotRing: "#262626",
    dock: "#404040",
    noGo: "#525252",
    noMop: "#737373",
    zone: "#262626",
    text: "#171717",
    textBack: "#ffffff",
    textBackOpacity: 0.9,
  },
  sand: {
    title: { en: "Sand", he: "חול" },
    background: ["#f3eadb", "#e6d8c3"],
    shadow: "#5c4326",
    shadowOpacity: 0.22,
    floor: "#d9c8ad",
    walls: "#5f4a33",
    rooms: ["#d9a066", "#9db08a", "#e0b78a", "#b98b73", "#c9b458", "#8fb0a9", "#d98c6a", "#b7a48a"],
    divider: "#f7efe2",
    dividerOpacity: 0.6,
    path: "#fffaf0",
    pathOpacity: 0.9,
    robot: "#fffaf0",
    robotRing: "#4a3824",
    dock: "#5b8c5a",
    noGo: "#b9412f",
    noMop: "#8a5a9e",
    zone: "#3f6f8f",
    text: "#3a2c1c",
    textBack: "#fffaf0",
    textBackOpacity: 0.86,
  },
  neon: {
    title: { en: "Neon", he: "ניאון" },
    background: ["#150b2e", "#090417"],
    shadow: "#7c3aed",
    shadowOpacity: 0.35,
    floor: "#2a1b52",
    walls: "#f0abfc",
    rooms: ["#06b6d4", "#d946ef", "#22c55e", "#f97316", "#6366f1", "#eab308", "#ec4899", "#14b8a6"],
    divider: "#090417",
    dividerOpacity: 0.7,
    path: "#ffffff",
    pathOpacity: 0.95,
    robot: "#ffffff",
    robotRing: "#150b2e",
    dock: "#a3e635",
    noGo: "#fb7185",
    noMop: "#c4b5fd",
    zone: "#67e8f9",
    text: "#ffffff",
    textBack: "#150b2e",
    textBackOpacity: 0.75,
  },
};

const DEFAULT_THEME = "roborock";

/** The colours a user may replace one by one (`mapColors` in the settings). */
const COLOR_KEYS = ["background", "walls", "path", "robot", "dock", "text", "textBack"];

/** "#rgb" or "#rrggbb" (with or without the #) -> [r, g, b], or null when it is not a colour. */
function parseColor(value) {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The colours to draw with: a style by name, with the user's own colours on
 * top. `colors`: { background, walls, path, robot, dock, text, textBack, rooms: [..] }.
 * Anything that is not a colour is ignored, so a typo never breaks the map.
 */
function resolveTheme(name, colors) {
  const known = typeof name === "string" && Object.prototype.hasOwnProperty.call(THEMES, name);
  const base = known ? THEMES[name] : THEMES[DEFAULT_THEME];
  const own = colors && typeof colors === "object" ? colors : {};
  const pick = (key) => parseColor(own[key]) || parseColor(base[key]);
  const background = parseColor(own.background);
  const rooms = (Array.isArray(own.rooms) ? own.rooms : []).map(parseColor).filter(Boolean);
  const theme = {
    name: known ? name : DEFAULT_THEME,
    background: background ? [background, background] : base.background.map(parseColor),
    shadow: parseColor(base.shadow),
    shadowOpacity: base.shadowOpacity,
    floor: parseColor(base.floor),
    walls: pick("walls"),
    rooms: rooms.length ? rooms : base.rooms.map(parseColor),
    divider: parseColor(base.divider),
    dividerOpacity: base.dividerOpacity,
    path: pick("path"),
    pathOpacity: base.pathOpacity,
    robot: pick("robot"),
    robotRing: parseColor(base.robotRing),
    dock: pick("dock"),
    noGo: parseColor(base.noGo),
    noMop: parseColor(base.noMop),
    zone: parseColor(base.zone),
    text: pick("text"),
    textBack: pick("textBack"),
    textBackOpacity: base.textBackOpacity,
  };
  // A ring that cannot be told from the robot's own colour is no ring.
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  if (Math.abs(lum(theme.robot) - lum(theme.robotRing)) < 60) theme.robotRing = lum(theme.robot) > 128 ? [40, 48, 60] : [245, 247, 250];
  if (Math.abs(lum(theme.text) - lum(theme.textBack)) < 60) theme.textBack = lum(theme.text) > 128 ? [15, 20, 30] : [255, 255, 255];
  return theme;
}

module.exports = { THEMES, DEFAULT_THEME, COLOR_KEYS, parseColor, mixColor, resolveTheme };
