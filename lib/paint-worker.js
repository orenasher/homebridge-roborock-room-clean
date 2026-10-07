"use strict";

/** Runs in a worker thread: draws the map camera's picture so Homebridge itself never pauses for it. */

const { parentPort } = require("worker_threads");
const { makePicture } = require("./picture");

parentPort.on("message", ({ id, map, options }) => {
  try {
    const out = makePicture(map ? Buffer.from(map) : null, options);
    parentPort.postMessage({ id, png: out.png, width: out.width, height: out.height, hasMap: out.hasMap, rooms: out.rooms, background: out.background });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
