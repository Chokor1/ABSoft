/**
 * Schema migrations.
 *
 * `db.js` creates the base schema with CREATE TABLE IF NOT EXISTS, which is enough
 * for a brand new database but does nothing to one that already holds a shop's data.
 * Every change made after the first release therefore goes here instead, so a
 * production install can pull a new version and have its database brought forward
 * automatically on the next start.
 *
 * Rules for adding one:
 *   - Append to the end of MIGRATIONS. Never reorder, renumber or edit a shipped entry.
 *   - Make it safe to run twice (use the hasColumn/hasTable helpers).
 *   - Never drop or rewrite a column that holds real data.
 *
 * Progress is tracked in SQLite's own `user_version`, so it costs no extra table.
 */

export const hasTable = (db, table) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);

export const hasColumn = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .some((c) => c.name === column);

function addColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Applied in order. The array index + 1 is the version number. */
const MIGRATIONS = [
  {
    name: 'product-description',
    up: (db) => addColumn(db, 'products', 'description', `TEXT NOT NULL DEFAULT ''`),
  },
];

export const LATEST_VERSION = MIGRATIONS.length;

export const currentVersion = (db) => Number(db.prepare(`PRAGMA user_version`).get().user_version);

/**
 * Bring `db` up to LATEST_VERSION. Returns the names of the migrations applied.
 * Throws if the database is newer than this copy of the code — that means someone
 * installed an older build over a newer one, and guessing would risk their data.
 */
export function runMigrations(db, { log = () => {} } = {}) {
  const from = currentVersion(db);

  if (from > LATEST_VERSION) {
    throw new Error(
      `This database was created by a newer version of ABSoft (schema v${from}, this build ` +
        `understands v${LATEST_VERSION}). Update ABSoft before opening it, so your data stays safe.`,
    );
  }
  if (from === LATEST_VERSION) return [];

  const applied = [];
  for (let i = from; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    const version = i + 1;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} (${migration.name}) failed: ${err.message}`);
    }
    applied.push(migration.name);
    log(`  migrated  v${version} - ${migration.name}`);
  }
  return applied;
}
