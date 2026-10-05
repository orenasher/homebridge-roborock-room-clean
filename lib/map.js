"use strict";

/**
 * The one thing this plugin reads from the robot's live map: which rooms are
 * being cleaned right now. That is how a clean started outside Apple Home (a
 * routine pressed in the Roborock app, a schedule) is matched to its switch.
 *
 * Map layout (little-endian): a 20-byte header starting with "rr", then
 * blocks of { type u16, header length u16, data length u32, ... }. Block 11
 * ("currently cleaned blocks") holds a count (u32 at +8) followed by one byte
 * per room id.
 */

const zlib = require("zlib");
const crypto = require("crypto");

const BLOCK_CLEANED_ROOMS = 11;

/** Room (segment) ids being cleaned, from a decrypted and unzipped map. Empty when none are marked. */
function cleaningSegments(map) {
  if (!Buffer.isBuffer(map) || map.length < 0x14 || map[0] !== 0x72 || map[1] !== 0x72) {
    throw new Error("the answer is not a Roborock map");
  }
  const headerLength = Math.max(0x14, map.readUInt16LE(2));
  const end = Math.min(map.length, headerLength + map.readUInt32LE(4));
  let pos = headerLength;
  while (pos + 8 <= end) {
    const type = map.readUInt16LE(pos);
    const hlength = map.readUInt16LE(pos + 2);
    const length = map.readUInt32LE(pos + 4);
    if (hlength < 8 || pos + hlength + length > map.length) break; // not a block: stop
    if (type === BLOCK_CLEANED_ROOMS) {
      const count = hlength >= 12 ? Math.min(map.readUInt32LE(pos + 8), length) : length;
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(map.readUInt8(pos + hlength + i));
      return [...new Set(ids)];
    }
    pos += hlength + length;
  }
  return [];
}

/**
 * Open the body of a map answer (protocol 301): 24 header bytes, then the
 * map, gzipped and AES-128-CBC encrypted with the nonce sent in the request.
 * Returns null when it cannot be opened with this nonce (someone else's map).
 */
function decodeMapAnswer(payload, nonce) {
  if (!Buffer.isBuffer(payload) || payload.length <= 24) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", nonce, Buffer.alloc(16));
    const plain = Buffer.concat([decipher.update(payload.subarray(24)), decipher.final()]);
    return zlib.gunzipSync(plain);
  } catch {
    return null;
  }
}

/** The request id a map answer belongs to. */
function mapAnswerId(payload) {
  return Buffer.isBuffer(payload) && payload.length >= 24 ? payload.readUInt16LE(16) : null;
}

module.exports = { cleaningSegments, decodeMapAnswer, mapAnswerId };
