import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config.json");
const webDir = path.join(__dirname, "..", "web");
const envPath = path.join(__dirname, "..", ".env");

const KEY_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@?$^_=";
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const STATS_URL = "http://localhost:8181/stats";
const DISCONNECT_URL = "http://localhost:8181/disconnect";
const SLS_API_KEY = process.env.SLS_API_KEY || "belabox_sls_api_key_2026";
const WEB_PORT = Number(process.env.PORT) || 3000;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(envPath);

const ADMIN_USER = process.env.WEB_USER || "admin";
const ADMIN_PASS = process.env.WEB_PASS || "admin";
const PUBLIC_HOST = (process.env.PUBLIC_HOST || "").trim();

if (!ADMIN_PASS || ADMIN_PASS === "change_me") {
  console.warn("[web] WARNING: WEB_PASS not set or default - set it in .env!");
}

// ---- Profiles (config.json) -------------------------------------------------

let authConfig = new Map();

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    authConfig = new Map((config?.auth || []).map((o) => [o.user, o.key]));
    console.log(`[web] loaded ${authConfig.size} profile(s) from config.json`);
  } catch (e) {
    console.error(`[web] failed to read ${configPath}: ${e.message}`);
    authConfig = new Map();
  }
}
loadConfig();

function saveConfig(authList) {
  const data = JSON.stringify({ auth: authList }, null, 2);
  try {
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, configPath);
  } catch (e) {
    console.warn(`[web] atomic rename failed (${e.code}), writing directly`);
    fs.writeFileSync(configPath, data);
  }
  authConfig = new Map(authList.map((o) => [o.user, o.key]));
}

function safeSave(res, authList) {
  try {
    saveConfig(authList);
    return true;
  } catch (e) {
    console.error(`[web] failed to save config: ${e.message}`);
    sendJson(res, 500, { status: "error", message: "Не удалось сохранить конфигурацию" });
    return false;
  }
}

function getProfiles() {
  return [...authConfig.entries()].map(([user, key]) => ({ user, key }));
}

function generateKey() {
  const length = 16 + crypto.randomInt(0, 3);
  let key = "";
  for (let i = 0; i < length; i++) {
    key += KEY_CHARSET[crypto.randomInt(0, KEY_CHARSET.length)];
  }
  return key;
}

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  for (const ch of key) if (!KEY_CHARSET.includes(ch)) return false;
  return true;
}

function validateUser(user) {
  return typeof user === "string" && USER_RE.test(user);
}

// ---- Sessions ---------------------------------------------------------------

const sessions = new Map();

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    result[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return result;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function deleteSession(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) sessions.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ---- Helpers ----------------------------------------------------------------

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function buildUrls(user, key, host) {
  return {
    host,
    publishSrtla: `srt://${host}:5000?streamid=live/stream/${user}?srtauth=${key}`,
    publishDirect: `srt://${host}:4001?streamid=live/stream/${user}?srtauth=${key}`,
    play: `srt://${host}:4000?streamid=play/stream/${user}?srtauth=${key}`,
    legacy: `srt://${host}:8282?streamid=live/stream/${user}?srtauth=${key}`,
    stats: `http://${host}:8181/stats?publisher=${encodeURIComponent(`live/stream/${user}?srtauth=${key}`)}`,
  };
}

function resolveHost(req) {
  if (PUBLIC_HOST) return PUBLIC_HOST;
  return req.headers.host?.replace(/:\d+$/, "") || "localhost";
}

// ---- SLS event webhook (unchanged behaviour) --------------------------------

const handleSlsEvent = (res, query) => {
  console.log("event", query);
  const { role_name, srt_url } = query;
  const srtUrl = srt_url.split("/");
  const [, , streamName] = srtUrl;
  if (!streamName) {
    res.statusCode = 400;
    res.end("Invalid stream name");
    return;
  }
  const qIdx = streamName.indexOf("?");
  const streamer = qIdx === -1 ? streamName : streamName.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? "" : streamName.slice(qIdx + 1));
  const streamKey = params.get("srtauth");

  if (query.on_event === "on_connect") {
    if (streamKey) {
      const auth = authConfig.get(streamer);
      if (auth === streamKey) {
        console.log(`${role_name} connected to ${streamer}`);
        res.statusCode = 200;
        res.end();
        return;
      }
      console.log(`${role_name} connected to ${streamer} with wrong key`);
      res.statusCode = 401;
      res.end();
      return;
    }
  } else if (query.on_event === "on_close") {
    console.log(`${role_name} disconnected from ${streamer}`);
    res.statusCode = 200;
    res.end();
    return;
  }
  console.log(`${role_name} connected to ${streamer} with wrong event`);
  res.statusCode = 401;
  res.end();
};

