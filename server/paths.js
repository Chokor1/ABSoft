import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { APP_DIR } from './version.js';

/**
 * Where things live, with no side effects beyond creating the folder.
 *
 * Kept separate from db.js on purpose: importing db.js opens the database and
 * applies migrations, which is exactly what a backup taken *before* an update
 * must not do.
 */
export const DATA_DIR = process.env.ABSOFT_DATA || join(APP_DIR, 'data');
export const DB_FILE = join(DATA_DIR, 'absoft.db');
export const BACKUP_DIR = join(DATA_DIR, 'backups');

export const ensureDataDir = () => mkdirSync(DATA_DIR, { recursive: true });
