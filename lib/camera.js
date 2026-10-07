"use strict";

/**
 * A camera in Apple Home that shows a picture this plugin draws (the robot's
 * map). The tile in Home shows the picture as a snapshot; opening the camera
 * shows it live, sent as video by ffmpeg.
 *
 * The camera is its own accessory (not part of the bridge), which is how
 * Apple Home wants cameras: it is added once with the bridge's setup code.
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const FRAME_MS = 500; // how often the current picture is handed to ffmpeg
const OUT_FPS = 10;
const MAX_STREAM_MS = 30 * 60 * 1000; // a live view left open is closed after this long
const UNUSED_SESSION_MS = 60 * 1000; // a live view that was prepared but never started is forgotten after this long

/**
 * Where ffmpeg may be: the path from the settings, a copy that came with
 * another camera plugin (the ffmpeg-for-homebridge package, next to this
 * plugin or inside a plugin installed beside it), then the system's own.
 */
function ffmpegCandidates(configured, pluginsDir = path.resolve(__dirname, "..", "..")) {
  const list = [];
  if (configured && String(configured).trim()) list.push(String(configured).trim());
  const bundled = (dir) => {
    try {
      const found = require(path.join(dir, "ffmpeg-for-homebridge"));
      if (typeof found === "string" && found && !list.includes(found)) list.push(found);
    } catch {
      /* not there */
    }
  };
  try {
    bundled(pluginsDir);
    for (const name of fs.readdirSync(pluginsDir)) {
      if (name.startsWith(".")) continue;
      const dir = path.join(pluginsDir, name);
      if (name.startsWith("@")) {
        let scopedNames = [];
        try {
          scopedNames = fs.readdirSync(dir);
        } catch {
          /* not a folder */
        }
        for (const scoped of scopedNames) bundled(path.join(dir, scoped, "node_modules"));
      } else {
        bundled(path.join(dir, "node_modules"));
      }
    }
  } catch {
    /* an unusual install: the system's ffmpeg is still tried */
  }
  list.push("ffmpeg");
  return list;
}

/** The first candidate that runs, or null. Never throws: a wrong path in the settings must not stop Homebridge. */
function findFfmpeg(configured) {
  let candidates;
  try {
    candidates = ffmpegCandidates(configured);
  } catch {
    candidates = ["ffmpeg"];
  }
  return new Promise((resolve) => {
    const next = (n) => {
      if (n >= candidates.length) return resolve(null);
      try {
        execFile(candidates[n], ["-version"], { timeout: 10000 }, (err) => (err ? next(n + 1) : resolve(candidates[n])));
      } catch {
        next(n + 1); // not something that can be run at all (a folder, a broken path)
      }
    };
    next(0);
  });
}

class PictureCamera {
  /**
   * options:
   *   api, log
   *   pluginName       for publishing
   *   name             the camera's name in Apple Home
   *   id               stable text the accessory's identity is made from
   *   info             { manufacturer, model, serial, firmware }
   *   ffmpegPath       optional path from the settings
   *   snapshot()       async: the current picture as PNG (may wait briefly for a fresher one)
   *   picture()        the current picture as PNG, at once (may be null)
   *   size()           { width, height, background } of the current picture (background: "#rrggbb", fills the edges if a later picture has another shape)
   *   watching(on)     called when a live view starts (true) and when the last one ends (false)
   */
  constructor(options) {
    Object.assign(this, options);
    this.hap = this.api.hap;
    this.sessions = new Map(); // session id -> { address, port, key, salt, ssrc, ffmpeg, timer, stop }
    this.ffmpeg = undefined; // path once found; null when there is none
    this.accessory = null;
  }

