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
  {
    // Reusable names (customers, suppliers, categories, units). Documents keep
    // storing plain text; this is a directory that fills itself in as you work.
    name: 'entities-directory',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT    NOT NULL,
          name         TEXT    NOT NULL COLLATE NOCASE,
          phone        TEXT    NOT NULL DEFAULT '',
          email        TEXT    NOT NULL DEFAULT '',
          address      TEXT    NOT NULL DEFAULT '',
          tax_id       TEXT    NOT NULL DEFAULT '',
          note         TEXT    NOT NULL DEFAULT '',
          active       INTEGER NOT NULL DEFAULT 1,
          used_count   INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (kind, name)
        );
        CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind, active);
      `);

      // Seed from names already typed on existing documents, so an established
      // shop gets a full directory the moment it updates.
      const seed = (kind, table, column) =>
        db.exec(
          `INSERT OR IGNORE INTO entities (kind, name, used_count)
           SELECT '${kind}', TRIM(${column}), COUNT(*)
           FROM ${table} WHERE TRIM(COALESCE(${column}, '')) <> ''
           GROUP BY TRIM(${column}) COLLATE NOCASE`,
        );
      seed('customer', 'sales', 'customer');
      seed('supplier', 'purchases', 'supplier');
      seed('category', 'products', 'category');
      seed('unit', 'products', 'unit');
      seed('expense_category', 'expenses', 'category');
    },
  },
  {
    // Partial payments. An invoice can be settled over several instalments, so
    // the amounts live in their own ledger and sales.paid becomes the running
    // total of that ledger rather than a single figure typed at the till.
    name: 'sale-payments',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          amount     REAL    NOT NULL,
          method     TEXT    NOT NULL DEFAULT 'cash',
          date       TEXT    NOT NULL,
          note       TEXT    NOT NULL DEFAULT '',
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
        CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);
      `);

      // Every sale already settled becomes its own first instalment, so history
      // reads the same before and after the update.
      db.exec(`
        INSERT INTO payments (sale_id, amount, method, date, note, user_id, created_at)
        SELECT s.id, s.paid, s.method, s.date, '', s.user_id, s.created_at
        FROM sales s
        WHERE s.paid > 0
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)
      `);
    },
  },
  {
    // Purchases can be edited after they are saved, so every create, edit and
    // delete is written to an audit log. purchase_id carries no foreign key on
    // purpose: the trail of a deleted purchase must outlive the purchase.
    name: 'purchase-log',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_id INTEGER NOT NULL,
          doc_no      TEXT    NOT NULL DEFAULT '',
          action      TEXT    NOT NULL,
          changes     TEXT    NOT NULL DEFAULT '{}',
          reason      TEXT    NOT NULL DEFAULT '',
          user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_purchase_log_purchase ON purchase_log(purchase_id);
      `);
      addColumn(db, 'purchases', 'updated_at', 'TEXT');

      // Existing purchases start their history with the moment they were recorded.
      db.exec(`
        INSERT INTO purchase_log (purchase_id, doc_no, action, changes, user_id, created_at)
        SELECT pu.id, pu.doc_no, 'created',
               json_object('total', pu.total,
                           'lines', (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id)),
               pu.user_id, pu.created_at
        FROM purchases pu
        WHERE NOT EXISTS (SELECT 1 FROM purchase_log l WHERE l.purchase_id = pu.id)
      `);
    },
  },
  {
    // Stock adjustments as documents: a count, damage or write-off covering many
    // products at once, with a number, a date and a reason. Loose adjustments
    // made before this stay in the movement ledger as they are.
    name: 'stock-adjustments',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS adjustments (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_no     TEXT    NOT NULL,
          date       TEXT    NOT NULL,
          reason     TEXT    NOT NULL DEFAULT '',
          note       TEXT    NOT NULL DEFAULT '',
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_adjustments_date ON adjustments(date);

        CREATE TABLE IF NOT EXISTS adjustment_items (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          adjustment_id INTEGER NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
          product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          stock_before  REAL    NOT NULL DEFAULT 0,
          qty           REAL    NOT NULL,
          unit_cost     REAL    NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_adjustment_items_doc ON adjustment_items(adjustment_id);
      `);
    },
  },
  {
    // One picture per product, kept inside the database so a backup carries it.
    // The browser shrinks it before upload, so rows stay small.
    name: 'product-images',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_images (
          product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
          mime       TEXT    NOT NULL,
          data       BLOB    NOT NULL,
          updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    // A second currency (L.L beside $). The books stay in the first currency;
    // an invoice remembers the rate of its day, and a payment taken in the second
    // currency keeps what was handed over and the rate it was converted at.
    name: 'second-currency',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS exchange_rates (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol     TEXT    NOT NULL DEFAULT '',
          rate       REAL    NOT NULL,
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'sales', 'rate2', 'REAL');
      addColumn(db, 'payments', 'currency', `TEXT NOT NULL DEFAULT ''`);
      addColumn(db, 'payments', 'amount2', 'REAL');
      addColumn(db, 'payments', 'rate', 'REAL');
    },
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
