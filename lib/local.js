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
// "1.0" is the original protocol; newer firmware only answers "L01".
const VERSIONS = ["1.0", "L01"];
const HELLO_TIMEOUT = 2500;

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
    this.version = null; // protocol version that worked last time
    this.sessionVersion = "1.0"; // version of the connection that is open (or being opened)
    this.connectNonce = 0;
    this.ackNonce = null;
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
      const msg = P.decodeMessage(Buffer.from(frame), this.localKey, { connectNonce: this.connectNonce, ackNonce: this.ackNonce });
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

  /** Drop the socket and everything waiting on it. */
  _teardown() {
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.destroy();
    for (const w of this.waiters) w.reject(new Error("Local connection closed"));
    this.waiters.clear();
  }

  close() {
    this._teardown();
    this.ready = null;
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Protocol versions to try: the one that worked last time first. */
  _versions() {
    return this.version ? [this.version, ...VERSIONS.filter((v) => v !== this.version)] : VERSIONS;
  }

  connect(timeoutMs = 4000) {
    if (this.ready) return this.ready;
    const ready = (async () => {
      let lastErr;
      for (const version of this._versions()) {
        try {
          await this._open(version, timeoutMs);
          if (this.version !== version) this.log.info(`${this.name}: direct connection to the robot at ${this.host} works (protocol ${version}).`);
          this.version = version;
          return;
        } catch (err) {
          lastErr = err;
          // The robot is there but did not answer this version's hello: try the next one.
          if (!err.noHello) break;
        }
      }
      if (this.ready === ready) this.ready = null;
      throw lastErr;
    })();
    this.ready = ready;
    ready.catch(() => {}); // every caller awaits it; this only stops an "unhandled" warning
    return ready;
  }

  /** One TCP connection and one hello with the given protocol version. */
  _open(version, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.sessionVersion = version;
      this.connectNonce = crypto.randomInt(10000, 32767);
      this.ackNonce = null;
      let connected = false;
      let settled = false;
      const fail = (err) => {
        if (settled) {
          // The session was up (or already failed): a later error just closes it.
          if (this.socket === socket) this.close();
          return;
        }
        settled = true;
        if (connected) err.noHello = true;
        this._teardown();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error(`Could not reach ${this.host}:${this.port}`)));
      socket.on("error", fail);
      socket.on("close", () => fail(new Error(`hello (${version}): ${this.host} closed the connection`)));
      socket.on("data", (d) => this._onData(d));
      socket.on("connect", async () => {
        connected = true;
        socket.setTimeout(0);
        try {
          const hello = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.HELLO_REQUEST, payload: null, seq: 1, random: this.connectNonce, version });
          const waiting = this._wait((m) => m.protocol === P.PROTOCOL.HELLO_RESPONSE, Math.min(timeoutMs, HELLO_TIMEOUT), `hello (${version})`);
          socket.write(this._frame(hello));
          const answer = await waiting;
          if (settled) return;
          this.ackNonce = answer.random;
          settled = true;
          // Keep the session alive while it is open.
          this.pingTimer = setInterval(() => {
            if (!this.socket) return;
            const ping = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.PING_REQUEST, payload: null, version });
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
  }

  /**
   * Ask for the live map over the home network. Resolves with the map answer
   * as the robot sent it (opened by lib/map.js), rejects when the robot does
   * not send one this way. A missing answer does not close the connection:
   * it only means maps do not travel here.
   */
  async sendMap(security, timeoutMs = 3000) {
    await this.connect();
    this._touch();
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const payload = P.buildRpcPayload("get_map_v1", [], id, ts, security);
    const frame = P.encodeMessage({
      localKey: this.localKey,
      protocol: P.PROTOCOL.GENERAL_REQUEST,
      payload,
      ts,
      version: this.sessionVersion,
      connectNonce: this.connectNonce,
      ackNonce: this.ackNonce,
    });
    const waiting = this._wait(
      (m) => {
        if (m.protocol === P.PROTOCOL.MAP_RESPONSE) return true;
        if (!m.payload.length) return false;
        const rpc = P.parseRpcResponse(m.payload);
        if (!rpc || rpc.id !== id) return false;
        const result = Array.isArray(rpc.result) ? rpc.result[0] : rpc.result;
        if (!rpc.error && result !== "retry") return false; // "ok": the map itself should follow
        m.refusal = rpc.error ? (typeof rpc.error === "object" ? JSON.stringify(rpc.error) : String(rpc.error)) : "retry";
        return true;
      },
      timeoutMs,
      "get_map_v1"
    );
    this.socket.write(this._frame(frame));
    let msg;
    try {
      msg = await waiting;
    } catch (err) {
      // No map and no answer: the robot may have stopped sending maps on this connection (it
      // does after the Roborock app was open on the map) while it still answers everything
      // else. Start fresh next time, as after a restart.
      this.close();
      throw err;
    }
    if (msg.refusal) throw Object.assign(new Error(`the robot answered ${msg.refusal}`), { retry: msg.refusal === "retry" });
    return msg.payload;
  }

  async send(method, params, timeoutMs = 6000) {
    await this.connect();
    this._touch();
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const payload = P.buildRpcPayload(method, params, id, ts);
    const frame = P.encodeMessage({
      localKey: this.localKey,
      protocol: P.PROTOCOL.GENERAL_REQUEST,
      payload,
      ts,
      version: this.sessionVersion,
      connectNonce: this.connectNonce,
      ackNonce: this.ackNonce,
    });
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
    let msg;
    try {
      msg = await waiting;
    } catch (err) {
      // No answer: the connection may be dead without the socket knowing it
      // (robot changed access point, Wi-Fi dropped). Start fresh next time.
      this.close();
      throw err;
    }
    return msg.rpc;
  }
}

module.exports = { LocalConnection, PORT };
