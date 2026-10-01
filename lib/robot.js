"use strict";

/**
 * Cloud MQTT session for one Roborock account, and a small RPC channel per
 * robot ("1.0"/V1 protocol robots: S-, Q-, Saros-series).
 */

const crypto = require("crypto");
const { EventEmitter } = require("events");
const { MqttClient } = require("./mqtt");
const P = require("./protocol");
const { LocalConnection } = require("./local");

class RoborockSession extends EventEmitter {
  constructor(userData, log) {
    super();
    this.log = log;
    this.rriot = userData.rriot;
    this.mqttUser = P.md5hex(`${this.rriot.u}:${this.rriot.k}`).substring(2, 10);
    this.mqttPassword = P.md5hex(`${this.rriot.s}:${this.rriot.k}`).substring(16);
    this.devices = new Map(); // duid -> RobotChannel
    this.client = new MqttClient({
      url: this.rriot.r.m,
      clientId: crypto.randomBytes(8).toString("hex"),
      username: this.mqttUser,
      password: this.mqttPassword,
      keepalive: 60,
    });
    this.lastErrorLog = 0;
    this.client.on("connect", () => {
      this.log.info("Connected to the Roborock cloud.");
      this.emit("connect");
    });
    this.client.on("offline", () => this.log.warn("Lost the connection to the Roborock cloud, reconnecting..."));
    this.client.on("error", (err) => {
      // Avoid flooding the log while the network is down.
      if (Date.now() - this.lastErrorLog > 5 * 60 * 1000) {
        this.lastErrorLog = Date.now();
        this.log.warn(`Roborock cloud connection problem: ${err.message}`);
      }
    });
    this.client.on("message", (topic, payload) => {
      const duid = topic.split("/").pop();
      const channel = this.devices.get(duid);
      if (channel) channel._onMessage(payload);
    });
    this.client.subscribe(`rr/m/o/${this.rriot.u}/${this.mqttUser}/#`);
  }

  start() {
    this.client.connect();
  }

  stop() {
    for (const ch of this.devices.values()) ch.close();
    this.client.end();
  }

  get connected() {
    return this.client.connected;
  }

  waitConnected(timeoutMs = 20000) {
    if (this.client.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off("connect", onConnect);
        reject(new Error("Not connected to the Roborock cloud (timed out)."));
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(t);
        resolve();
      };
      this.once("connect", onConnect);
    });
  }

  /** Security block some firmware expects in cloud RPC requests. */
  security() {
    return {
      endpoint: P.md5(Buffer.from(this.rriot.k, "utf8")).subarray(8, 14).toString("base64"),
      nonce: crypto.randomBytes(16).toString("hex"),
    };
  }

  channel(duid, localKey, name, host) {
    let ch = this.devices.get(duid);
    if (!ch) {
      ch = new RobotChannel(this, duid, localKey, name, host);
      this.devices.set(duid, ch);
    }
    return ch;
  }

  _publish(duid, frame) {
    this.client.publish(`rr/m/i/${this.rriot.u}/${this.mqttUser}/${duid}`, frame, 1);
  }
}

class RobotChannel {
  constructor(session, duid, localKey, name, host) {
    this.session = session;
    this.log = session.log;
    this.duid = duid;
    this.localKey = localKey;
    this.name = name;
    this.pending = new Map(); // request id -> {resolve, reject, timer}
    this.local = null;
    this.setHost(host);
  }

  setHost(host) {
    if (!host || (this.local && this.local.host === host)) return;
    if (this.local) this.local.close();
    this.host = host;
    this.local = new LocalConnection({ host, localKey: this.localKey, log: this.log, name: this.name });
  }

  close() {
    if (this.local) this.local.close();
  }

  _onMessage(frame) {
    const msg = P.decodeMessage(frame, this.localKey);
    if (!msg || msg.protocol !== P.PROTOCOL.RPC_RESPONSE) return;
    const rpc = P.parseRpcResponse(msg.payload);
    if (!rpc || rpc.id === undefined) return;
    const pending = this.pending.get(rpc.id);
    if (!pending) return;
    this.pending.delete(rpc.id);
    clearTimeout(pending.timer);
    pending.resolve(rpc);
  }

  static unwrap(method, rpc) {
    if (rpc.error) {
      const e = rpc.error;
      throw Object.assign(new Error(`Robot refused ${method}: ${typeof e === "object" ? e.message || JSON.stringify(e) : e}`), { refused: true });
    }
    return rpc.result;
  }

  /**
   * Send a command: over the home network when the robot's address is known,
   * otherwise (or if that fails) through the Roborock cloud.
   */
  async send(method, params, { timeoutMs = 15000 } = {}) {
    if (this.local) {
      try {
        const rpc = await this.local.send(method, params);
        return RobotChannel.unwrap(method, rpc);
      } catch (err) {
        if (err.refused) throw err;
        this.log.debug(`${this.name}: local ${method} failed (${err.message}), using the cloud.`);
      }
    }
    try {
      return RobotChannel.unwrap(method, await this._sendCloud(method, params, timeoutMs));
    } catch (err) {
      if (err.refused || !err.timeout) throw err;
      // The cloud connection can go quiet without dropping; reconnect and try once more.
      this.log.warn(`${this.name}: no answer through the cloud, reconnecting and retrying ${method}.`);
      this.session.client.reconnect();
      await new Promise((r) => setTimeout(r, 1500));
      return RobotChannel.unwrap(method, await this._sendCloud(method, params, timeoutMs));
    }
  }

  async _sendCloud(method, params, timeoutMs) {
    await this.session.waitConnected();
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const payload = P.buildRpcPayload(method, params, id, ts, this.session.security());
    const frame = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.RPC_REQUEST, payload, ts });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`No answer from ${this.name} to ${method} (is it online?)`), { timeout: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.session._publish(this.duid, frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** The robot's address on the home network (or null). */
  async getIp() {
    const result = await this.send("get_network_info", [], { timeoutMs: 10000 });
    const info = Array.isArray(result) ? result[0] : result;
    return info && info.ip ? String(info.ip) : null;
  }

  /** Returns [{ segmentId, roomId }] — roomId matches the cloud room list. */
  async getRoomMapping() {
    const result = await this.send("get_room_mapping", []);
    if (!Array.isArray(result)) return [];
    return result
      .filter((r) => Array.isArray(r) && r.length >= 2)
      .map((r) => ({ segmentId: Number(r[0]), roomId: String(r[1]) }));
  }

  async getStatus() {
    const result = await this.send("get_status", [], { timeoutMs: 8000 });
    return Array.isArray(result) ? result[0] : result;
  }
}

module.exports = { RoborockSession, RobotChannel };
