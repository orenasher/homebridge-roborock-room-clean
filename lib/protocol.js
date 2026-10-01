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

let seqCounter = crypto.randomInt(100000, 999999);
function nextSeq() {
  seqCounter = seqCounter >= 999999 ? 100000 : seqCounter + 1;
  return seqCounter;
}

function encodeMessage({ localKey, protocol, payload, ts, seq, random }) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  const header = Buffer.alloc(3 + 4 + 4 + 4 + 2);
  header.write("1.0", 0, "ascii");
  header.writeUInt32BE(seq ?? nextSeq(), 3);
  header.writeUInt32BE(random ?? crypto.randomInt(10000, 99999), 7);
  header.writeUInt32BE(timestamp, 11);
  header.writeUInt16BE(protocol, 15);
  let body = header;
  // Messages without a payload (local hello/ping) carry no length field at all.
  if (payload != null) {
    const encrypted = payload.length ? encryptEcb(payload, messageKey(timestamp, localKey)) : Buffer.alloc(0);
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
function decodeMessage(buf, localKey) {
  if (!Buffer.isBuffer(buf) || buf.length < 17) return null;
  const version = buf.toString("ascii", 0, 3);
  if (version !== "1.0") return null;
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
      payload = decryptEcb(encrypted, messageKey(ts, localKey));
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
  encodeMessage,
  decodeMessage,
  nextRequestId,
  buildRpcPayload,
  parseRpcResponse,
};
