import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  db,
  sql,
  hashPassword,
  verifyPassword,
  userCan,
  visibleProfiles,
} from "./db.js";

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

// ---- Bootstrap: admin user + migrate config.json ----------------------------

function bootstrap() {
  const userCount = sql.listUsers.all().length;
  if (userCount === 0) {
    const passHash = hashPassword(ADMIN_PASS);
    sql.createUser.run(ADMIN_USER, passHash, "admin", 1, -1);
    sql.setRoot.run(ADMIN_USER);
    console.log(`[db] created admin user '${ADMIN_USER}'`);
  }

  if (sql.countRoots.get().c === 0) {
    const first = sql.firstRootCandidate.get();
    if (first) {
      sql.setRoot.run(first.username);
      console.log(`[db] marked '${first.username}' as root admin`);
    }
  }

  const profileCount = sql.listProfiles.all().length;
  if (profileCount === 0 && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const list = config?.auth || [];
      for (const p of list) {
        if (p?.user && p?.key) {
          sql.createProfile.run(p.user, p.key, ADMIN_USER);
        }
      }
      console.log(`[db] migrated ${list.length} profile(s) from config.json`);
    } catch (e) {
      console.error(`[web] failed to migrate config.json: ${e.message}`);
    }
  }
}
bootstrap();

// ---- Profiles (authConfig mirror of DB) -------------------------------------

function reloadAuthConfig() {
  return new Map(sql.listProfiles.all().map((p) => [p.user, p.key]));
}

let authConfig = reloadAuthConfig();

function getProfile(user) {
  return sql.getProfile.get(user);
}

function getProfiles() {
  return sql.listProfiles.all();
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

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
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

function getSessionUser(req) {
  const session = getSession(req);
  if (!session) return null;
  return sql.getUserByUsername.get(session.username);
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

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { status: "error", message: "Недостаточно прав" });
    return null;
  }
  return user;
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
  const row = sql.getUserByUsername.get(user);
  if (row && verifyPassword(pass, row.pass_hash)) {
    const token = createSession(row.username);
    res.statusCode = 200;
    res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ status: "ok", role: row.role }));
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
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { status: "error" });
  const created = sql.countUserProfiles.get(user.username).c;
  sendJson(res, 200, {
    status: "ok",
    user: user.username,
    role: user.role,
    canViewStats: !!user.can_view_stats,
    maxProfiles: user.max_profiles,
    createdProfiles: created,
  });
};

const handleListProfiles = (req, res) => {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
  const host = resolveHost(req);
  const rows = visibleProfiles(user);
  const profiles = rows.map((p) => {
    const rights = userCan(user, p);
    const out = {
      user: p.user,
      createdBy: p.created_by,
      canViewKey: rights.viewKey,
      canManage: rights.manage,
    };
    if (rights.viewKey) {
      out.key = p.key;
      out.urls = buildUrls(p.user, p.key, host);
    } else {
      out.key = null;
      out.urls = null;
    }
    return out;
  });
  const created = sql.countUserProfiles.get(user.username).c;
  sendJson(res, 200, {
    status: "ok",
    profiles,
    host,
    me: {
      user: user.username,
      role: user.role,
      canViewStats: !!user.can_view_stats,
      maxProfiles: user.max_profiles,
      createdProfiles: created,
    },
  });
};

const handleCreateProfile = async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const name = body.user;
  if (!validateUser(name)) {
    return sendJson(res, 400, { status: "error", message: "Недопустимое имя пользователя" });
  }
  if (sql.getProfile.get(name)) {
    return sendJson(res, 409, { status: "error", message: "Профиль уже существует" });
  }
  if (user.role !== "admin") {
    const max = Number(user.max_profiles);
    const count = sql.countUserProfiles.get(user.username).c;
    if (max >= 0 && count >= max) {
      return sendJson(res, 403, {
        status: "error",
        message: `Достигнут лимит профилей (${max}). Обратитесь к администратору`,
      });
    }
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
  try {
    sql.createProfile.run(name, key, user.username);
  } catch (e) {
    return sendJson(res, 409, { status: "error", message: "Профиль уже существует" });
  }
  authConfig.set(name, key);
  sendJson(res, 201, { status: "ok", profile: { user: name, key } });
};

const handleUpdateKey = async (req, res, params) => {
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
  const name = params.user;
  const profile = sql.getProfile.get(name);
  if (!profile) {
    return sendJson(res, 404, { status: "error", message: "Профиль не найден" });
  }
  const rights = userCan(me, profile);
  if (!rights.manage) {
    return sendJson(res, 403, { status: "error", message: "Недостаточно прав для управления профилем" });
  }
  const oldKey = profile.key;
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
  sql.updateProfileKey.run(key, name);
  authConfig.set(name, key);
  sendJson(res, 200, { status: "ok", profile: { user: name, key } });
  if (oldKey !== key) {
    disconnectStream(profileStreamid(name, oldKey));
  }
};

