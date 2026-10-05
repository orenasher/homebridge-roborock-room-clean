"use strict";

const fs = require("fs");
const path = require("path");
const { HomebridgePluginUiServer, RequestError } = require("@homebridge/plugin-ui-utils");
const { RoborockLogin, getHomeData, getRoutines } = require("../lib/cloud");

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
      throw new RequestError(err.message, { message: err.message });
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
      this.login = null;
      const robots = [...(home.devices || []), ...(home.receivedDevices || [])].map((d) => d.name);
      return { ok: true, robots, rooms: (home.rooms || []).map((r) => r.name) };
    } catch (err) {
      throw new RequestError(err.message, { message: err.message });
    }
  }

  logout() {
    try {
      fs.unlinkSync(this.authFile());
    } catch {
      /* already gone */
    }
    return { ok: true };
  }
}

(() => new UiServer())();
