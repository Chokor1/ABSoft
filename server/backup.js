import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_DIR, DB_FILE } from './paths.js';

/**
 * `VACUUM INTO` writes a consistent, fully-checkpointed copy of the database in one
 * step. That matters because ABSoft runs in WAL mode: plain file copying can catch
 * the .db without its .db-wal and produce a backup that silently misses recent sales.
 * It is also safe to run while the shop is trading — no need to stop the server.
 *
 * Pass `source` when the server is already running (reuse its connection). With no
 * source this opens its own, deliberately *without* importing db.js — so taking a
 * backup never applies a migration. A backup must never change what it is copying.
 */
export function createBackup(destination, source) {
  const db = source ?? new DatabaseSync(DB_FILE);
  try {
    // SQLite refuses to overwrite, and wants forward slashes even on Windows.
    db.exec(`VACUUM INTO '${destination.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  } finally {
    if (!source) db.close();
  }
  return { path: destination, size: statSync(destination).size };
}

/** absoft-backup-2026-07-28-143000.db — sorts chronologically, no illegal characters. */
export function backupFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `absoft-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.db`
  );
}

/** Write a timestamped backup into data/backups, pruning old ones. */
export function createLocalBackup({ keep = 20, source } = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Two in the same second (a folder saved, then a shift closed) must not fight over
  // one name: VACUUM INTO refuses to overwrite, so the second gets a suffix.
  const base = join(BACKUP_DIR, backupFilename().slice(0, -3));
  let file = `${base}.db`;
  for (let n = 2; existsSync(file); n++) file = `${base}-${n}.db`;
  const result = createBackup(file, source);
  pruneBackups(keep);
  return result;
}

export function listBackups() {
  let names;
  try {
    names = readdirSync(BACKUP_DIR);
  } catch {
    return []; // no backups taken yet
  }
  // Read the fields off Stats explicitly — spreading it drops the prototype
  // getters (mtime among them) and yields undefined.
  return names
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const info = statSync(join(BACKUP_DIR, name));
      return { name, size: info.size, modified: info.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups(keep) {
  for (const old of listBackups().slice(keep)) {
    try {
      unlinkSync(join(BACKUP_DIR, old.name));
    } catch {
      /* a backup we cannot remove is not worth failing the backup over */
    }
  }
}
