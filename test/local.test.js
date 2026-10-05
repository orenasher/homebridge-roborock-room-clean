"use strict";

const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const P = require("../lib/protocol");
const { LocalConnection } = require("../lib/local");

const KEY = "abcdefghijklmnop";

function frame(buf) {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(buf.length);
  return Buffer.concat([l, buf]);
}

// Fake robot speaking the local "1.0" protocol on TCP.
function fakeRobot(log) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const msg = P.decodeMessage(buf.subarray(4, 4 + len), KEY);
        buf = buf.subarray(4 + len);
        if (msg.protocol === 0) {
          sock.write(frame(P.encodeMessage({ localKey: KEY, protocol: 1, payload: null, seq: msg.seq, random: 4242 })));
        } else if (msg.protocol === 2) {
          sock.write(frame(P.encodeMessage({ localKey: KEY, protocol: 3, payload: null, seq: msg.seq })));
        } else if (msg.protocol === 4) {
          const req = JSON.parse(JSON.parse(msg.payload.toString()).dps["101"]);
          log.push(req);
          const result = req.method === "get_status" ? [{ state: 8, in_cleaning: 0 }] : req.method === "bad" ? undefined : ["ok"];
          const body = req.method === "bad" ? { id: req.id, error: { code: -1, message: "nope" } } : { id: req.id, result };
          const ts = Math.floor(Date.now() / 1000);
          const out = Buffer.from(JSON.stringify({ dps: { 102: JSON.stringify(body) }, t: ts }));
          sock.write(frame(P.encodeMessage({ localKey: KEY, protocol: 5, payload: out, ts })));
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("hello/ping frames have no payload and round-trip", () => {
  const f = P.encodeMessage({ localKey: KEY, protocol: 0, payload: null, seq: 1, random: 123 });
  assert.equal(f.length, 21);
  const m = P.decodeMessage(f, KEY);
  assert.equal(m.protocol, 0);
  assert.equal(m.random, 123);
});

test("local connection: hello, RPC, error, idle close", async () => {
  const log = [];
  const server = await fakeRobot(log);
  const conn = new LocalConnection({ host: "127.0.0.1", port: server.address().port, localKey: KEY, log: console, name: "S8", idleMs: 300 });
  const status = await conn.send("get_status", []);
  assert.deepEqual(status.result, [{ state: 8, in_cleaning: 0 }]);
  const clean = await conn.send("app_segment_clean", [{ segments: [17], repeat: 2 }]);
  assert.deepEqual(clean.result, ["ok"]);
  const bad = await conn.send("bad", []);
  assert.equal(bad.error.message, "nope");
  assert.deepEqual(log.map((r) => r.method), ["get_status", "app_segment_clean", "bad"]);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(conn.socket, null, "closed after idle");
  // reconnects on demand
  const again = await conn.send("get_status", []);
  assert.ok(again.result);
  conn.close();
  server.close();
});

test("local connection fails fast when robot unreachable", async () => {
  const conn = new LocalConnection({ host: "127.0.0.1", port: 1, localKey: KEY, log: console, name: "S8" });
  await assert.rejects(conn.send("get_status", []));
});
