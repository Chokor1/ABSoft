import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read package.json for the version number.
 *
 * The BOM strip is not cosmetic: Notepad, PowerShell's `Out-File` and several
 * editors save UTF-8 with a byte order mark, and JSON.parse rejects it outright.
 * Bumping the version by hand before a release is exactly when that happens, so
 * without this a one-character edit could stop the till from starting.
 */
const BOM = '﻿';

function readPackageJson() {
  let raw = readFileSync(join(APP_DIR, 'package.json'), 'utf8');
  if (raw.startsWith(BOM)) raw = raw.slice(BOM.length);
  return JSON.parse(raw);
}

export const VERSION = readPackageJson().version;
