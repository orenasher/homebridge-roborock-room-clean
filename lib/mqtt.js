"use strict";

/**
 * Minimal MQTT 3.1.1 client over TLS — just enough for Roborock:
 * CONNECT, SUBSCRIBE, PUBLISH (QoS 0/1 in, QoS 0/1 out), PINGREQ,
 * automatic reconnect with backoff. No external dependencies.
 */

const tls = require("tls");
const net = require("net");
const { EventEmitter } = require("events");

const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

function encodeLength(len) {
  const bytes = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    bytes.push(b);
  } while (len > 0);
  return Buffer.from(bytes);
}

function str(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function packet(typeAndFlags, body) {
  return Buffer.concat([Buffer.from([typeAndFlags]), encodeLength(body.length), body]);
}

class MqttClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url       e.g. "ssl://mqtt-eu-3.roborock.com:8883"
   * @param {string} opts.clientId
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {number} [opts.keepalive] seconds
   */
  constructor(opts) {
    super();
    this.opts = { keepalive: 60, ...opts };
    const u = new URL(this.opts.url.replace(/^ssl:/, "mqtts:").replace(/^tcp:/, "mqtt:"));
    this.host = u.hostname;
    this.port = Number(u.port) || (u.protocol === "mqtts:" ? 8883 : 1883);
    this.useTls = u.protocol === "mqtts:";
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.packetId = 1;
    this.subscriptions = new Set();
    this.pendingSubs = new Map();
    this.stopped = false;
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pingOutstanding = false;
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const onConnect = () => this._sendConnect();
    const socket = this.useTls
      ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
      : net.connect({ host: this.host, port: this.port }, onConnect);
    socket.setNoDelay(true);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setTimeout(30000, () => socket.destroy(new Error("MQTT socket timeout")));
    socket.on("data", (d) => this._onData(d));
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", () => this._onClose());
  }

  _nextId() {
    this.packetId = this.packetId >= 65535 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  _write(buf) {
    if (this.socket && !this.socket.destroyed) this.socket.write(buf);
  }

  _sendConnect() {
    const { clientId, username, password, keepalive } = this.opts;
    let flags = 0x02; // clean session
    if (username) flags |= 0x80;
    if (password) flags |= 0x40;
    const ka = Buffer.alloc(2);
    ka.writeUInt16BE(keepalive, 0);
    const body = Buffer.concat([
      str("MQTT"),
      Buffer.from([0x04, flags]),
      ka,
      str(clientId),
      username ? str(username) : Buffer.alloc(0),
      password ? str(password) : Buffer.alloc(0),
    ]);
    this._write(packet(TYPE.CONNECT << 4, body));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= this.buffer.length) return;
        byte = this.buffer[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buffer.length < i + len) return;
      const header = this.buffer[0];
      const body = this.buffer.subarray(i, i + len);
      this.buffer = this.buffer.subarray(i + len);
      try {
        this._handle(header, body);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  _handle(header, body) {
    const type = header >> 4;
    switch (type) {
      case TYPE.CONNACK: {
        const rc = body[1];
        if (rc !== 0) {
          const reasons = { 1: "bad protocol", 2: "client id rejected", 3: "server unavailable", 4: "bad username/password", 5: "not authorized" };
          this.emit("error", new Error(`MQTT connection refused: ${reasons[rc] || rc}`));
          this.socket.destroy();
          return;
        }
        this.connected = true;
        this.reconnectDelay = 2000;
        this.socket.setTimeout(0);
        this._startPing();
        for (const topic of this.subscriptions) this._sendSubscribe(topic).catch((err) => this.emit("error", err));
        this.emit("connect");
        break;
      }
      case TYPE.PUBLISH: {
        const qos = (header >> 1) & 0x03;
        const topicLen = body.readUInt16BE(0);
        const topic = body.toString("utf8", 2, 2 + topicLen);
        let offset = 2 + topicLen;
        if (qos > 0) {
          const id = body.readUInt16BE(offset);
          offset += 2;
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(id, 0);
          this._write(packet(TYPE.PUBACK << 4, ack));
        }
        this.emit("message", topic, Buffer.from(body.subarray(offset)));
        break;
      }
      case TYPE.SUBACK: {
        const id = body.readUInt16BE(0);
        const pending = this.pendingSubs.get(id);
        if (pending) {
          this.pendingSubs.delete(id);
          if (body[2] === 0x80) pending.reject(new Error(`Subscription to ${pending.topic} was refused`));
          else pending.resolve();
        }
        break;
      }
      case TYPE.PINGRESP:
        this.pingOutstanding = false;
        break;
      default:
        break; // PUBACK etc. — nothing to do
    }
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingOutstanding = false;
    this.pingTimer = setInterval(() => {
      if (this.pingOutstanding) {
        // No answer to the previous ping: connection is dead.
        this.socket && this.socket.destroy(new Error("MQTT ping timeout"));
        return;
      }
      this.pingOutstanding = true;
      this._write(Buffer.from([TYPE.PINGREQ << 4, 0]));
    }, this.opts.keepalive * 1000 * 0.75);
    this.pingTimer.unref?.();
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.pingTimer);
    for (const [, p] of this.pendingSubs) p.reject(new Error("MQTT connection closed"));
    this.pendingSubs.clear();
    if (wasConnected) this.emit("offline");
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  _sendSubscribe(topic) {
    const id = this._nextId();
    const idBuf = Buffer.alloc(2);
    idBuf.writeUInt16BE(id, 0);
    this._write(packet((TYPE.SUBSCRIBE << 4) | 0x02, Buffer.concat([idBuf, str(topic), Buffer.from([1])])));
    return new Promise((resolve, reject) => this.pendingSubs.set(id, { topic, resolve, reject }));
  }

  subscribe(topic) {
    this.subscriptions.add(topic);
    if (this.connected) return this._sendSubscribe(topic).catch((err) => this.emit("error", err));
    return Promise.resolve();
  }

  /** Drop the current connection and reconnect right away (used when it has gone quiet). */
  reconnect() {
    if (this.stopped) return;
    this.reconnectDelay = 500;
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    else this.connect();
  }

  publish(topic, payload, qos = 1) {
    if (!this.connected) throw new Error("MQTT is not connected");
    const parts = [str(topic)];
    if (qos > 0) {
      const idBuf = Buffer.alloc(2);
      idBuf.writeUInt16BE(this._nextId(), 0);
      parts.push(idBuf);
    }
    parts.push(payload);
    this._write(packet((TYPE.PUBLISH << 4) | (qos << 1), Buffer.concat(parts)));
  }

  end() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.socket && !this.socket.destroyed) {
      if (this.connected) this._write(Buffer.from([TYPE.DISCONNECT << 4, 0]));
      this.socket.end();
      this.socket.destroy();
    }
  }
}

module.exports = { MqttClient };