const handleStats = async (res, query) => {
  const { streamer, key } = query;
  const auth = authConfig.get(streamer);
  const authed = auth === key && streamer && key;
  let result = {};
  if (authed) {
    try {
      const publisherName = `live/stream/${streamer}?srtauth=${auth}`;
      const pub = encodeURIComponent(publisherName);
      const data = await fetch(`${STATS_URL}?publisher=${pub}`);
      const json = await data.json();
      if (json?.publishers) result = json?.publishers;
    } catch (e) {
      console.log(e);
    }
    sendJson(res, 200, { publishers: result ?? {}, status: "ok" });
    return;
  }
  sendJson(res, 200, { status: "error" });
};

// ---- Web API ----------------------------------------------------------------

const handleLogin = async (req, res) => {
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const { user, pass } = body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = createSession(user);
    res.statusCode = 200;
    res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  sendJson(res, 401, { status: "error", message: "Неверный логин или пароль" });
};

const handleLogout = (req, res) => {
  deleteSession(req);
  res.statusCode = 200;
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.end(JSON.stringify({ status: "ok" }));
};

const handleSession = (req, res) => {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { status: "error" });
  sendJson(res, 200, { status: "ok", user: session.user });
};

const handleListProfiles = (req, res) => {
  const host = resolveHost(req);
  const profiles = getProfiles().map((p) => ({ ...p, urls: buildUrls(p.user, p.key, host) }));
  sendJson(res, 200, { status: "ok", profiles, host });
};

const handleCreateProfile = async (req, res) => {
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const user = body.user;
  if (!validateUser(user)) {
    return sendJson(res, 400, { status: "error", message: "Недопустимое имя пользователя" });
  }
  if (authConfig.has(user)) {
    return sendJson(res, 409, { status: "error", message: "Профиль уже существует" });
  }
  let key = body.key ?? "";
  if (key !== "") {
    if (!validateKey(key)) {
      return sendJson(res, 400, {
        status: "error",
        message: "Ключ содержит недопустимые символы (разрешено A-Z a-z 0-9 !@?$^_=)",
      });
    }
  } else {
    key = generateKey();
  }
  if (!safeSave(res, [{ user, key }, ...getProfiles()])) return;
  sendJson(res, 201, { status: "ok", profile: { user, key } });
};

const handleUpdateKey = async (req, res, params) => {
  const user = params.user;
  if (!authConfig.has(user)) {
    return sendJson(res, 404, { status: "error", message: "Профиль не найден" });
  }
  const oldKey = authConfig.get(user);
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  let key = body.key ?? "";
  if (key !== "") {
    if (!validateKey(key)) {
      return sendJson(res, 400, {
        status: "error",
        message: "Ключ содержит недопустимые символы (разрешено A-Z a-z 0-9 !@?$^_=)",
      });
    }
  } else {
    key = generateKey();
  }
  if (!safeSave(res, getProfiles().map((p) => (p.user === user ? { user, key } : p)))) return;
  sendJson(res, 200, { status: "ok", profile: { user, key } });
  if (oldKey !== key) {
    disconnectStream(profileStreamid(user, oldKey));
  }
};

const handleDeleteProfile = async (req, res, params) => {
  const user = params.user;
  if (!authConfig.has(user)) {
    return sendJson(res, 404, { status: "error", message: "Профиль не найден" });
  }
  if (await isProfileLive(user)) {
    return sendJson(res, 409, {
      status: "error",
      message: "Профиль находится в эфире — удаление невозможно",
    });
  }
  const key = authConfig.get(user);
  if (!safeSave(res, getProfiles().filter((p) => p.user !== user))) return;
  sendJson(res, 200, { status: "ok" });
  disconnectStream(profileStreamid(user, key));
};

const handleKeygen = (req, res) => {
  sendJson(res, 200, { status: "ok", key: generateKey() });
};

