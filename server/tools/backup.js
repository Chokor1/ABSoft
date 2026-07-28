/**
 * Write a timestamped snapshot into data/backups.
 *
 *   npm run backup
 *
 * Safe to run while ABSoft is serving customers, and strictly read-only: it opens
 * the database directly rather than through db.js, so it never applies a migration.
 * update.cmd calls this before pulling new code, so the snapshot always predates
 * whatever the update is about to change.
 */
import { createLocalBackup, listBackups } from '../backup.js';

const { path, size } = createLocalBackup();

console.log(`Backup written: ${path}`);
console.log(`Size:           ${(size / 1024).toFixed(1)} KB`);
console.log(`Kept on disk:   ${listBackups().length} (oldest are pruned automatically)`);
