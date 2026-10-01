"use strict";

/**
 * Roborock cloud account API: email-code login, home data (devices + room
 * names). Uses Node's built-in fetch (Node 18+), no external dependencies.
 */

const crypto = require("crypto");

const BASE_URLS = [
  "https://euiot.roborock.com",
  "https://usiot.roborock.com",
  "https://cniot.roborock.com",
  "https://ruiot.roborock.com",
];

const APP_HEADERS = {
  header_clientlang: "en",
  header_appversion: "4.54.02",
  header_phonesystem: "iOS",
  header_phonemodel: "iPhone16,1",
};

class RoborockCloudError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const FRIENDLY_ERRORS = {
  2003: "The email address is not valid.",
  2008: "No Roborock account exists for this email.",
  2018: "The verification code is wrong or expired.",
  3006: "You need to accept the Roborock user agreement again in the Roborock app.",
  3009: "You need to accept the Roborock user agreement in the Roborock app first.",
  3039: "No Roborock account exists for this email in this region.",
  9002: "Too many code requests. Wait a few minutes and try again.",
};

function md5hex(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function randomAlnum(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

async function request(method, url, { headers = {}, form, timeoutMs = 15000 } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new RoborockCloudError(`Network error contacting ${new URL(url).host}: ${err.cause?.message || err.message}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new RoborockCloudError(`Unexpected response from ${new URL(url).host} (HTTP ${res.status})`);
  }
}

function checkCode(resp, what) {
  if (resp && resp.code === 200) return resp;
  const code = resp && resp.code;
  const msg = FRIENDLY_ERRORS[code] || `${what} failed: ${(resp && resp.msg) || "unknown error"} (code ${code})`;
  throw new RoborockCloudError(msg, code);
}

/** Hawk authorization header for the account ("rriot.r.a") API. */
function hawkAuth(rriot, path) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(6).toString("base64url");
  const prestr = [rriot.u, rriot.s, nonce, String(ts), md5hex(path), "", ""].join(":");
  const mac = crypto.createHmac("sha256", rriot.h).update(prestr).digest("base64");
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

/**
 * Login helper. One instance per login attempt (the client id must stay the
 * same between "send code" and "log in with code").
 */
class RoborockLogin {
  constructor(email) {
    this.email = String(email || "").trim();
    if (!this.email) throw new RoborockCloudError("Enter your Roborock account email first.");
    this.deviceIdentifier = crypto.randomBytes(12).toString("base64url");
    this.clientId = crypto.createHash("md5").update(this.email).update(this.deviceIdentifier).digest("base64");
    this.info = null;
  }

  headers(extra = {}) {
    return { header_clientid: this.clientId, ...APP_HEADERS, ...extra };
  }

  /** Find which regional server holds this account. */
  async discover() {
    if (this.info) return this.info;
    let lastErr;
    for (const base of BASE_URLS) {
      try {
        const url = `${base}/api/v1/getUrlByEmail?${new URLSearchParams({ email: this.email, needtwostepauth: "false" })}`;
        const resp = await request("POST", url);
        if (resp.code !== 200) {
          if (resp.code === 2003 || resp.code === 1001) checkCode(resp, "Account lookup");
          lastErr = new RoborockCloudError(`Account lookup failed on ${base}: ${resp.msg}`, resp.code);
          continue;
        }
        const d = resp.data || {};
        if (d.country || d.countrycode) {
          this.info = { baseUrl: d.url || base, country: d.country, countryCode: d.countrycode };
          return this.info;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new RoborockCloudError("No Roborock account was found for this email on any region server.");
  }

  async sendCode() {
    const { baseUrl } = await this.discover();
    const resp = await request("POST", `${baseUrl}/api/v4/email/code/send`, {
      headers: this.headers(),
      form: { email: this.email, type: "login", platform: "" },
    });
    checkCode(resp, "Sending the verification code");
    return true;
  }

  async agreementVersion(baseUrl, country) {
    try {
      const resp = await request("GET", `${baseUrl}/api/v3/app/agreement/latest?${new URLSearchParams({ country })}`, {
        headers: { header_clientlang: "en" },
      });
      const d = resp && resp.code === 200 && resp.data;
      if (d && Number.isInteger(d.majorVersion) && Number.isInteger(d.minorVersion)) {
        return { majorVersion: d.majorVersion, minorVersion: d.minorVersion };
      }
    } catch {
      /* fall back below */
    }
    return { majorVersion: 14, minorVersion: 0 };
  }

  async loginWithCode(code) {
    const { baseUrl, country, countryCode } = await this.discover();
    const s = randomAlnum(16);
    const sign = await request("POST", `${baseUrl}/api/v3/key/sign?${new URLSearchParams({ s })}`, {
      headers: this.headers(),
    });
    checkCode(sign, "Login signature");
    const k = sign.data && sign.data.k;
    if (!k) throw new RoborockCloudError("Login signature failed: no key returned.");
    const agreement = await this.agreementVersion(baseUrl, country);
    const resp = await request("POST", `${baseUrl}/api/v4/auth/email/login/code`, {
      headers: this.headers({ "x-mercy-ks": s, "x-mercy-k": k }),
      form: {
        country,
        countryCode,
        email: this.email,
        code: String(code).trim(),
        majorVersion: String(agreement.majorVersion),
        minorVersion: String(agreement.minorVersion),
      },
    });
    checkCode(resp, "Login");
    const userData = resp.data;
    if (!userData || !userData.token || !userData.rriot) {
      throw new RoborockCloudError("Login succeeded but the response had no session data.");
    }
    return { email: this.email, baseUrl, clientId: this.clientId, userData };
  }
}

/** Fetch the home: devices (with local keys) and room names. */
async function getHomeData(auth) {
  const { baseUrl, userData, clientId } = auth;
  const detail = await request("GET", `${baseUrl}/api/v1/getHomeDetail`, {
    headers: { header_clientid: clientId || "", ...APP_HEADERS, Authorization: userData.token },
  });
  if (detail.code === 2010 || detail.code === 401) {
    throw new RoborockCloudError("The saved Roborock login is no longer valid. Log in again in the plugin settings.", "AUTH");
  }
  checkCode(detail, "Reading home details");
  const homeId = detail.data && detail.data.rrHomeId;
  if (!homeId) throw new RoborockCloudError("Your Roborock account has no home.");

  const rriot = userData.rriot;
  let lastErr;
  for (const path of [`/v3/user/homes/${homeId}`, `/v2/user/homes/${homeId}`, `/user/homes/${homeId}`]) {
    try {
      const resp = await request("GET", `${rriot.r.a.replace(/\/+$/, "")}${path}`, {
        headers: { Authorization: hawkAuth(rriot, path) },
      });
      if (resp && resp.success && resp.result) return resp.result;
      lastErr = new RoborockCloudError(`Reading home data failed: ${resp && (resp.msg || JSON.stringify(resp)).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Signed call to the account ("rriot.r.a") API; returns the "result" part of the answer. */
async function accountRequest(auth, method, path, what) {
  const rriot = auth && auth.userData && auth.userData.rriot;
  if (!rriot || !rriot.r || !rriot.r.a) {
    throw new RoborockCloudError("Not logged in to Roborock. Log in again in the plugin settings.", "AUTH");
  }
  const resp = await request(method, `${rriot.r.a.replace(/\/+$/, "")}${path}`, {
    headers: { Authorization: hawkAuth(rriot, path) },
  });
  if (!resp || resp.success !== true) {
    const detail = resp && (resp.msg || JSON.stringify(resp).slice(0, 200));
    throw new RoborockCloudError(`${what} failed: ${detail || "unknown error"}`, resp && resp.code);
  }
  return resp.result;
}

/** Roborock stores JSON inside JSON strings; accept either form. */
function nestedJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The routines ("work plans") of one robot, as shown in the Roborock app:
 * [{ id, name, enabled, scheduled }]. "scheduled" marks routines that also
 * start by themselves on a timer.
 *
 * Throws when the list cannot be read, so that a failed read is never
 * mistaken for "this robot has no routines".
 */
async function getRoutines(auth, duid) {
  const result = await accountRequest(auth, "GET", `/user/scene/device/${duid}`, "Reading the routines");
  if (!Array.isArray(result)) throw new RoborockCloudError("Reading the routines failed: unexpected answer.");
  const routines = [];
  for (const scene of result) {
    if (!scene || typeof scene !== "object" || scene.id == null) continue;
    const param = nestedJson(scene.param);
    const triggers = param && Array.isArray(param.triggers) ? param.triggers : [];
    routines.push({
      id: scene.id,
      name: String(scene.name == null ? "" : scene.name).trim() || `Routine ${scene.id}`,
      enabled: scene.enabled !== false,
      scheduled: triggers.length > 0,
    });
  }
  return routines;
}

/** Start a routine, exactly like pressing it in the Roborock app. */
async function runRoutine(auth, routineId) {
  await accountRequest(auth, "POST", `/user/scene/${routineId}/execute`, "Starting the routine");
}

module.exports = { RoborockLogin, RoborockCloudError, getHomeData, getRoutines, runRoutine, hawkAuth };
