"use strict";

/**
 * The picture of one robot's map, kept current for the map camera.
 *
 * The robot is only asked for its map while somebody is looking: while the
 * camera is open in Apple Home the map is read every few seconds (once a
 * minute while the robot stands still), and each time Home refreshes the
 * camera's tile. One more read is done when a clean ends, so the tile shows
 * the finished clean.
 *
 * The last map is kept on disk, so after a restart there is a picture at once.
 */

const fs = require("fs");
const zlib = require("zlib");
const { hasFloorPlan, carpetOf } = require("./rrmap");

const MOVING_MS = 5000; // between map reads while the robot drives
const STILL_MS = 60000; // ... while it stands still
const WATCH_MS = 30000; // one look at the tile counts as "looking" for this long
const SNAPSHOT_WAIT_MS = 2500; // how long a snapshot waits for a fresher picture
const SAVE_EVERY_MS = 60000;
const RETRY_DRAW_MS = 60000; // a picture that could not be drawn is tried again after this long

/** States in which the robot does not move. */
const STILL = new Set([2, 3, 8, 9, 10, 12, 13, 14, 100]);

class MapView {
  /**
   * options:
   *   log, name        for the log
   *   channel          RobotChannel (getMap)
   *   painter          Painter
   *   file             where the last map is kept
   *   options()        the drawing options (theme, colours, rooms, ...)
   *   status()         the robot's status, or null
   */
  constructor(options) {
    Object.assign(this, options);
    this.raw = null; // the last map (decrypted, unzipped)
    this.rawAt = 0;
    this.png = null;
    this.size = null;
    this.drawnKey = "";
    this.drawing = null; // promise while a picture is being drawn
    this.fetching = null; // promise while the robot is being asked
    this.failures = 0;
    this.nextFetchAt = 0;
    this.watchUntil = 0;
    this.live = false;
    this.timer = null;
    this.savedAt = 0;
    this.attempt = 0;
    this.saidNoMap = false;
    this.version = 0; // goes up whenever the map itself changed
    this.again = false;
    this.failedKey = "";
    this.failedAt = 0;
    this.carpet = null; // { width, height, left, top, data }: the carpets last seen on a map
    this.saidBeyond = "";
    this.stopped = false;
  }

  /** Read the map kept from before the restart. */
  load() {
    try {
      this.raw = zlib.gunzipSync(fs.readFileSync(this.file));
      this.version++;
      this.carpet = carpetOf(this.raw);
      this.rawAt = fs.statSync(this.file).mtimeMs;
      this.savedAt = Date.now();
    } catch {
      this.raw = null;
    }
    return !!this.raw;
  }

  _save(force) {
    if (!this.raw || (!force && Date.now() - this.savedAt < SAVE_EVERY_MS)) return;
    this.savedAt = Date.now();
    const file = this.file;
    zlib.gzip(this.raw, (err, packed) => {
      if (err) return;
      fs.writeFile(`${file}.tmp`, packed, (failed) => {
        if (failed) return this.log.debug(`${this.name}: could not keep the map on disk (${failed.message}).`);
        fs.rename(`${file}.tmp`, file, () => {});
      });
    });
  }

  moving() {
    const status = this.status();
    return !!status && typeof status.state === "number" && !STILL.has(status.state);
  }

  watched() {
    return this.live || Date.now() < this.watchUntil;
  }

  /** A map arrived (asked for here, or by the part that follows cleans started in the Roborock app). */
  offer(map) {
    if (!Buffer.isBuffer(map) || this.stopped) return;
    this.failures = 0;
    if (this.saidNoMap) this.log.info(`${this.name}: the robot is sending its map again.`);
    this.saidNoMap = false;
    this.nextFetchAt = Date.now() + (this.moving() ? MOVING_MS : STILL_MS);
    // A map without a floor plan (the robot sends those now and then) never replaces one that has it.
    if (this.raw && !hasFloorPlan(map)) return;
    if (!this.raw || this.raw.length !== map.length || !this.raw.equals(map)) {
      this.version++;
      // Carpets are remembered from the last map that had them.
      const carpet = carpetOf(map);
      if (carpet) this.carpet = carpet;
    }
    this.raw = map;
    this.rawAt = Date.now();
    this._save(false);
    if (this.watched()) this.draw();
  }

  /** The robot's status changed: the status line needs redrawing, and a clean that just ended is worth one last map. */
  statusChanged(before, now) {
    if (this.stopped) return;
    const wasMoving = !!before && typeof before.state === "number" && !STILL.has(before.state);
    const isMoving = !!now && typeof now.state === "number" && !STILL.has(now.state);
    if (wasMoving !== isMoving) this.nextFetchAt = Math.min(this.nextFetchAt, Date.now() + 1500);
    if (wasMoving && !isMoving && !this.watched()) {
      // One read after the robot stopped, so the tile shows how the clean ended.
      setTimeout(() => {
        if (!this.stopped) this.fetch().then(() => this._save(true), () => {});
      }, 3000).unref?.();
    }
    if (this.watched()) this.draw();
  }

  /** Somebody is looking at the tile: a map that arrives in the next while is drawn at once. */
  watch(ms = WATCH_MS) {
    this.watchUntil = Math.max(this.watchUntil, Date.now() + ms);
  }

  setLive(on) {
    this.live = !!on;
    if (on) this._tick();
  }

