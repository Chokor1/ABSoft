import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, lastId } from './db.js';

const SESSION_DAYS = 14;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createUser({ username, password, full_name = '', role = 'cashier' }) {
  const { hash, salt } = hashPassword(password);
  const res = db
    .prepare(
      `INSERT INTO users (username, full_name, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(username.trim(), full_name.trim(), hash, salt, role);
  return lastId(res);
}

/** Seed the first administrator so a brand new install is usable. */
export function ensureSeedAdmin() {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  if (n > 0) return null;
  createUser({ username: 'admin', password: 'admin', full_name: 'Administrator', role: 'admin' });
  return { username: 'admin', password: 'admin' };
}

export function login(username, password) {
  const user = db
    .prepare(`SELECT * FROM users WHERE username = ? AND active = 1`)
    .get(String(username || '').trim());
  if (!user) return null;
  if (!verifyPassword(String(password || ''), user.salt, user.password_hash)) return null;

  const token = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
  ).run(token, user.id);
  return { token, user: publicUser(user) };
}

export function logout(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`,
    )
    .get(token);
  return row ? publicUser(row) : null;
}

export function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

export const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  full_name: u.full_name,
  role: u.role,
  active: !!u.active,
  created_at: u.created_at,
});
