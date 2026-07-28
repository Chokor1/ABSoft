import { createReadStream } from 'node:fs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKUP_DIR, DB_FILE, db } from '../db.js';
import { LATEST_VERSION, currentVersion } from '../migrations.js';
import { backupFilename, createBackup, createLocalBackup, listBackups } from '../backup.js';
import { forbidden } from '../http.js';
import { VERSION } from '../version.js';

const adminOnly = (ctx) => {
  if (ctx.user.role !== 'admin') throw forbidden('Administrator access required', 'ADMIN_ONLY');
};

export function register(router) {
  // Shown on the Settings → About card.
  router.get('/api/system', (ctx) => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM purchases) AS purchases,
                (SELECT COUNT(*) FROM expenses) AS expenses,
                (SELECT COUNT(*) FROM users) AS users`,
      )
      .get();
    let dbSize = 0;
    try {
      dbSize = statSync(DB_FILE).size;
    } catch {
      /* database not on disk yet */
    }
    return {
      version: VERSION,
      node: process.version,
      schema_version: currentVersion(db),
      schema_latest: LATEST_VERSION,
      db_file: DB_FILE,
      db_size: dbSize,
      backup_dir: BACKUP_DIR,
      counts,
      backups: ctx.user.role === 'admin' ? listBackups().slice(0, 5) : [],
    };
  });

  // Download a consistent snapshot. Built in a temp dir so a failed write never
  // leaves a half-finished file sitting in the user's backups folder.
  router.get('/api/backup', (ctx) => {
    adminOnly(ctx);
    const dir = mkdtempSync(join(tmpdir(), 'absoft-backup-'));
    const name = backupFilename();
    const file = join(dir, name);
    createBackup(file, db); // reuse the live connection

    const { size } = statSync(file);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': size,
      'Cache-Control': 'no-store',
    });

    const stream = createReadStream(file);
    stream.pipe(ctx.res);
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    stream.on('close', cleanup);
    stream.on('error', cleanup);
  });

  // Keep a copy on the machine itself (what update.cmd calls before pulling).
  router.post('/api/backup/local', (ctx) => {
    adminOnly(ctx);
    const { path, size } = createLocalBackup({ source: db });
    return { path, size, backups: listBackups().slice(0, 5) };
  });
}