const handleDeleteProfile = async (req, res, params) => {
  const me = getSessionUser(req);
  if (!me) return sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
  const name = params.user;
  const profile = sql.getProfile.get(name);
  if (!profile) {
    return sendJson(res, 404, { status: "error", message: "Профиль не найден" });
  }
  const rights = userCan(me, profile);
  if (!rights.manage) {
    return sendJson(res, 403, { status: "error", message: "Недостаточно прав для управления профилем" });
  }
  if (await isProfileLive(name)) {
    return sendJson(res, 409, {
      status: "error",
      message: "Профиль находится в эфире — удаление невозможно",
    });
  }
  const key = profile.key;
  sql.deleteProfile.run(name);
  sql.deletePermsOnProfile.run(name);
  authConfig.delete(name);
  sendJson(res, 200, { status: "ok" });
  disconnectStream(profileStreamid(name, key));
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
  const profile = sql.getProfile.get(user);
  if (!profile) return false;
  const publishers = await fetchAllPublishers();
  return Object.prototype.hasOwnProperty.call(publishers, profileStreamid(user, profile.key));
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

const handleStatsProxy = async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { status: "error", message: "Требуется авторизация" });
  if (!user.can_view_stats) {
    return sendJson(res, 403, { status: "error", message: "Нет права на просмотр статистики" });
  }
  try {
    const publishers = await fetchAllPublishers();
    if (user.role !== "admin") {
      const visible = new Set(visibleProfiles(user).map((p) => p.user));
      for (const [streamid] of Object.entries(publishers)) {
        const m = String(streamid).match(/^live\/stream\/([^?/]+)/);
        if (!m || !visible.has(m[1])) delete publishers[streamid];
      }
    }
    sendJson(res, 200, { status: "ok", publishers });
  } catch {
    sendJson(res, 502, { status: "error", message: "Статистика недоступна" });
  }
};

// ---- Users admin API --------------------------------------------------------

const handleListUsers = (req, res) => {
  const rows = sql.listUsers.all().map((u) => ({
    username: u.username,
    role: u.role,
    canViewStats: !!u.can_view_stats,
    maxProfiles: u.max_profiles,
    isRoot: !!u.is_root,
    createdAt: u.created_at,
    profileCount: sql.countUserProfiles.get(u.username).c,
  }));
  sendJson(res, 200, { status: "ok", users: rows });
};

const handleCreateUser = async (req, res) => {
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const { username, pass } = body;
  if (!validateUser(username)) {
    return sendJson(res, 400, { status: "error", message: "Недопустимое имя пользователя" });
  }
  if (typeof pass !== "string" || pass.length < 6) {
    return sendJson(res, 400, { status: "error", message: "Пароль должен быть не короче 6 символов" });
  }
  if (sql.getUserByUsername.get(username)) {
    return sendJson(res, 409, { status: "error", message: "Пользователь уже существует" });
  }
  const role = body.role === "admin" ? "admin" : "user";
  const canViewStats = body.canViewStats === false ? 0 : 1;
  const maxProfiles = Number.isInteger(body.maxProfiles) ? body.maxProfiles : role === "admin" ? -1 : 3;
  try {
    sql.createUser.run(username, hashPassword(pass), role, canViewStats, maxProfiles);
  } catch (e) {
    return sendJson(res, 409, { status: "error", message: "Пользователь уже существует" });
  }
  sendJson(res, 201, { status: "ok" });
};

const handleUpdateUser = async (req, res, params) => {
  const me = getSessionUser(req);
  const username = params.user;
  const row = sql.getUserByUsername.get(username);
  if (!row) return sendJson(res, 404, { status: "error", message: "Пользователь не найден" });
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const passHash = body.pass !== undefined && body.pass !== "" ? hashPassword(body.pass) : undefined;
  if (body.pass !== undefined && body.pass !== "" && (typeof body.pass !== "string" || body.pass.length < 6)) {
    return sendJson(res, 400, { status: "error", message: "Пароль должен быть не короче 6 символов" });
  }
  const isRoot = !!row.is_root;
  if (isRoot && body.pass !== undefined && me?.username !== username) {
    return sendJson(res, 403, { status: "error", message: "Пароль первого администратора можно сменить только с его учётной записи" });
  }
  if (isRoot && body.role === "user") {
    return sendJson(res, 400, { status: "error", message: "Нельзя снять роль первого администратора" });
  }
  if (body.role === "user" && row.role === "admin" && me?.username === username) {
    return sendJson(res, 400, { status: "error", message: "Нельзя снять себе роль администратора" });
  }
  if (body.role === "user" && row.role === "admin") {
    const admins = sql.countAdmins.get().c;
    if (admins <= 1) {
      return sendJson(res, 400, { status: "error", message: "Нельзя снять роль последнего администратора" });
    }
  }
  const role = body.role !== undefined ? (body.role === "admin" ? "admin" : "user") : undefined;
  const canViewStats = body.canViewStats !== undefined ? (body.canViewStats === false ? 0 : 1) : undefined;
  let maxProfiles = body.maxProfiles !== undefined ? body.maxProfiles : undefined;
  if (maxProfiles !== undefined && !Number.isInteger(maxProfiles)) {
    return sendJson(res, 400, { status: "error", message: "maxProfiles должен быть целым числом" });
  }
  sql.updateUser.run(passHash ?? null, role ?? null, canViewStats ?? null, maxProfiles ?? null, username);
  sendJson(res, 200, { status: "ok" });
};

