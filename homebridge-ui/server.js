"use strict";

const fs = require("fs");
const path = require("path");
const { HomebridgePluginUiServer, RequestError } = require("@homebridge/plugin-ui-utils");
const { RoborockLogin, getHomeData } = require("../lib/cloud");

const STORAGE_DIR = "roborock-room-clean";

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.dir = path.join(this.homebridgeStoragePath, STORAGE_DIR);
    this.login = null;

    this.onRequest("/status", () => this.status());
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
