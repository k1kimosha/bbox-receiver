import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "users.db");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  can_view_stats INTEGER NOT NULL DEFAULT 1,
  max_profiles INTEGER NOT NULL DEFAULT 3,
  is_root INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  user TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_perms (
  username TEXT NOT NULL,
  profile_user TEXT NOT NULL,
  can_view_key INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, profile_user)
);
`);

// Migration: is_root column for pre-existing databases
const userCols = db.prepare("PRAGMA table_info(users)").all();
if (!userCols.some((c) => c.name === "is_root")) {
  db.exec("ALTER TABLE users ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0");
}

export const sql = {
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  createUser: db.prepare(
    "INSERT INTO users (username, pass_hash, role, can_view_stats, max_profiles) VALUES (?, ?, ?, ?, ?)",
  ),
  updateUser: db.prepare(
    "UPDATE users SET pass_hash = COALESCE(?, pass_hash), role = COALESCE(?, role), can_view_stats = COALESCE(?, can_view_stats), max_profiles = COALESCE(?, max_profiles) WHERE username = ?",
  ),
  deleteUser: db.prepare("DELETE FROM users WHERE username = ?"),
  listUsers: db.prepare("SELECT * FROM users ORDER BY id"),
  countAdmins: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"),
  countRoots: db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_root = 1"),
  setRoot: db.prepare("UPDATE users SET is_root = 1 WHERE username = ?"),
  firstRootCandidate: db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"),  countUserProfiles: db.prepare("SELECT COUNT(*) AS c FROM profiles WHERE created_by = ?"),
  getProfile: db.prepare("SELECT * FROM profiles WHERE user = ?"),
  createProfile: db.prepare("INSERT INTO profiles (user, key, created_by) VALUES (?, ?, ?)"),
  updateProfileKey: db.prepare("UPDATE profiles SET key = ? WHERE user = ?"),
  deleteProfile: db.prepare("DELETE FROM profiles WHERE user = ?"),
  listProfiles: db.prepare("SELECT * FROM profiles ORDER BY user"),
  getPerm: db.prepare("SELECT * FROM profile_perms WHERE username = ? AND profile_user = ?"),
  upsertPerm: db.prepare(
    `INSERT INTO profile_perms (username, profile_user, can_view_key, can_manage) VALUES (?, ?, ?, ?)
     ON CONFLICT (username, profile_user) DO UPDATE SET can_view_key = excluded.can_view_key, can_manage = excluded.can_manage`,
  ),
  deletePerm: db.prepare("DELETE FROM profile_perms WHERE username = ? AND profile_user = ?"),
  deletePermsOnProfile: db.prepare("DELETE FROM profile_perms WHERE profile_user = ?"),
  listPermsFor: db.prepare("SELECT * FROM profile_perms WHERE username = ? ORDER BY profile_user"),
  listPermsOn: db.prepare("SELECT * FROM profile_perms WHERE profile_user = ? ORDER BY username"),
};

export function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pass), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(pass, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const calc = crypto.scryptSync(String(pass), salt, 32).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function userCan(user, profile) {
  if (!user || !profile) return { viewKey: false, manage: false, any: false };
  const profileUser = typeof profile === "string" ? profile : profile.user;
  if (user.role === "admin") return { viewKey: true, manage: true, any: true };
  if (typeof profile === "object" && profile.created_by === user.username) {
    return { viewKey: true, manage: true, any: true };
  }
  const perm = sql.getPerm.get(user.username, profileUser);
  if (!perm) return { viewKey: false, manage: false, any: false };
  return {
    viewKey: !!perm.can_view_key,
    manage: !!perm.can_manage,
    any: !!perm.can_view_key || !!perm.can_manage,
  };
}

export function visibleProfiles(user) {
  if (user.role === "admin") return sql.listProfiles.all();
  const owned = sql.listProfiles.all().filter((p) => p.created_by === user.username);
  const perms = sql.listPermsFor.all(user.username).filter((p) => p.can_view_key || p.can_manage);
  const seen = new Set();
  const result = [];
  for (const p of [...owned, ...perms.map((p) => sql.getProfile.get(p.profile_user))]) {
    if (!p || seen.has(p.user)) continue;
    seen.add(p.user);
    result.push(p);
  }
  return result;
}
