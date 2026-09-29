/**
 * Backups nobody has to remember: one a day, at the first start of the day (or the
 * first quiet half-hour of it, for a server left running), and one whenever a shift
 * closes. Each goes into data/backups like a manual one, and, when the shop has
 * named a second folder — a OneDrive or Google Drive folder, a USB stick — a copy
 * goes there too, so a dead disk does not take the only copy with it.
 *
 * What happened last is kept in the settings table (`backup_last_auto`,
 * `backup_last_error`), so Settings → Backup can say so, and a failure is never
 * silent. Nothing here throws: a backup that fails must not stop a shift closing.
 */
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createLocalBackup } from './backup.js';
import { db, getSettings, saveSettings } from './db.js';
import { today } from './util.js';

const KEEP = 20;
const CHECK_EVERY = 30 * 60 * 1000;

const stamp = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/** Take one now. Returns true when the main copy was written. */
export function autoBackup(reason = 'daily') {
  const patch = {};
  let file = null;
  try {
    file = createLocalBackup({ keep: KEEP, source: db }).path;
    patch.backup_last_auto = stamp();
    patch.backup_last_error = '';
  } catch (err) {
    patch.backup_last_error = `${reason}: ${err.message}`;
  }
  const dir2 = (getSettings().backup_dir2 || '').trim();
  if (file && dir2) {
    try {
      mkdirSync(dir2, { recursive: true });
      copyFileSync(file, join(dir2, basename(file)));
      prune(dir2);
    } catch (err) {
      patch.backup_last_error = `${dir2}: ${err.message}`;
    }
  }
  saveSettings(patch);
  return !!file;
}

/** The second folder keeps the same number of copies as data/backups. */
function prune(dir) {
  const names = readdirSync(dir)
    .filter((n) => /^absoft-backup-.*\.db$/.test(n))
    .sort()
    .reverse();
  for (const old of names.slice(KEEP)) {
    try {
      unlinkSync(join(dir, old));
    } catch {
      /* a copy we cannot remove is not worth failing the backup over */
    }
  }
}

/** True when today has not had its backup yet. */
export const dailyBackupDue = () => (getSettings().backup_last_auto || '').slice(0, 10) !== today();

/** Called once when the server starts: today's backup if it is missing, then a check every half hour. */
export function startAutoBackups() {
  if (dailyBackupDue()) autoBackup('daily');
  setInterval(() => {
    if (dailyBackupDue()) autoBackup('daily');
  }, CHECK_EVERY).unref();
}