const handleDeleteUser = (req, res, params) => {
  const me = getSessionUser(req);
  const username = params.user;
  const row = sql.getUserByUsername.get(username);
  if (!row) return sendJson(res, 404, { status: "error", message: "Пользователь не найден" });
  if (!!row.is_root) {
    return sendJson(res, 400, { status: "error", message: "Нельзя удалить первого администратора" });
  }
  if (me?.username === username) {
    return sendJson(res, 400, { status: "error", message: "Нельзя удалить самого себя" });
  }
  if (row.role === "admin") {
    const admins = sql.countAdmins.get().c;
    if (admins <= 1) {
      return sendJson(res, 400, { status: "error", message: "Нельзя удалить последнего администратора" });
    }
  }
  sql.deleteUser.run(username);
  sql.listPermsFor.all(username).forEach((p) => sql.deletePerm.run(username, p.profile_user));
  sendJson(res, 200, { status: "ok" });
};

// ---- Permissions API (admin) -------------------------------------------------

const handleListPerms = (req, res, params) => {
  const username = params.user;
  if (!sql.getUserByUsername.get(username)) {
    return sendJson(res, 404, { status: "error", message: "Пользователь не найден" });
  }
  const perms = sql.listPermsFor.all(username).map((p) => ({
    profileUser: p.profile_user,
    canViewKey: !!p.can_view_key,
    canManage: !!p.can_manage,
  }));
  sendJson(res, 200, { status: "ok", perms });
};

const handleSetPerm = async (req, res, params) => {
  const { user: username, profile } = params;
  if (!sql.getUserByUsername.get(username)) {
    return sendJson(res, 404, { status: "error", message: "Пользователь не найден" });
  }
  if (!sql.getProfile.get(profile)) {
    return sendJson(res, 404, { status: "error", message: "Профиль не найден" });
  }
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { status: "error", message: "Invalid JSON" });
  }
  const canViewKey = body.canViewKey === true ? 1 : 0;
  const canManage = body.canManage === true ? 1 : 0;
  sql.upsertPerm.run(username, profile, canViewKey, canManage);
  sendJson(res, 200, { status: "ok" });
};

const handleDeletePerm = (req, res, params) => {
  const { user: username, profile } = params;
  sql.deletePerm.run(username, profile);
  sendJson(res, 200, { status: "ok" });
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

const apiHandlers = {
  "POST /api/login": handleLogin,
  "POST /api/logout": handleLogout,
  "GET /api/session": handleSession,
  "GET /api/profiles": (req, res) => handleListProfiles(req, res),
  "POST /api/profiles": (req, res) => handleCreateProfile(req, res),
  "POST /api/keygen": (req, res) => {
    if (!requireAuth(req, res)) return;
    handleKeygen(req, res);
  },
  "GET /api/stats": (req, res) => handleStatsProxy(req, res),
  "GET /api/users": (req, res) => {
    if (!requireAdmin(req, res)) return;
    handleListUsers(req, res);
  },
  "POST /api/users": (req, res) => {
    if (!requireAdmin(req, res)) return;
    handleCreateUser(req, res);
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

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    if (!requireAdmin(req, res)) return;
    if (req.method === "PUT") return handleUpdateUser(req, res, { user: userMatch[1] });
    if (req.method === "DELETE") return handleDeleteUser(req, res, { user: userMatch[1] });
  }

  const permsMatch = url.pathname.match(/^\/api\/perms\/([^/]+)\/([^/]+)$/);
  if (permsMatch) {
    if (!requireAdmin(req, res)) return;
    if (req.method === "PUT") return handleSetPerm(req, res, { user: permsMatch[1], profile: permsMatch[2] });
    if (req.method === "DELETE") return handleDeletePerm(req, res, { user: permsMatch[1], profile: permsMatch[2] });
  }

  const permListMatch = url.pathname.match(/^\/api\/perms\/([^/]+)$/);
  if (permListMatch) {
    if (!requireAdmin(req, res)) return;
    if (req.method === "GET") return handleListPerms(req, res, { user: permListMatch[1] });
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
