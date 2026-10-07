"use strict";

/**
 * Draws pictures off the main thread, one at a time, so Homebridge never
 * pauses for a drawing.
 *
 * A drawing that takes far too long is given up (the camera keeps its last
 * picture) and the worker thread is replaced. Only where worker threads
 * cannot be used at all are pictures drawn in place.
 */

const path = require("path");
const { makePicture } = require("./picture");

const IDLE_MS = 2 * 60 * 1000; // the worker is let go after this long without work
const JOB_MS = 20000; // no drawing may take longer
const MAX_CRASHES = 3; // failures in a row of a worker that never drew anything, before drawing in place

class Painter {
  constructor(log) {
    this.log = log;
    this.worker = null;
    this.inline = false;
    this.jobs = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;
    this.idle = null;
    this.crashes = 0;
    this.worked = false; // a worker has drawn at least one picture
    this.queue = Promise.resolve();
    this.jobMs = JOB_MS;
  }

  /** Resolves with { png, width, height, hasMap, rooms }. Rejects when the picture could not be drawn. */
  paint(map, options) {
    const run = () => this._paint(map, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  _paint(map, options) {
    if (this.inline) return Promise.resolve().then(() => makePicture(map, options));
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = this._worker();
      } catch (err) {
        // No worker threads here: draw in place, now and from now on.
        this._inline(err);
        try {
          resolve(makePicture(map, options));
        } catch (failed) {
          reject(failed);
        }
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.jobs.delete(id)) return;
        this._drop(worker);
        reject(new Error(`drawing took longer than ${Math.round(this.jobMs / 1000)} seconds`));
      }, this.jobMs);
      timer.unref?.();
      this.jobs.set(id, { resolve, reject, timer });
      worker.ref(); // busy: the drawing is waited for
      try {
        worker.postMessage({ id, map: map || null, options });
      } catch (err) {
        // Something in the options cannot be handed to the worker.
        this.jobs.delete(id);
        clearTimeout(timer);
        worker.unref();
        reject(err);
      }
    });
  }

  _worker() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
    if (this.worker) return this.worker;
    const { Worker } = require("worker_threads");
    const worker = new Worker(path.join(__dirname, "paint-worker.js"));
    worker.on("message", (msg) => {
      const job = this.jobs.get(msg.id);
      if (!job) return;
      this.jobs.delete(msg.id);
      clearTimeout(job.timer);
      if (!this.jobs.size) worker.unref(); // idle again: never keeps Homebridge from stopping
      this.crashes = 0;
      this.worked = true;
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve({ png: Buffer.from(msg.png.buffer, msg.png.byteOffset, msg.png.byteLength), width: msg.width, height: msg.height, hasMap: msg.hasMap, rooms: msg.rooms, background: msg.background });
    });
    const failed = (err) => {
      if (this.worker !== worker) return;
      this.worker = null;
      // What was being drawn is given up, not drawn again here: whatever stopped the worker would stop Homebridge.
      const jobs = [...this.jobs.values()];
      this.jobs.clear();
      for (const job of jobs) {
        clearTimeout(job.timer);
        job.reject(err || new Error("the drawing thread stopped"));
      }
      if (err) worker.terminate().catch(() => {});
      // Worker threads that never get as far as one picture do not work here at all: draw in place.
      // A worker that drew before and now died did so over what it was given, and that is not drawn in Homebridge itself.
      if (err && ++this.crashes >= MAX_CRASHES && !this.worked) this._inline(err);
    };
    worker.on("error", failed);
    worker.on("exit", (code) => failed(code ? new Error(`the drawing thread stopped (${code})`) : null));
    worker.unref(); // idle until it gets a job (after the listeners: adding one would undo it)
    this.worker = worker;
    return worker;
  }

  /** Let go of a worker that is stuck. */
  _drop(worker) {
    if (this.worker === worker) this.worker = null; // its late answers and its end are ignored from here on
    worker.terminate().catch(() => {});
  }

  _inline(err) {
    if (this.inline) return;
    this.inline = true;
    if (this.log) this.log.info(`Map pictures are drawn without a worker thread from now on (${err && err.message}).`);
  }

  /** Let the worker go: when idle, or (`force`) in any case, giving up what is being drawn. */
  close(force = false) {
    clearTimeout(this.idle);
    const worker = this.worker;
    if (!worker || (this.jobs.size && !force)) return;
    this.worker = null;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(new Error("stopping"));
    }
    this.jobs.clear();
    worker.terminate().catch(() => {});
  }
}

module.exports = { Painter };
