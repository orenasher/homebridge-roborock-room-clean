"use strict";

const fs = require("fs");
const path = require("path");
const { HomebridgePluginUiServer, RequestError } = require("@homebridge/plugin-ui-utils");
const zlib = require("zlib");
const { RoborockLogin, getHomeData, getRoutines } = require("../lib/cloud");
const { makePicture } = require("../lib/picture");
const { THEMES, DEFAULT_THEME, COLOR_KEYS } = require("../lib/themes");
const { demoMap, demoRooms } = require("../lib/demo-map");

const STORAGE_DIR = "roborock-room-clean";

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.dir = path.join(this.homebridgeStoragePath, STORAGE_DIR);
    this.login = null;

    this.onRequest("/status", () => this.status());
    this.onRequest("/routines", () => this.routines());
    this.onRequest("/send-code", (p) => this.sendCode(p));
    this.onRequest("/login", (p) => this.doLogin(p));
    this.onRequest("/logout", () => this.logout());
    this.onRequest("/map/themes", () => this.mapThemes());
    this.onRequest("/map/preview", (p) => this.mapPreview(p || {}));

    this.ready();
  }

  authFile() {
    return path.join(this.dir, "auth.json");
  }

  status() {
    try {
      const auth = JSON.parse(fs.readFileSync(this.authFile(), "utf8"));
      let rooms = [];
      for (const f of fs.readdirSync(this.dir)) {
        if (f.startsWith("rooms-") && f.endsWith(".json")) {
          rooms = rooms.concat(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")).map((r) => r.name));
        }
      }
      return { loggedIn: true, email: auth.email, rooms };
    } catch {
      return { loggedIn: false };
    }
  }

  readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * The routines of every robot, read live from Roborock so that a routine
   * made a minute ago in the app shows up without a Homebridge restart. Falls
   * back to the list the plugin saved at its last start.
   */
  async routines() {
    const auth = this.readJson("auth.json");
    if (!auth || !auth.userData) return { routines: [], robots: 0 };
    let home = this.readJson("home-cache.json");
    if (!home) {
      try {
        home = await getHomeData(auth);
      } catch (err) {
        return { routines: [], robots: 0, error: err.message };
      }
    }
    const products = new Map((home.products || []).map((p) => [p.id, p]));
    const robots = [...(home.devices || []), ...(home.receivedDevices || [])].filter((d) => {
      const product = products.get(d.productId);
      const isVacuum = !product || !product.category || /vacuum|robot/i.test(product.category);
      return d && d.duid && isVacuum && (!d.pv || d.pv === "1.0");
    });
    const routines = [];
    let error;
    await Promise.all(
      robots.map(async (robot) => {
        let list;
        try {
          list = await getRoutines(auth, robot.duid);
        } catch (err) {
          error = err.message;
          list = this.readJson(`routines-${robot.duid}.json`);
        }
        for (const r of Array.isArray(list) ? list : []) {
          routines.push({ id: String(r.id), name: r.name, scheduled: !!r.scheduled, robot: robot.name, duid: robot.duid });
        }
      })
    );
    // Promise.all finishes in any order; keep the robots in their own order.
    const order = new Map(robots.map((r, i) => [r.duid, i]));
    routines.sort((a, b) => order.get(a.duid) - order.get(b.duid));
    return { routines, robots: robots.length, error };
  }

  async sendCode({ email }) {
    try {
      this.login = new RoborockLogin(email);
      await this.login.sendCode();
      return { ok: true };
    } catch (err) {
      // The code lets the settings page show the reason in the chosen language.
      throw new RequestError(err.message, { message: err.message, code: err.code });
    }
  }

  async doLogin({ email, code }) {
    try {
      if (!this.login || this.login.email !== String(email || "").trim()) {
        this.login = new RoborockLogin(email);
      }
      const auth = await this.login.loginWithCode(code);
      // Check that the session works before saving it.
      const home = await getHomeData(auth);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.authFile(), JSON.stringify({ ...auth, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.writeFileSync(path.join(this.dir, "home-cache.json"), JSON.stringify(home, null, 2));
      this.forget("listen.json"); // what Roborock's cloud refused the previous login says nothing about this one
      this.login = null;
      const robots = [...(home.devices || []), ...(home.receivedDevices || [])].map((d) => d.name);
      return { ok: true, robots, rooms: (home.rooms || []).map((r) => r.name) };
    } catch (err) {
      // The code lets the settings page show the reason in the chosen language.
      throw new RequestError(err.message, { message: err.message, code: err.code });
    }
  }

  // ---------- map camera ----------

  /** The colour styles the map camera offers, with the colours a user may replace. */
  mapThemes() {
    return {
      defaultTheme: DEFAULT_THEME,
      colorKeys: COLOR_KEYS,
      themes: Object.entries(THEMES).map(([id, theme]) => ({
        id,
        title: theme.title,
        swatch: [theme.background[0], ...theme.rooms.slice(0, 4), theme.walls],
        colors: Object.fromEntries(COLOR_KEYS.map((key) => [key, key === "background" ? theme.background[0] : theme[key]])),
      })),
    };
  }

  /**
   * The map camera's picture with the settings being tried out, drawn from
   * the robot's own map when the plugin has kept one, otherwise from a
   * made-up home. Returns { image (data URL), demo, rooms: [{ name, color, own }] }.
   */
  mapPreview(p) {
    const language = p.language === "he" ? "he" : "en";
    let map = null;
    let rooms = null;
    let status = null;
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => /^map-.+\.bin$/.test(f))
        .map((f) => ({ f, at: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      if (files.length) {
        const duid = files[0].f.slice(4, -4);
        map = zlib.gunzipSync(fs.readFileSync(path.join(this.dir, files[0].f)));
        rooms = this.readJson(`rooms-${duid}.json`);
        status = this.readJson(`status-${duid}.json`);
      }
    } catch {
      map = null;
    }
    const options = {
      theme: p.theme,
      colors: p.colors,
      roomColors: p.roomColors,
      rotation: p.rotation,
      labels: p.labels !== false,
      statusBar: p.statusBar !== false,
      language,
      size: 960,
      highlight: false,
    };
    let out = map ? makePicture(map, { ...options, rooms: rooms || [], status: status || { state: 8, battery: 100 } }) : null;
    const demo = !out || !out.hasMap;
    if (demo) out = makePicture(demoMap({ cleaning: [16] }), { ...options, rooms: demoRooms(language), status: { state: 18, battery: 76, clean_area: 9e6, clean_time: 540 } });
    return { image: `data:image/png;base64,${out.png.toString("base64")}`, demo, rooms: demo ? [] : out.rooms };
  }

  forget(file) {
    try {
      fs.unlinkSync(path.join(this.dir, file));
    } catch {
      /* already gone */
    }
  }

  logout() {
    this.forget("auth.json");
    this.forget("listen.json");
    return { ok: true };
  }
}

(() => new UiServer())();
