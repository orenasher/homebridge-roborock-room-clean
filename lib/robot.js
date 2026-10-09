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
const { cleaningSegments, mapBlockTypes, decodeMapAnswer, mapAnswerId } = require("./map");

class RoborockSession extends EventEmitter {
  constructor(userData, log, { overhear = true, onOverhearRefused = null } = {}) {
    super();
    this.log = log;
    this.rriot = userData.rriot;
    // One key and one endpoint of our own for the whole session (see mapSecurity).
    this.mapNonce = crypto.randomBytes(16);
    this.mapEndpoint = crypto.randomBytes(6).toString("base64");
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
      if (!channel) return;
      if (topic.startsWith("rr/m/i/")) channel._onRequestSeen(payload);
      else channel._onMessage(payload);
    });
    this.client.subscribe(`rr/m/o/${this.rriot.u}/${this.mqttUser}/#`);
    // The robot sends its map to one app at a time: while the Roborock app is
    // open on its map, our own map requests go unanswered. The app's requests
    // travel on the same account channel and carry the key its maps are
    // encrypted with, so by listening to them the plugin can read the maps
    // the robot is sending to the app anyway. Same account, same robot, same
    // map: nothing is asked of the robot that it is not already doing.
    if (overhear) {
      this.client.on("refused", (topic, how) => {
        this.log.info(
          `The Roborock cloud does not let this plugin see other apps' map requests (${how === "closed" ? "it closed the connection over it" : "it refused"}). ` +
            "A room clean started from the Roborock app will show in Apple Home once the app is closed."
        );
        if (onOverhearRefused) onOverhearRefused(how);
      });
      this.client.subscribeOptional(`rr/m/i/${this.rriot.u}/${this.mqttUser}/#`);
    }
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
  security(nonce = this.mapNonce) {
    return {
      endpoint: P.md5(Buffer.from(this.rriot.k, "utf8")).subarray(8, 14).toString("base64"),
      nonce: nonce.toString("hex"),
    };
  }

  /**
   * Security block for map requests. The robot echoes the "endpoint" on its
   * answer and encrypts the map with the "nonce".
   *
   * Every app on the account shares one cloud channel, and apps that derive
   * the endpoint from the account (as the block above does) all get the same
   * one, each with a key of its own. So this plugin asks under an endpoint
   * nobody else has, with one key for the whole session. `shared` asks the
   * other way (the account's endpoint, same key), for robots that only answer
   * that one.
   */
  /** A new key and endpoint of our own for map requests, as after a restart. */
  renewMapKey() {
    this.mapNonce = crypto.randomBytes(16);
    this.mapEndpoint = crypto.randomBytes(6).toString("base64");
  }

  mapSecurity(shared = false) {
    return { endpoint: shared ? this.security().endpoint : this.mapEndpoint, nonce: this.mapNonce.toString("hex") };
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
    this.maps = new Map(); // request id -> { nonce, resolve, ... } (map requests waiting for their answer)
    this.mapShared = null; // which endpoint map requests worked with (see mapSecurity), once known
    this.mapLocal = null; // true/false once it is known whether the robot sends maps over the home network
    this.mapFails = 0; // map requests in a row that brought no map
    this.otherKeys = []; // [{ endpoint, nonce }]: the keys of other apps' live-map requests seen on the account channel, newest first
    this.notLive = []; // request ids of other apps' requests that are not for the live map
    this.stash = null; // { payload, at, map, other }: a map answer nobody was waiting for, kept for a few seconds
    this.overheardSaid = 0;
    this.mapLocalRetries = 0;
    this.onPush = null; // called with { state, battery } when the robot reports a change by itself
    this.onMap = null; // called with every map that was read (the map camera draws it)
    this.mapFlight = null; // the map request under way, shared by everyone who asks meanwhile
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
    if (!msg) {
      // Remembered for the log while a map is awaited: a map that arrives in a form we cannot read looks like no map at all.
      for (const waiter of this.maps.values()) {
        waiter.note.unread = `${frame.length} bytes, version "${frame.toString("latin1", 0, 3).replace(/[^ -~]/g, "?")}", protocol ${frame.length >= 17 ? frame.readUInt16BE(15) : "?"}`;
      }
      return;
    }
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

  /**
   * A request another app sent to the robot (seen on the account channel).
   * Only one thing is taken from it: the endpoint and key of its requests for
   * the live map, so the maps the robot sends that app can be read too.
   */
  _onRequestSeen(frame) {
    const msg = P.decodeMessage(frame, this.localKey);
    if (!msg || !msg.payload.length) return;
    let request;
    try {
      const dp = JSON.parse(msg.payload.toString("utf8")).dps["101"];
      request = typeof dp === "string" ? JSON.parse(dp) : dp;
    } catch {
      return;
    }
    const security = request && request.security;
    if (!security || typeof security.endpoint !== "string" || !security.endpoint || !/^[0-9a-f]{32}$/i.test(security.nonce || "")) return;
    const nonce = Buffer.from(security.nonce, "hex");
    if (nonce.equals(this.session.mapNonce)) return; // one of our own requests
    if (!/^get_(fresh_)?map(_v\d+)?$/i.test(String(request.method))) {
      // Anything else that is answered with a map-like message (a saved map,
      // the map of an old clean) must not be taken for the live map.
      this.notLive.push(Number(request.id) & 0xffff);
      if (this.notLive.length > 40) this.notLive.shift();
      return;
    }
    const known = this.otherKeys.findIndex((k) => k.endpoint === security.endpoint && k.nonce.equals(nonce));
    if (known === 0) return;
    if (known > 0) this.otherKeys.splice(known, 1);
    else this.log.debug(`${this.name}: another app is asking the robot for its live map.`);
    this.otherKeys.unshift({ endpoint: security.endpoint, nonce });
    this.otherKeys.length = Math.min(this.otherKeys.length, 12);
  }

  /** A map answer arrived: hand it to the request that is waiting for one. */
  _onMap(payload) {
    const waiters = [...this.maps.values()];
    let map = null;
    for (const waiter of waiters) {
      waiter.note.answers++;
      if (mapAnswerId(payload) === waiter.id || payload.toString("latin1", 0, 15).startsWith(waiter.endpoint)) waiter.note.ours++;
      map = map || decodeMapAnswer(payload, waiter.nonce);
    }
    if (!map) {
      // Not an answer to a request that is waiting. Kept for a moment when it
      // can be opened later: an answer to another app whose live-map request
      // was seen, or a late one of our own. Opened only when a map is wanted.
      const tag = payload.toString("latin1", 0, 15);
      const own = tag.startsWith(this.session.mapEndpoint) || tag.startsWith(this.session.security().endpoint);
      const other = this.otherKeys.some((k) => tag.startsWith(k.endpoint)) && !this.notLive.includes(mapAnswerId(payload));
      if (!own && !other) return;
      this.stash = { payload: Buffer.from(payload), at: Date.now(), map: undefined, other: false };
      if (waiters.length) map = this._openStash();
    }
    if (map) for (const waiter of waiters) waiter.resolve(map);
  }

  /** The map kept by _onMap, opened, while it is fresh; null when there is none or it cannot be opened. */
  _openStash() {
    const stash = this.stash;
    if (!stash || Date.now() - stash.at > 10000) {
      this.stash = null;
      return null;
    }
    if (stash.map === undefined) {
      stash.map = decodeMapAnswer(stash.payload, this.session.mapNonce);
      if (!stash.map) {
        const tag = stash.payload.toString("latin1", 0, 15);
        for (const key of this.otherKeys) {
          if (!tag.startsWith(key.endpoint)) continue;
          stash.map = decodeMapAnswer(stash.payload, key.nonce);
          if (stash.map) break;
        }
        stash.other = !!stash.map;
      }
      stash.payload = null;
    }
    if (stash.map && stash.other && Date.now() - this.overheardSaid > 10 * 60 * 1000) {
      this.overheardSaid = Date.now();
      this.log.info(`${this.name}: the robot is sending its map to another app (the Roborock app is open); reading that map.`);
    }
    return stash.map;
  }

  /** One get_map_v1 request. Rejects with `.retry` when the robot asks to try again in a moment. */
  _askMap(timeoutMs, shared, note) {
    const id = P.nextRequestId();
    const ts = Math.floor(Date.now() / 1000);
    const security = this.session.mapSecurity(shared);
    const payload = P.buildRpcPayload("get_map_v1", [], id, ts, security);
    const frame = P.encodeMessage({ localKey: this.localKey, protocol: P.PROTOCOL.RPC_REQUEST, payload, ts });
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.maps.delete(id);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("timed out")), timeoutMs);
      timer.unref?.();
      this.maps.set(id, { id, endpoint: security.endpoint, nonce: Buffer.from(security.nonce, "hex"), note, resolve: (map) => finish(resolve, map) });
      // The plain answer is just "ok" (the map follows separately); "retry"
      // means the map is being prepared, an error that none is coming.
      this.pending.set(id, {
        timer: null,
        resolve: (rpc) => {
          const result = Array.isArray(rpc.result) ? rpc.result[0] : rpc.result;
          if (rpc.error) finish(reject, new Error(`the robot refused: ${typeof rpc.error === "object" ? JSON.stringify(rpc.error) : rpc.error}`));
          else if (result === "retry") finish(reject, Object.assign(new Error("retry"), { retry: true }));
          else note.acknowledged = true;
        },
      });
      try {
        this.session._publish(this.duid, frame);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /**
   * The robot's live map, decrypted and unzipped. Maps only travel through
   * the cloud. Not counted in the cloud back-off: a robot that sends no map
   * still answers everything else.
   *
   * `attempt` picks how to ask until one way has worked (see mapSecurity):
   * odd attempts under this plugin's own endpoint, even ones under the
   * account's. When no map comes, the error says what did happen.
   */
  getMap(timeoutMs = 8000, attempt = 1) {
    // One request at a time: whoever asks while a map is on its way gets that one.
    if (!this.mapFlight) {
      this.mapFlight = this._getMap(timeoutMs, attempt)
        .then((map) => {
          if (typeof this.onMap === "function") {
            try {
              this.onMap(map);
            } catch (err) {
              this.log.debug(`${this.name}: ${err.message}`);
            }
          }
          this.mapFails = 0;
          return map;
        })
        .catch((err) => {
          // After a few misses in a row, what was learnt about asking for maps is set aside and
          // found out again, with a key of our own that the robot has not seen: the robot can
          // stop answering the way that worked (after the Roborock app was open on the map),
          // and until now only a restart brought the map back.
          if (++this.mapFails % 3 === 0) {
            this.log.debug(`${this.name}: ${this.mapFails} map requests in a row brought no map; asking every way again.`);
            this.mapShared = null;
            if (this.mapLocal === false) {
              this.mapLocal = null;
              this.mapLocalRetries = 0;
            }
            this.session.renewMapKey();
            // A restart has always brought the map back; what a restart does that the steps above
            // do not is a new connection to the Roborock cloud. One is made, at most every half hour
            // (Roborock does not like connections made over and over).
            if (this.mapFails >= 6 && Date.now() - (this.session.mapReconnectAt || 0) > 30 * 60 * 1000 && this.session.client.reconnect()) {
              this.session.mapReconnectAt = Date.now();
              this.log.info(`${this.name}: no map for a while; connecting to the Roborock cloud afresh.`);
            }
          }
          throw err;
        })
        .finally(() => {
          this.mapFlight = null;
        });
    }
    return this.mapFlight;
  }

  async _getMap(timeoutMs, attempt) {
    // A map the robot sent a moment ago (to another app, or late to us) is as good as a new one.
    let kept = this._openStash();
    if (kept) return kept;
    // First over the home network, where no other app is in the way. Whether
    // the robot sends maps there is found out once and remembered.
    if (this.local && this.mapLocal !== false) {
      try {
        const answer = await this.local.sendMap(this.session.mapSecurity(), 3000);
        const map = decodeMapAnswer(answer, this.session.mapNonce);
        if (!map) throw new Error(`a map answer of ${answer.length} bytes arrived but could not be opened`);
        if (!this.mapLocal) this.log.info(`${this.name}: the map is read over the home network.`);
        this.mapLocal = true;
        return map;
      } catch (err) {
        // The robot may have taken the request there and sent the map through the cloud.
        kept = this._openStash();
        if (kept) return kept;
        // A connection that is down says nothing about maps, and "retry" only
        // that the map was not ready: an open connection that brought none does.
        // Once maps have come over the home network, one that does not come is a
        // miss (the robot busy, the Roborock app open), never a reason to stop asking there.
        const conclusive = this.mapLocal !== true && this.local.socket && (!err.retry || ++this.mapLocalRetries >= 6);
        if (conclusive) {
          this.log.info(`${this.name}: no map over the home network (${err.message}); maps are read through the Roborock cloud.`);
          this.mapLocal = false;
        }
      }
    }
    await this.session.waitConnected();
    const shared = this.mapShared != null ? this.mapShared : attempt % 2 === 0;
    const note = { answers: 0, ours: 0, acknowledged: false, retries: 0 };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const map = await this._askMap(Math.max(100, deadline - Date.now()), shared, note);
        // Only an answer to our own request says which way of asking works.
        if (!this.stash || this.stash.map !== map) this.mapShared = shared;
        return map;
      } catch (err) {
        if (err.retry && note.retries < 4 && Date.now() + 1500 < deadline) {
          note.retries++;
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        let what;
        if (err.retry) what = `the robot answered "retry" ${note.retries + 1} times`;
        else if (err.message !== "timed out") what = err.message;
        else if (note.answers) what = `${note.answers} map answer(s) arrived, ${note.ours} marked as ours, none could be opened`;
        else what = note.acknowledged ? "the robot said ok but sent no map" : "no answer";
        if (note.unread) what += `; a message that could not be read arrived (${note.unread})`;
        if (note.answers) what += `; keys of other apps known: ${this.otherKeys.length}`;
        throw new Error(`${what} (${shared ? "account" : "own"} endpoint)`);
      }
    }
  }

  /**
   * Room (segment) ids the robot is cleaning right now, read from the live
   * map, and the kinds of blocks that map has (for the log when no rooms are marked).
   */
  async getCleaning(timeoutMs, attempt) {
    const map = await this.getMap(timeoutMs, attempt);
    return { rooms: cleaningSegments(map), blocks: mapBlockTypes(map) };
  }

  async getCleaningSegments(timeoutMs, attempt) {
    return (await this.getCleaning(timeoutMs, attempt)).rooms;
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