  publish() {
    const { hap, api } = this;
    const uuid = hap.uuid.generate(`${this.pluginName}:camera:${this.id}`);
    const accessory = new api.platformAccessory(this.name, uuid, hap.Categories.CAMERA);
    const info = accessory.getService(hap.Service.AccessoryInformation);
    info
      .setCharacteristic(hap.Characteristic.Manufacturer, this.info.manufacturer || "Roborock")
      .setCharacteristic(hap.Characteristic.Model, this.info.model || "Map")
      .setCharacteristic(hap.Characteristic.SerialNumber, this.info.serial || this.id);
    if (this.info.firmware) info.setCharacteristic(hap.Characteristic.FirmwareRevision, this.info.firmware);
    const controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 15],
            [1280, 960, 15],
            [1280, 720, 15],
            [1024, 768, 15],
            [640, 480, 15],
            [640, 360, 15],
            [480, 360, 15],
            [480, 270, 15],
            [320, 240, 15],
            [320, 180, 15],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
      },
    });
    this.controller = controller;
    accessory.configureController(controller);
    this.accessory = accessory;
    api.publishExternalAccessories(this.pluginName, [accessory]);
    findFfmpeg(this.ffmpegPath).catch(() => null).then((found) => {
      this.ffmpeg = found;
      if (found && this.ffmpegPath && String(this.ffmpegPath).trim() !== found) {
        this.log.warn(`${this.name}: ffmpeg was not found at "${this.ffmpegPath}" (the ffmpegPath setting); using ${found} instead.`);
      }
      if (!found) {
        this.log.warn(
          `${this.name}: ffmpeg was not found, so the camera shows the map as a picture that refreshes every few seconds, without live view. ` +
            "To get the live view install ffmpeg (on a Raspberry Pi: sudo apt install -y ffmpeg) and restart Homebridge."
        );
      }
    });
    return accessory;
  }

  // ----- what Apple Home asks of a camera

  handleSnapshotRequest(request, callback) {
    Promise.resolve()
      .then(() => this.snapshot())
      .then((png) => {
        if (!png) throw new Error("no picture yet");
        return this.asJpeg(png);
      })
      .then((image) => callback(undefined, image))
      .catch((err) => {
        this.log.debug(`${this.name}: no snapshot (${err.message}).`);
        callback(err);
      });
  }

  /**
   * Apple Home expects snapshots as JPEG. ffmpeg makes one from the PNG (kept
   * until the picture changes); without ffmpeg, or if that fails, the PNG
   * itself is sent, which Home shows as well.
   */
  asJpeg(png) {
    if (!this.ffmpeg) return Promise.resolve(png);
    if (this.jpegOf === png && this.jpeg) return Promise.resolve(this.jpeg);
    if (this.jpegMaking && this.jpegMaking.png === png) return this.jpegMaking.promise;
    const making = { png, promise: null };
    this.jpegMaking = making;
    making.promise = new Promise((resolve) => {
      const parts = [];
      let done = false;
      let timer = null;
      const finish = (image) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.jpegMaking === making) this.jpegMaking = null;
        if (image) {
          this.jpegOf = png;
          this.jpeg = image;
        }
        resolve(image || png);
      };
      let child;
      try {
        child = spawn(
          this.ffmpeg,
          ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-vf", "scale=out_color_matrix=bt601:out_range=pc,format=yuvj444p", "-q:v", "2", "-f", "mjpeg", "pipe:1"],
          { stdio: ["pipe", "pipe", "ignore"] }
        );
      } catch {
        return finish(null);
      }
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 4000);
      child.stdout.on("data", (chunk) => parts.push(chunk));
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        const image = Buffer.concat(parts);
        finish(code === 0 && image.length > 100 && image[0] === 0xff && image[1] === 0xd8 ? image : null);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(png);
    });
    return making.promise;
  }

  prepareStream(request, callback) {
    const ssrc = this.hap.CameraController.generateSynchronisationSource();
    const id = request.sessionID;
    this._stop(id); // the same session prepared twice: start clean
    const session = {
      address: request.targetAddress,
      port: request.video.port,
      key: request.video.srtp_key,
      salt: request.video.srtp_salt,
      ssrc,
    };
    session.unused = setTimeout(() => {
      if (this.sessions.get(id) === session && !session.started) this.sessions.delete(id);
    }, UNUSED_SESSION_MS);
    session.unused.unref?.();
    this.sessions.set(id, session);
    callback(undefined, {
      video: { port: request.video.port, ssrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
    });
  }

  handleStreamRequest(request, callback) {
    const session = this.sessions.get(request.sessionID);
    if (request.type === "start") {
      if (!session) return callback(new Error("unknown session"));
      if (session.started) return callback(); // already running
      if (!this.ffmpeg) {
        this.sessions.delete(request.sessionID);
        this.log.warn(`${this.name}: live view was asked for, but ffmpeg is not installed.`);
        return callback(new Error("ffmpeg is not installed"));
      }
      try {
        this._start(request, session);
        callback();
      } catch (err) {
        this.log.warn(`${this.name}: could not start the live view: ${err.message}`);
        this._stop(request.sessionID);
        callback(err);
      }
      return;
    }
    if (request.type === "stop") this._stop(request.sessionID);
    callback();
  }

  // ----- live view

  streamArguments(request, session, picture) {
    const video = request.video;
    const fit = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
    const width = fit(video.width, 1280);
    const height = fit(video.height, 720);
    // The picture keeps its own shape inside the size Apple Home asked for.
    const ratio = Math.min(width / picture.width, height / picture.height);
    const outW = Math.max(2, Math.round((picture.width * ratio) / 2) * 2);
    const outH = Math.max(2, Math.round((picture.height * ratio) / 2) * 2);
    const bitrate = Math.max(150, fit(video.max_bit_rate, 800));
    const profile = ["baseline", "main", "high"][video.profile] || "main";
    const level = ["3.1", "3.2", "4.0"][video.level] || "4.0";
    return [
      "-hide_banner",
      "-loglevel", "warning",
      "-probesize", "32768",
      "-analyzeduration", "0",
      "-use_wallclock_as_timestamps", "1",
      "-f", "image2pipe",
      "-c:v", "png",
      "-i", "pipe:0",
      "-an", "-sn", "-dn",
      "-vf", `fps=${OUT_FPS},scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${outW}:${outH}:-1:-1:color=${/^#[0-9a-f]{6}$/i.test(picture.background || "") ? `0x${picture.background.slice(1)}` : "black"},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      // Said in the video itself, so the colours come out the same on every Apple device.
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-color_range", "tv",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-profile:v", profile,
      "-level:v", level,
      "-g", String(OUT_FPS * 2),
      "-b:v", `${bitrate}k`,
      "-maxrate", `${bitrate}k`,
      "-bufsize", `${bitrate * 2}k`,
      "-payload_type", String(fit(video.pt, 99)),
      "-ssrc", String(session.ssrc),
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", Buffer.concat([session.key, session.salt]).toString("base64"),
      `srtp://${session.address.includes(":") ? `[${session.address}]` : session.address}:${session.port}?rtcpport=${session.port}&pkt_size=${Math.min(1316, fit(video.mtu, 1316))}`,
    ];
  }

  _start(request, session) {
    const first = this.picture();
    if (!first) throw new Error("no picture yet");
    clearTimeout(session.unused);
    const size = this.size() || { width: 1280, height: 960 };
    const child = spawn(this.ffmpeg, this.streamArguments(request, session, size), { stdio: ["pipe", "ignore", "pipe"] });
    session.ffmpeg = child;
    let said = "";
    child.stderr.on("data", (chunk) => {
      said = (said + chunk).slice(-600);
    });
    child.stdin.on("error", () => {}); // ffmpeg gone: the exit handler deals with it
    child.on("error", (err) => {
      this.log.warn(`${this.name}: ffmpeg could not be started (${err.message}).`);
      this._stop(request.sessionID, true);
    });
    child.on("exit", (code, signal) => {
      if (session.stopped) return;
      this.log.warn(`${this.name}: the live view ended by itself (ffmpeg ${signal || `code ${code}`})${said.trim() ? `: ${said.trim().split("\n").pop()}` : "."}`);
      this._stop(request.sessionID, true);
    });
    // The picture is handed over again and again; ffmpeg turns that into steady video.
    let waiting = false;
    const feed = () => {
      if (session.stopped || waiting) return;
      const png = this.picture() || first;
      if (!child.stdin.writable) return;
      if (!child.stdin.write(png)) {
        waiting = true;
        child.stdin.once("drain", () => {
          waiting = false;
        });
      }
    };
    feed();
    session.timer = setInterval(feed, FRAME_MS);
    session.limit = setTimeout(() => {
      this.log.debug(`${this.name}: closing a live view that was open for ${MAX_STREAM_MS / 60000} minutes.`);
      this._stop(request.sessionID, true);
    }, MAX_STREAM_MS);
    session.started = true;
    if (this.watching && this._live() === 1) this.watching(true);
  }

  _live() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.started && !s.stopped) n++;
    return n;
  }

  _stop(id, tellHome) {
    const session = this.sessions.get(id);
    if (!session) return;
    const wasLive = session.started && !session.stopped;
    session.stopped = true;
    this.sessions.delete(id);
    clearInterval(session.timer);
    clearTimeout(session.limit);
    clearTimeout(session.unused);
    if (session.ffmpeg) {
      try {
        session.ffmpeg.stdin.destroy();
        session.ffmpeg.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (tellHome && this.controller) {
      try {
        this.controller.forceStopStreamingSession(id);
      } catch {
        /* the session is already closed on Apple Home's side */
      }
    }
    if (wasLive && this.watching && this._live() === 0) this.watching(false);
  }

  /** Stop everything (Homebridge is shutting down). */
  close() {
    for (const id of [...this.sessions.keys()]) this._stop(id);
  }
}

module.exports = { PictureCamera, findFfmpeg, ffmpegCandidates };
