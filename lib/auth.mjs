// Authentication: scrypt password hashing, opaque session tokens stored as
// SHA-256 hashes, and a small in-memory limiter on sign-in attempts.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, setSetting } from './db.mjs';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

export function createSession(userId) {
  const token = randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)`)
    .run(tokenHash(token), userId, new Date().toISOString());
  // Housekeeping: drop this user's expired sessions.
  const cutoff = new Date(Date.now() - SESSION_DAYS * 86400000).toISOString();
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND created_at < ?`).run(userId, cutoff);
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token_hash, s.created_at, u.id, u.username, u.name, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(tokenHash(token));
  if (!row) return null;
  const ageDays = (Date.now() - Date.parse(row.created_at)) / 86400000;
  if (ageDays > SESSION_DAYS || !row.active) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(row.token_hash);
    return null;
  }
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

export function destroySession(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token));
}

export function destroyUserSessions(userId) {
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

// First run requires an operator-supplied password; existing accounts are unchanged.
export function ensureAdminUser() {
  if (db.prepare(`SELECT COUNT(*) n FROM users`).get().n > 0) return false;
  const password = process.env.BAAZARU_ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set BAAZARU_ADMIN_PASSWORD to at least 12 characters for first-run setup.');
  const { salt, hash } = hashPassword(password);
  db.prepare(
    `INSERT INTO users (username, name, role, pass_salt, pass_hash, active, created_at)
     VALUES ('admin', 'Admin', 'admin', ?, ?, 1, ?)`
  ).run(salt, hash, new Date().toISOString());
  setSetting('default_admin', '1');
  return true;
}

// ---- sign-in attempt limiter (per source IP, in-memory) ----

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

export function loginAllowed(ip) {
  const a = attempts.get(ip);
  if (!a) return true;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(ip);
    return true;
  }
  return a.fails < MAX_FAILS;
}

export function recordLoginFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) {
    attempts.set(ip, { fails: 1, first: Date.now() });
  } else {
    a.fails++;
  }
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) if (Date.now() - v.first > WINDOW_MS) attempts.delete(k);
  }
}

export function recordLoginSuccess(ip) {
  attempts.delete(ip);
}

// True exactly once per throttle window, so sustained hammering leaves one
// audit row instead of a spam channel.
export function shouldLogThrottle(ip) {
  const a = attempts.get(ip);
  if (a && !a.throttleLogged) {
    a.throttleLogged = true;
    return true;
  }
  return false;
}

// Burn one scrypt of equivalent cost when the account is missing or inactive,
// so login latency doesn't reveal which usernames exist.
const DUMMY = hashPassword('timing-equalizer');
export function burnVerify(password) {
  verifyPassword(password, DUMMY.salt, DUMMY.hash);
}