  _tick() {
    if (this.timer || this.stopped) return;
    const step = () => {
      this.timer = null;
      if (this.stopped || !this.live) return;
      if (Date.now() >= this.nextFetchAt && !this.fetching) this.fetch().catch(() => {});
      this.timer = setTimeout(step, 1000);
      this.timer.unref?.();
    };
    step();
  }

  /** Ask the robot for its map now. Resolves when it arrived (and was handed to offer). */
  fetch() {
    if (this.fetching) return this.fetching;
    this.nextFetchAt = Date.now() + (this.moving() ? MOVING_MS : STILL_MS); // also holds while the request is under way
    this.fetching = this.channel
      .getMap(6000, ++this.attempt)
      .then((map) => {
        if (this.raw !== map) this.offer(map); // normally already offered through the channel
      })
      .catch((err) => {
        this.failures++;
        // The robot is left alone for longer after every miss: 8, 16, 32 seconds, then once a minute.
        this.nextFetchAt = Date.now() + Math.min(60000, 4000 * 2 ** this.failures);
        this.log.debug(`${this.name}: no map this time (${err.message}).`);
        if (this.failures >= 3 && !this.saidNoMap) {
          this.saidNoMap = true;
          this.log.info(
            `${this.name}: the robot is not sending its map right now (it sends it to one viewer at a time, so not while the Roborock app is open on the map). ` +
              "The camera shows the last map and keeps trying."
          );
        }
        throw err;
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  /** Draw the picture again if anything it shows has changed. Resolves when the picture is current. */
  draw() {
    if (this.stopped) return Promise.resolve();
    if (this.drawing) {
      this.again = true;
      return this.drawing;
    }
    const options = { ...this.options(), status: this.status(), mapAt: this.rawAt };
    const carpet = this.carpet;
    const status = options.status || {};
    // "now" only matters for the note about an old map: it changes the picture once, not every second.
    const stale = !!this.rawAt && Date.now() - this.rawAt > 90000;
    const key = JSON.stringify([this.version, stale, status.state, status.battery, Math.round((status.clean_area || 0) / 1e6), Math.round((status.clean_time || 0) / 60), { ...options, status: null, mapAt: 0 }]);
    if (key === this.drawnKey && this.png) return Promise.resolve();
    // This very picture could not be drawn a moment ago: not tried again right away, unless something changes.
    if (key === this.failedKey && Date.now() - this.failedAt < RETRY_DRAW_MS) return Promise.resolve();
    options.now = stale ? Date.now() : this.rawAt;
    if (carpet && options.carpets !== false) options.lastCarpet = carpet; // not part of the key above: it only ever changes together with the map
    this.again = false;
    this.drawing = this.painter
      .paint(this.raw, options)
      .then((out) => {
        this.png = out.png;
        this.size = { width: out.width, height: out.height, background: out.background };
        this.drawnKey = key;
        this.failedKey = "";
        this._sayBeyond(out.beyond);
      })
      .catch((err) => {
        const again = this.failedKey === key;
        this.failedKey = key;
        this.failedAt = Date.now();
        this.log[again ? "debug" : "warn"](`${this.name}: the map could not be drawn (${err.message}). The camera keeps its last picture.`);
        // Never without a picture: with nothing drawn yet, the "no map yet" one stands in.
        if (!this.png) {
          return this.painter.paint(null, options).then(
            (out) => {
              this.png = out.png;
              this.size = { width: out.width, height: out.height, background: out.background };
            },
            () => {}
          );
        }
      })
      .then(() => {
        this.drawing = null;
        if (this.again) return this.draw();
      });
    return this.drawing;
  }

  /** Say in the log, whenever it changes, what the "leave out what lies beyond a virtual wall" setting came to. */
  _sayBeyond(beyond) {
    const now = beyond ? `${beyond.walls}:${beyond.cells}` : "";
    if (now === this.saidBeyond) return;
    this.saidBeyond = now;
    if (!beyond) return;
    if (!beyond.walls) this.log.info(`${this.name}: nothing is left out beyond virtual walls: the robot's map has no virtual wall.`);
    else if (!beyond.cells) {
      this.log.info(
        `${this.name}: the map has ${beyond.walls} virtual wall(s), but nothing is left out: no piece of a room lies wholly beyond one. ` +
          "A patch stays when it still hangs on to the home around the end of the wall: draw the wall longer than the place where they touch."
      );
    } else this.log.info(`${this.name}: ${beyond.walls} virtual wall(s) on the map; ${(beyond.cells * 0.0025).toFixed(1)} m² of floor beyond them is left off the picture.`);
  }

  /** The picture for a snapshot: the current one, or a fresher one when that takes only a moment. */
  async snapshot() {
    this.watch();
    const fresh = (async () => {
      if (Date.now() >= this.nextFetchAt) await this.fetch().catch(() => {});
      else if (this.fetching) await this.fetching.catch(() => {});
      await this.draw();
    })();
    await Promise.race([fresh, new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
    // Nothing drawn yet and the robot is slow: show what there is (the kept map, or "no map yet").
    if (!this.png) await this.draw();
    return this.png;
  }

  picture() {
    return this.png;
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.raw) {
      try {
        fs.writeFileSync(this.file, zlib.gzipSync(this.raw));
      } catch {
        /* the map is read again after the restart */
      }
    }
  }
}

module.exports = { MapView };
