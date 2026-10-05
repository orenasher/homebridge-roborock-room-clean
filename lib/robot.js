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
const { cleaningSegments, decodeMapAnswer, mapAnswerId } = require("./map");

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
        if (this.client.authRefused) {
          this.log.warn(
            "Roborock is refusing this login for the cloud connection. The plugin now waits 30 minutes or more between attempts. " +
              "If it stays like this, log out and log in again in the plugin settings."
          );
        }
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
    if (this.client.authRefused) return Promise.reject(new Error("Roborock is refusing the cloud connection (not authorized)."));
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
  security(nonce = crypto.randomBytes(16)) {
    return {
      endpoint: P.md5(Buffer.from(this.rriot.k, "utf8")).subarray(8, 14).toString("base64"),
      nonce: nonce.toString("hex"),
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
    this.maps = new Map(); // request id -> { nonce, resolve } (map requests waiting for their answer)
    this.onPush = null; // called with { state, battery } when the robot reports a change by itself
    this.cloudTimeouts = 0; // cloud requests in a row that got no answer
    this.cloudPausedUntil = 0; // background requests skip the cloud until then
    this.lastLocalWarn = 0;
    this.lastVia = null; // "local" or "cloud": how the last command travelled
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
    if (!msg) return;
    if (msg.protocol !== P.PROTOCOL.RPC_RESPONSE) {
      if (msg.protocol === P.PROTOCOL.GENERAL_REQUEST) this._onPush(msg.payload);
      else if (msg.protocol === P.PROTOCOL.MAP_RESPONSE) this._onMap(msg.payload);
      return;
    }
    const rpc = P.parseRpcResponse(msg.payload);
    if (!rpc) return this._onPush(msg.payload);
    if (rpc.id === undefined) return;
    const pending = this.pending.get(rpc.id);
    if (!pending) return;
    this.pending.delete(rpc.id);
    clearTimeout(pending.timer);
    pending.resolve(rpc);
  }

  /**
   * Status changes the robot sends on its own (not an answer to a request):
   * { "dps": { "121": state, "122": battery, ... } }.
   */
  _onPush(payload) {
    if (typeof this.onPush !== "function" || !payload || !payload.length) return;
    try {
      const dps = JSON.parse(payload.toString("utf8")).dps;
      if (!dps || typeof dps !== "object") return;
      const update = {};
      if (typeof dps["121"] === "number") update.state = dps["121"];
      if (typeof dps["122"] === "number") update.battery = dps["122"];
      if (Object.keys(update).length) this.onPush(update);
    } catch {
      /* not a status message */
    }
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
  async send(method, params, { timeoutMs = 15000, background = false } = {}) {
    if (this.local) {
      try {
        const rpc = await this.local.send(method, params);
        this.lastVia = "local";
        return RobotChannel.unwrap(method, rpc);
      } catch (err) {
        if (err.refused) throw err;
        const text = `${this.name}: the direct connection to the robot at ${this.host} did not work for ${method} (${err.message}), using the cloud.`;
        // Shown once every 10 minutes at most, the rest goes to the debug log.
        if (Date.now() - this.lastLocalWarn > 10 * 60 * 1000) {
          this.lastLocalWarn = Date.now();
          this.log.warn(text);
        } else {
          this.log.debug(text);
        }
      }
    }
    // Background requests (the regular status checks) back off when the cloud
    // stops answering, and never reconnect: Roborock blocks accounts that
    // reconnect or ask too often.
    this.lastVia = "cloud";
    if (background && Date.now() < this.cloudPausedUntil) {
      throw new Error(`cloud requests are paused for ${Math.ceil((this.cloudPausedUntil - Date.now()) / 1000)}s after repeated timeouts`);
    }
    try {
      const rpc = await this._sendCloud(method, params, timeoutMs);
      this.cloudTimeouts = 0;
      this.cloudPausedUntil = 0;
      return RobotChannel.unwrap(method, rpc);
    } catch (err) {
      if (err.refused || !err.timeout) throw err;
      this.cloudTimeouts++;
      if (this.cloudTimeouts >= 3) {
        // 1, 2, 4 ... up to 15 minutes.
        const pause = Math.min(60000 * 2 ** (this.cloudTimeouts - 3), 15 * 60 * 1000);
        this.cloudPausedUntil = Date.now() + pause;
      }
      // A command the user asked for gets one more try on a fresh connection,
      // when a reconnect is allowed (at most once every 10 minutes).
      if (background || !this.session.client.reconnect()) throw err;
      this.log.warn(`${this.name}: no answer through the cloud, reconnecting and retrying ${method}.`);
      await new Promise((r) => setTimeout(r, 1500));
      const rpc = await this._sendCloud(method, params, timeoutMs);
      this.cloudTimeouts = 0;
      this.cloudPausedUntil = 0;
      return RobotChannel.unwrap(method, rpc);
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

  /** A map answer arrived: hand it to the request it belongs to. */
  _onMap(payload) {
    const waiter = this.maps.get(mapAnswerId(payload));
    if (!waiter) return;
    // Other apps on the same account get their maps on this topic too; an
    // answer that does not open with our key is theirs, so keep waiting.
    const map = decodeMapAnswer(payload, waiter.nonce);
    if (map) waiter.resolve(map);
  }

  /**
   * The robot's live map, decrypted and unzipped. Maps only travel through
   * the cloud. Not counted in the cloud back-off: a robot that sends no map
   * still answers everything else.
   */
  async getMap(timeoutMs = 12000) {
    await this.session.waitConnected();
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16);
    const payload = P.buildRpcPayload("get_map_v1", [], id, ts, this.session.security(nonce));
    const frame = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.RPC_REQUEST, payload, ts });
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.maps.delete(id);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(`No map from ${this.name}`)), timeoutMs);
      timer.unref?.();
      this.maps.set(id, { nonce, resolve: (map) => finish(resolve, map) });
      // The plain answer is just "ok" (the map follows separately); an error
      // there means no map is coming.
      this.pending.set(id, {
        timer: null,
        resolve: (rpc) => {
          if (rpc.error) finish(reject, new Error(`Robot refused get_map_v1: ${typeof rpc.error === "object" ? JSON.stringify(rpc.error) : rpc.error}`));
          else if (Array.isArray(rpc.result) && rpc.result[0] === "retry") finish(reject, new Error("the map is not ready yet"));
        },
      });
      try {
        this.session._publish(this.duid, frame);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /** Room (segment) ids the robot is cleaning right now, read from the live map. */
  async getCleaningSegments(timeoutMs) {
    return cleaningSegments(await this.getMap(timeoutMs));
  }

  /** The robot's address on the home network (or null). */
  async getIp() {
    const result = await this.send("get_network_info", [], { timeoutMs: 10000, background: true });
    const info = Array.isArray(result) ? result[0] : result;
    return info && info.ip ? String(info.ip) : null;
  }

  /** Returns [{ segmentId, roomId }] — roomId matches the cloud room list. */
  async getRoomMapping() {
    const result = await this.send("get_room_mapping", [], { background: true });
    if (!Array.isArray(result)) return [];
    return result
      .filter((r) => Array.isArray(r) && r.length >= 2)
      .map((r) => ({ segmentId: Number(r[0]), roomId: String(r[1]) }));
  }

  async getStatus() {
    const result = await this.send("get_status", [], { timeoutMs: 8000, background: true });
    return Array.isArray(result) ? result[0] : result;
  }
}

module.exports = { RoborockSession, RobotChannel };
