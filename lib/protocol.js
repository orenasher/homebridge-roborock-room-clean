"use strict";

/**
 * Roborock "1.0" (V1) message protocol, as used over the cloud MQTT broker.
 *
 * Frame layout (all big-endian):
 *   version  3 bytes  "1.0"
 *   seq      uint32
 *   random   uint32
 *   ts       uint32   seconds since epoch
 *   protocol uint16   101 = RPC request, 102 = RPC response, 301 = map
 *   length   uint16   length of the encrypted payload
 *   payload  AES-128-ECB(PKCS7), key = md5(encodeTimestamp(ts) + localKey + SALT)
 *   crc32    uint32   over everything above
 *
 * Newer firmware answers on the home network only with version "L01". The
 * frame is the same, but the payload is AES-256-GCM:
 *   key = sha256(encodeTimestamp(ts) + localKey + SALT)
 *   iv  = first 12 bytes of sha256(seq + random + ts)            (uint32 each)
 *   aad = seq + connectNonce + ackNonce + random + ts            (uint32 each)
 *   payload = ciphertext + 16-byte tag
 * connectNonce is the "random" of our hello, ackNonce the "random" of the
 * robot's hello answer.
 */

const crypto = require("crypto");

const SALT = "TXdfu$jyZ#TZHsg4";

const PROTOCOL = {
  HELLO_REQUEST: 0,
  HELLO_RESPONSE: 1,
  PING_REQUEST: 2,
  PING_RESPONSE: 3,
  GENERAL_REQUEST: 4,
  GENERAL_RESPONSE: 5,
  RPC_REQUEST: 101,
  RPC_RESPONSE: 102,
  MAP_RESPONSE: 301,
};

// Plain CRC-32 (zlib.crc32 only exists on newer Node versions).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function md5(data) {
  return crypto.createHash("md5").update(data).digest();
}

function md5hex(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

function encodeTimestamp(ts) {
  const hex = ts.toString(16).padStart(8, "0");
  return [5, 6, 3, 7, 1, 2, 0, 4].map((i) => hex[i]).join("");
}

function messageKey(ts, localKey) {
  return md5(Buffer.from(encodeTimestamp(ts) + localKey + SALT, "utf8"));
}

function encryptEcb(plain, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function decryptEcb(data, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function l01Key(ts, localKey) {
  return crypto.createHash("sha256").update(Buffer.from(encodeTimestamp(ts) + localKey + SALT, "utf8")).digest();
}

function l01Iv(ts, random, seq) {
  return crypto.createHash("sha256").update(Buffer.concat([u32(seq), u32(random), u32(ts)])).digest().subarray(0, 12);
}

function l01Aad(ts, random, seq, connectNonce, ackNonce) {
  return Buffer.concat([u32(seq), u32(connectNonce), ackNonce == null ? Buffer.alloc(0) : u32(ackNonce), u32(random), u32(ts)]);
}

function encryptL01(plain, localKey, ts, seq, random, connectNonce, ackNonce) {
  const cipher = crypto.createCipheriv("aes-256-gcm", l01Key(ts, localKey), l01Iv(ts, random, seq));
  cipher.setAAD(l01Aad(ts, random, seq, connectNonce, ackNonce));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function decryptL01(data, localKey, ts, seq, random, connectNonce, ackNonce) {
  if (data.length < 16) throw new Error("L01 payload too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", l01Key(ts, localKey), l01Iv(ts, random, seq));
  decipher.setAAD(l01Aad(ts, random, seq, connectNonce, ackNonce));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

let seqCounter = crypto.randomInt(100000, 999999);
function nextSeq() {
  seqCounter = seqCounter >= 999999 ? 100000 : seqCounter + 1;
  return seqCounter;
}

function encodeMessage({ localKey, protocol, payload, ts, seq, random, version = "1.0", connectNonce, ackNonce }) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  const sequence = seq ?? nextSeq();
  const rnd = random ?? crypto.randomInt(10000, 99999);
  const header = Buffer.alloc(3 + 4 + 4 + 4 + 2);
  header.write(version, 0, 3, "ascii");
  header.writeUInt32BE(sequence, 3);
  header.writeUInt32BE(rnd, 7);
  header.writeUInt32BE(timestamp, 11);
  header.writeUInt16BE(protocol, 15);
  let body = header;
  // Messages without a payload (local hello/ping) carry no length field at all.
  if (payload != null) {
    let encrypted = Buffer.alloc(0);
    if (payload.length) {
      encrypted =
        version === "L01"
          ? encryptL01(payload, localKey, timestamp, sequence, rnd, connectNonce, ackNonce)
          : encryptEcb(payload, messageKey(timestamp, localKey));
    }
    const len = Buffer.alloc(2);
    len.writeUInt16BE(encrypted.length, 0);
    body = Buffer.concat([header, len, encrypted]);
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, crc]);
}

/**
 * Decode one frame. Returns null for frames we do not understand
 * (other protocol versions, e.g. A01/B01 devices, or corrupt data).
 */
function decodeMessage(buf, localKey, { connectNonce, ackNonce } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 17) return null;
  const version = buf.toString("ascii", 0, 3);
  if (version !== "1.0" && version !== "L01") return null;
  const seq = buf.readUInt32BE(3);
  const random = buf.readUInt32BE(7);
  const ts = buf.readUInt32BE(11);
  const protocol = buf.readUInt16BE(15);
  if (buf.length === 17 || buf.length === 21) {
    // Header (+ crc) only: no payload.
    return { version, seq, random, ts, protocol, payload: Buffer.alloc(0) };
  }
  if (buf.length < 19) return null;
  const length = buf.readUInt16BE(17);
  if (buf.length < 19 + length) return null;
  const encrypted = buf.subarray(19, 19 + length);
  if (buf.length >= 19 + length + 4) {
    const expected = buf.readUInt32BE(19 + length);
    const actual = crc32(buf.subarray(0, 19 + length));
    if (expected !== actual) return null;
  }
  let payload = Buffer.alloc(0);
  if (length > 0) {
    try {
      payload =
        version === "L01"
          ? decryptL01(encrypted, localKey, ts, seq, random, connectNonce, ackNonce)
          : decryptEcb(encrypted, messageKey(ts, localKey));
    } catch {
      return null;
    }
  }
  return { version, seq, random, ts, protocol, payload };
}

let requestIdCounter = crypto.randomInt(10000, 32767);
function nextRequestId() {
  requestIdCounter = requestIdCounter >= 32767 ? 10000 : requestIdCounter + 1;
  return requestIdCounter;
}

/** Build the JSON body of an RPC request (goes inside the encrypted payload). */
function buildRpcPayload(method, params, id, ts, security) {
  const body = { id, method, params: params ?? [] };
  if (security) body.security = security;
  const inner = JSON.stringify(body);
  return Buffer.from(JSON.stringify({ dps: { 101: inner }, t: ts }), "utf8");
}

/** Parse an RPC response payload. Returns { id, result, error } or null. */
function parseRpcResponse(payload) {
  let outer;
  try {
    outer = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  const dp = outer && outer.dps && outer.dps["102"];
  if (!dp) return null;
  let inner;
  try {
    inner = typeof dp === "string" ? JSON.parse(dp) : dp;
  } catch {
    return null;
  }
  return { id: inner.id, result: inner.result, error: inner.error };
}

module.exports = {
  PROTOCOL,
  crc32,
  md5,
  md5hex,
  encodeTimestamp,
  encryptL01,
  decryptL01,
  encodeMessage,
  decodeMessage,
  nextRequestId,
  buildRpcPayload,
  parseRpcResponse,
};