function profileStreamid(user, key) {
  return `live/stream/${user}?srtauth=${key}`;
}

async function fetchAllPublishers() {
  try {
    const data = await fetch(STATS_URL, {
      headers: { Authorization: SLS_API_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (data.ok) {
      const json = await data.json();
      if (json?.publishers && typeof json.publishers === "object") {
        return json.publishers;
      }
    }
  } catch (e) {
    console.log(`[stats] auth /stats failed: ${e.message}`);
  }

  const profiles = getProfiles();
  const merged = {};
  let sawOk = false;
  await Promise.all(
    profiles.map(async (p) => {
      try {
        const pub = encodeURIComponent(profileStreamid(p.user, p.key));
        const resp = await fetch(`${STATS_URL}?publisher=${pub}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          sawOk = true;
          const json = await resp.json();
          if (json?.publishers && typeof json.publishers === "object") {
            Object.assign(merged, json.publishers);
          }
        }
      } catch (e) {
        console.log(`[stats] per-profile ${p.user}: ${e.message}`);
      }
    }),
  );
  if (!sawOk && profiles.length > 0) {
    throw new Error("SLS stats unavailable");
  }
  return merged;
}

async function isProfileLive(user) {
  const key = authConfig.get(user);
  if (!key) return false;
  const publishers = await fetchAllPublishers();
  return Object.prototype.hasOwnProperty.call(publishers, profileStreamid(user, key));
}

async function disconnectStream(streamid) {
  try {
    const data = await fetch(`${DISCONNECT_URL}?stream=${encodeURIComponent(streamid)}`, {
      method: "POST",
      headers: { Authorization: SLS_API_KEY },
      signal: AbortSignal.timeout(3000),
    });
    console.log(`[sls] disconnect ${streamid} -> ${data.status} ${await data.text().catch(() => "")}`);
  } catch (e) {
    console.error(`[sls] disconnect ${streamid} failed: ${e.message}`);
  }
}

const handleStatsProxy = async (res) => {
  try {
    const publishers = await fetchAllPublishers();
    sendJson(res, 200, { status: "ok", publishers });
  } catch {
    sendJson(res, 502, { status: "error", message: "Статистика недоступна" });
  }
};

// ---- Static files -----------------------------------------------------------

const WEB_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function handleStatic(req, res) {
  const file = WEB_FILES[req.url];
  if (!file) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const filePath = path.join(webDir, file);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[path.extname(filePath)] || "application/octet-stream");
    res.end(content);
  });
}

// ---- Router -----------------------------------------------------------------

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
    return null;
  }
  return session;
}

const apiHandlers = {
  "POST /api/login": handleLogin,
  "POST /api/logout": handleLogout,
  "GET /api/session": handleSession,
  "GET /api/profiles": (req, res) => {
    if (!requireAuth(req, res)) return;
    handleListProfiles(req, res);
  },
  "POST /api/profiles": (req, res) => {
    if (!requireAuth(req, res)) return;
    handleCreateProfile(req, res);
  },
  "POST /api/keygen": (req, res) => {
    if (!requireAuth(req, res)) return;
    handleKeygen(req, res);
  },
  "GET /api/stats": (req, res) => {
    if (!requireAuth(req, res)) return;
    handleStatsProxy(res);
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const query = Object.fromEntries(url.searchParams.entries());

  const apiKey = `${req.method} ${url.pathname}`;
  if (apiHandlers[apiKey]) return apiHandlers[apiKey](req, res);

  const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch) {
    if (!requireAuth(req, res)) return;
    if (req.method === "PUT") return handleUpdateKey(req, res, { user: profileMatch[1] });
    if (req.method === "DELETE") return handleDeleteProfile(req, res, { user: profileMatch[1] });
  }

  const legacyHandlers = {
    "GET /stats": () => handleStats(res, query),
    "POST /sls/event": () => handleSlsEvent(res, query),
  };
  const legacyKey = `${req.method} ${url.pathname}`;
  if (legacyHandlers[legacyKey]) return legacyHandlers[legacyKey]();

  if (req.method === "GET" && url.pathname.startsWith("/")) return handleStatic(req, res);

  res.statusCode = 404;
  res.end("Not Found");
});

server.listen(WEB_PORT, () => console.log(`Server started on port ${WEB_PORT}`));