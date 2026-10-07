"use strict";

/**
 * A small drawing surface in plain JavaScript (no native module, nothing to
 * install): smooth-edged shapes, text, and saving as PNG. It draws the map
 * camera's picture.
 *
 * Shapes are described by their distance to the edge, which gives soft
 * (anti-aliased) edges for free.
 */

const zlib = require("zlib");
const path = require("path");
const fs = require("fs");

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 3); // RGB
  }

  /** Top-to-bottom gradient over the whole picture. */
  background(top, bottom) {
    const { width, height, data } = this;
    for (let y = 0; y < height; y++) {
      const t = height > 1 ? y / (height - 1) : 0;
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      let i = y * width * 3;
      for (let x = 0; x < width; x++) {
        data[i++] = r;
        data[i++] = g;
        data[i++] = b;
      }
    }
  }

  /**
   * Paint `color` wherever `distance(x, y)` (in pixels, negative inside the
   * shape) says so, inside the given box.
   */
  paint(x0, y0, x1, y1, distance, color, opacity = 1) {
    const { width, height, data } = this;
    const left = Math.max(0, Math.floor(x0));
    const right = Math.min(width - 1, Math.ceil(x1));
    const bottom = Math.min(height - 1, Math.ceil(y1));
    for (let y = Math.max(0, Math.floor(y0)); y <= bottom; y++) {
      let i = (y * width + left) * 3;
      for (let x = left; x <= right; x++, i += 3) {
        const a = clamp01(0.5 - distance(x + 0.5, y + 0.5)) * opacity;
        if (a <= 0) continue;
        data[i] += (color[0] - data[i]) * a;
        data[i + 1] += (color[1] - data[i + 1]) * a;
        data[i + 2] += (color[2] - data[i + 2]) * a;
      }
    }
  }

  circle(cx, cy, radius, color, opacity) {
    this.paint(cx - radius - 1, cy - radius - 1, cx + radius + 1, cy + radius + 1, (x, y) => Math.hypot(x - cx, y - cy) - radius, color, opacity);
  }

  ring(cx, cy, radius, thickness, color, opacity) {
    const reach = radius + thickness / 2 + 1;
    this.paint(cx - reach, cy - reach, cx + reach, cy + reach, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - radius) - thickness / 2, color, opacity);
  }

  /** A rectangle with rounded corners. */
  roundRect(x, y, w, h, radius, color, opacity) {
    const r = Math.min(radius, w / 2, h / 2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    this.paint(x - 1, y - 1, x + w + 1, y + h + 1, (px, py) => {
      const qx = Math.abs(px - cx) - (w / 2 - r);
      const qy = Math.abs(py - cy) - (h / 2 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    }, color, opacity);
  }

  /** A filled shape with straight sides (`points`: x0, y0, x1, y1, ...), and optionally its outline. */
  polygon(points, color, opacity, outline) {
    const n = points.length / 2;
    if (n < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, points[i * 2]);
      x1 = Math.max(x1, points[i * 2]);
      y0 = Math.min(y0, points[i * 2 + 1]);
      y1 = Math.max(y1, points[i * 2 + 1]);
    }
    const distance = (px, py) => {
      let best = Infinity;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = points[j * 2], ay = points[j * 2 + 1];
        const bx = points[i * 2], by = points[i * 2 + 1];
        const ex = bx - ax, ey = by - ay;
        const wx = px - ax, wy = py - ay;
        const len = ex * ex + ey * ey;
        const t = len ? clamp01((wx * ex + wy * ey) / len) : 0;
        const dx = wx - ex * t, dy = wy - ey * t;
        best = Math.min(best, dx * dx + dy * dy);
        if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
      }
      return inside ? -Math.sqrt(best) : Math.sqrt(best);
    };
    const grow = outline ? outline.width : 0;
    if (opacity > 0) this.paint(x0 - 1, y0 - 1, x1 + 1, y1 + 1, distance, color, opacity);
    if (outline) {
      this.paint(x0 - grow - 1, y0 - grow - 1, x1 + grow + 1, y1 + grow + 1, (px, py) => Math.abs(distance(px, py)) - outline.width / 2, outline.color, outline.opacity == null ? 1 : outline.opacity);
    }
  }

  /**
   * A line through many points (x0, y0, x1, y1, ...) with round ends and
   * corners. Drawn as one stroke: where it crosses itself it does not get darker.
   */
  polyline(points, thickness, color, opacity) {
    const n = points.length / 2;
    if (n < 1) return;
    const { width, height, data } = this;
    const radius = thickness / 2;
    const reach = radius + 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, points[i * 2]);
      x1 = Math.max(x1, points[i * 2]);
      y0 = Math.min(y0, points[i * 2 + 1]);
      y1 = Math.max(y1, points[i * 2 + 1]);
    }
    const left = Math.max(0, Math.floor(x0 - reach));
    const top = Math.max(0, Math.floor(y0 - reach));
    const right = Math.min(width - 1, Math.ceil(x1 + reach));
    const bottom = Math.min(height - 1, Math.ceil(y1 + reach));
    if (right < left || bottom < top) return;
    const w = right - left + 1;
    const cover = new Uint8Array(w * (bottom - top + 1));
    const stamp = (ax, ay, bx, by) => {
      const ex = bx - ax, ey = by - ay;
      const len = ex * ex + ey * ey;
      const bx0 = Math.max(left, Math.floor(Math.min(ax, bx) - reach));
      const bx1 = Math.min(right, Math.ceil(Math.max(ax, bx) + reach));
      const sy1 = Math.min(bottom, Math.ceil(Math.max(ay, by) + reach));
      // Only the pixels near the line are looked at, row by row: a long slanted line costs its length, not its bounding box.
      const slanted = Math.abs(ey) > 1e-6;
      const spread = slanted ? (reach * (Math.abs(ex) + Math.abs(ey))) / Math.abs(ey) + 1 : 0;
      for (let y = Math.max(top, Math.floor(Math.min(ay, by) - reach)); y <= sy1; y++) {
        let sx0 = bx0, sx1 = bx1;
        if (slanted) {
          const across = ax + ((y + 0.5 - ay) * ex) / ey;
          sx0 = Math.max(bx0, Math.floor(across - spread));
          sx1 = Math.min(bx1, Math.ceil(across + spread));
        }
        for (let x = sx0; x <= sx1; x++) {
          const wx = x + 0.5 - ax, wy = y + 0.5 - ay;
          const t = len ? clamp01((wx * ex + wy * ey) / len) : 0;
          const a = clamp01(0.5 - (Math.hypot(wx - ex * t, wy - ey * t) - radius)) * 255;
          const k = (y - top) * w + (x - left);
          if (a > cover[k]) cover[k] = a;
        }
      }
    };
    if (n === 1) stamp(points[0], points[1], points[0], points[1]);
    for (let i = 1; i < n; i++) stamp(points[i * 2 - 2], points[i * 2 - 1], points[i * 2], points[i * 2 + 1]);
    for (let y = top; y <= bottom; y++) {
      let i = (y * width + left) * 3;
      let k = (y - top) * w;
      for (let x = left; x <= right; x++, i += 3, k++) {
        if (!cover[k]) continue;
        const a = (cover[k] / 255) * opacity;
        data[i] += (color[0] - data[i]) * a;
        data[i + 1] += (color[1] - data[i + 1]) * a;
        data[i + 2] += (color[2] - data[i + 2]) * a;
      }
    }
  }

  // ---------- text ----------

  /** Width in pixels of `text` at the given letter size. */
  static textWidth(text, size) {
    const font = loadFont();
    let width = 0;
    for (const ch of visualOrder(text)) {
      const glyph = font.glyphs.get(ch.codePointAt(0)) || font.glyphs.get(63);
      width += glyph.advance;
    }
    return (width * size) / font.size;
  }

  /** True when every letter of `text` can be drawn. */
  static canWrite(text) {
    const font = loadFont();
    for (const ch of String(text)) if (!font.glyphs.has(ch.codePointAt(0))) return false;
    return true;
  }

  /** Write `text` starting at x, with its baseline at y. Hebrew is written right to left. */
  text(text, x, baseline, size, color, opacity = 1) {
    const font = loadFont();
    const { width, height, data } = this;
    const ratio = font.size / size; // atlas pixels per picture pixel
    const sum = font.sum;
    const stride = font.width + 1;
    // Sum of the atlas over [0,ax) x [0,ay), for any (fractional) corner.
    const area = (ax, ay) => {
      const ix = Math.floor(ax), iy = Math.floor(ay);
      const fx = ax - ix, fy = ay - iy;
      const k = iy * stride + ix;
      const top = sum[k] + (sum[k + 1] - sum[k]) * fx;
      if (!fy) return top;
      const below = sum[k + stride] + (sum[k + stride + 1] - sum[k + stride]) * fx;
      return top + (below - top) * fy;
    };
    let pen = x;
    for (const ch of visualOrder(text)) {
      const glyph = font.glyphs.get(ch.codePointAt(0)) || font.glyphs.get(63);
      if (glyph.w) {
        const gx = pen + glyph.left / ratio;
        const gy = baseline - font.ascent / ratio + glyph.top / ratio;
        const px1 = Math.min(width - 1, Math.ceil(gx + glyph.w / ratio));
        const py1 = Math.min(height - 1, Math.ceil(gy + glyph.h / ratio));
        for (let py = Math.max(0, Math.floor(gy)); py <= py1; py++) {
          const sy0 = Math.min(glyph.h, Math.max(0, (py - gy) * ratio));
          const sy1 = Math.min(glyph.h, Math.max(0, (py + 1 - gy) * ratio));
          if (sy1 <= sy0) continue;
          for (let px = Math.max(0, Math.floor(gx)); px <= px1; px++) {
            const sx0 = Math.min(glyph.w, Math.max(0, (px - gx) * ratio));
            const sx1 = Math.min(glyph.w, Math.max(0, (px + 1 - gx) * ratio));
            if (sx1 <= sx0) continue;
            const total = area(glyph.x + sx1, glyph.y + sy1) - area(glyph.x + sx0, glyph.y + sy1) - area(glyph.x + sx1, glyph.y + sy0) + area(glyph.x + sx0, glyph.y + sy0);
            const a = clamp01(total / (255 * ratio * ratio)) * opacity;
            if (a <= 0) continue;
            const i = (py * width + px) * 3;
            data[i] += (color[0] - data[i]) * a;
            data[i + 1] += (color[1] - data[i + 1]) * a;
            data[i + 2] += (color[2] - data[i + 2]) * a;
          }
        }
      }
      pen += glyph.advance / ratio;
    }
    return pen;
  }

  // ---------- saving ----------

  /** The picture as a PNG file. */
  toPNG() {
    const { width, height, data } = this;
    const row = width * 3;
    // Every row is stored as the difference from the row above ("Up" filter): flat areas and gradients shrink to almost nothing.
    const raw = Buffer.alloc((row + 1) * height);
    for (let y = 0; y < height; y++) {
      const out = y * (row + 1);
      raw[out] = y ? 2 : 0;
      const src = y * row;
      if (!y) for (let x = 0; x < row; x++) raw[out + 1 + x] = data[src + x];
      else for (let x = 0; x < row; x++) raw[out + 1 + x] = data[src + x] - data[src - row + x];
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bits per channel
    header[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

// ---------- letters ----------

let font = null;

/** The letter pictures (lib/glyphs.json), opened on first use. */
function loadFont() {
  if (font) return font;
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, "glyphs.json"), "utf8"));
  const alpha = zlib.inflateSync(Buffer.from(file.alpha, "base64"));
  const { width, height } = file;
  // Summed-area table: the sum of any rectangle of the atlas in four look-ups, so letters shrink smoothly to any size.
  const sum = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let line = 0;
    for (let x = 0; x < width; x++) {
      line += alpha[y * width + x];
      sum[(y + 1) * (width + 1) + x + 1] = sum[y * (width + 1) + x + 1] + line;
    }
  }
  const glyphs = new Map();
  for (const item of file.glyphs.split(";")) {
    const [code, x, y, w, h, left, top, advance] = item.split(",").map(Number);
    glyphs.set(code, { x, y, w, h, left, top, advance: advance / 16 });
  }
  font = { size: file.size, ascent: file.ascent, descent: file.descent, width, height, sum, glyphs };
  return font;
}

const RTL = /[֐-׿]/;
const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

/**
 * The letters of `text` in the order they are drawn, left to right. Text
 * with Hebrew in it is laid out right to left, keeping numbers and Latin
 * words readable ("חדר 12" stays "12" and not "21").
 */
function visualOrder(text) {
  text = String(text);
  if (!RTL.test(text)) return [...text];
  const runs = text.match(/[0-9A-Za-zÀ-ɏͰ-ӿ]+(?:[ .,:'\-/][0-9A-Za-zÀ-ɏͰ-ӿ]+)*%?|[\s\S]/gu) || [];
  const out = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = [...runs[i]];
    if (run.length > 1) out.push(...run);
    else out.push(MIRROR[run[0]] || run[0]);
  }
  return out;
}

module.exports = { Canvas, visualOrder, clamp01 };
