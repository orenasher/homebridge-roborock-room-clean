"use strict";

/**
 * Direct connection to a Roborock robot on the home network (TCP 58867),
 * "1.0" protocol. Frames are prefixed with a 4-byte big-endian length.
 * The connection is opened on demand and closed again after a short idle
 * time, so it does not compete with other apps or plugins for long.
 */

const net = require("net");
const crypto = require("crypto");
const P = require("./protocol");

const PORT = 58867;

class LocalConnection {
  constructor({ host, localKey, log, name, idleMs = 60000, port = PORT }) {
    this.port = port;
    this.host = host;
    this.localKey = localKey;
    this.log = log;
    this.name = name;
    this.idleMs = idleMs;
    this.socket = null;
    this.ready = null; // Promise while connecting / connected
    this.buffer = Buffer.alloc(0);
    this.waiters = new Set(); // {match(msg) -> bool, resolve}
    this.idleTimer = null;
    this.pingTimer = null;
  }

  _frame(msg) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(msg.length, 0);
    return Buffer.concat([len, msg]);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (len > 1024 * 1024) {
        // Out of sync: drop everything.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const frame = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      const msg = P.decodeMessage(Buffer.from(frame), this.localKey);
      if (!msg) continue;
      for (const w of this.waiters) {
        if (w.match(msg)) {
          this.waiters.delete(w);
          w.resolve(msg);
        }
      }
    }
  }

  _wait(match, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      const t = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`${what}: no answer from ${this.host}`));
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  close() {
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ready = null;
    for (const w of this.waiters) w.reject(new Error("Local connection closed"));
    this.waiters.clear();
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  connect(timeoutMs = 4000) {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      const fail = (err) => {
        this.close();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error(`Could not reach ${this.host}:${this.port}`)));
      socket.on("error", fail);
      socket.on("close", () => {
        if (this.socket === socket) this.close();
      });
      socket.on("data", (d) => this._onData(d));
      socket.on("connect", async () => {
        socket.setTimeout(0);
        try {
          const nonce = crypto.randomInt(10000, 32767);
          const hello = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.HELLO_REQUEST, payload: null, seq: 1, random: nonce });
          const waiting = this._wait((m) => m.protocol === P.PROTOCOL.HELLO_RESPONSE, timeoutMs, "hello");
          socket.write(this._frame(hello));
          await waiting;
          // Keep the session alive while it is open.
          this.pingTimer = setInterval(() => {
            if (!this.socket) return;
            const ping = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.PING_REQUEST, payload: null });
            this.socket.write(this._frame(ping));
          }, 10000);
          this.pingTimer.unref?.();
          this._touch();
          resolve();
        } catch (err) {
          fail(err);
        }
      });
    });
    return this.ready;
  }

  async send(method, params, timeoutMs = 6000) {
    await this.connect();
    this._touch();
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const payload = P.buildRpcPayload(method, params, id, ts);
    const frame = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.GENERAL_REQUEST, payload, ts });
    const waiting = this._wait(
      (m) => {
        if (!m.payload.length) return false;
        const rpc = P.parseRpcResponse(m.payload);
        if (rpc && rpc.id === id) {
          m.rpc = rpc;
          return true;
        }
        return false;
      },
      timeoutMs,
      method
    );
    this.socket.write(this._frame(frame));
    const msg = await waiting;
    return msg.rpc;
  }
}

module.exports = { LocalConnection, PORT };
