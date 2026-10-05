import { DatabaseSync } from 'node:sqlite';

import { runMigrations } from './migrations.js';
import { BACKUP_DIR, DB_FILE, ensureDataDir } from './paths.js';

export { BACKUP_DIR, DB_FILE };

ensureDataDir();

export const db = new DatabaseSync(DB_FILE);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'cashier',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  barcode    TEXT    UNIQUE,
  category   TEXT    NOT NULL DEFAULT '',
  unit       TEXT    NOT NULL DEFAULT 'pcs',
  cost       REAL    NOT NULL DEFAULT 0,
  price      REAL    NOT NULL DEFAULT 0,
  min_stock  REAL    NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- Every change of stock lands here. Quantity is signed: positive = in, negative = out.
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        REAL    NOT NULL,
  unit_cost  REAL    NOT NULL DEFAULT 0,
  kind       TEXT    NOT NULL,          -- purchase | sale | adjust | opening
  ref_table  TEXT    NOT NULL DEFAULT '',
  ref_id     INTEGER,
  note       TEXT    NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_moves_date ON stock_moves(created_at);

CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no     TEXT    NOT NULL,
  supplier   TEXT    NOT NULL DEFAULT '',
  date       TEXT    NOT NULL,
  total      REAL    NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty         REAL    NOT NULL,
  unit_cost   REAL    NOT NULL,
  total       REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no     TEXT    NOT NULL,
  customer   TEXT    NOT NULL DEFAULT '',
  date       TEXT    NOT NULL,
  subtotal   REAL    NOT NULL DEFAULT 0,
  discount   REAL    NOT NULL DEFAULT 0,
  tax        REAL    NOT NULL DEFAULT 0,
  total      REAL    NOT NULL DEFAULT 0,
  cogs       REAL    NOT NULL DEFAULT 0,
  paid       REAL    NOT NULL DEFAULT 0,
  method     TEXT    NOT NULL DEFAULT 'cash',
  note       TEXT    NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);

CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty        REAL    NOT NULL,
  unit_price REAL    NOT NULL,
  unit_cost  REAL    NOT NULL DEFAULT 0,
  discount   REAL    NOT NULL DEFAULT 0,
  total      REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'General',
  note       TEXT    NOT NULL DEFAULT '',
  amount     REAL    NOT NULL,
  method     TEXT    NOT NULL DEFAULT 'cash',
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Live stock balance, always derived from the movement ledger so it cannot drift.
CREATE VIEW IF NOT EXISTS product_stock AS
  SELECT p.id AS product_id, COALESCE(SUM(m.qty), 0) AS stock
  FROM products p LEFT JOIN stock_moves m ON m.product_id = p.id
  GROUP BY p.id;
`);

/**
 * Everything above is the first-release schema and is only created when missing.
 * Anything added since lives in migrations.js, so an existing shop database is
 * upgraded in place rather than left behind on an old shape.
 */
export const appliedMigrations = runMigrations(db, { log: (line) => console.log(line) });

const DEFAULT_SETTINGS = {
  store_name: 'ABSoft Store',
  // Labels from a weighing scale: off until the shop says which prefix its scale prints.
  scale_enabled: '0',
  scale_prefix: '21',
  scale_item_digits: '5',
  scale_mode: 'weight',
  currency: '$',
  tax_rate: '0',
  low_stock_alert: '1',
  receipt_footer: 'Thank you for your business!',
  // Optional second currency, e.g. L.L at 89,500 to the dollar. Off until switched on.
  currency2_enabled: '0',
  currency2_symbol: 'L.L',
  currency2_rate: '0',
  currency2_decimals: '0',
  // The till: shifts off until switched on; search every product from the first letter;
  // 40 cards at a time.
  // The shop's logo, as a small data URL; it heads every printed document.
  store_logo: '',
  pos_shifts: '0',
  search_min_chars: '1',
  pos_page_size: '40',
};

const setSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting.run(k, v);

export function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function saveSettings(patch) {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const [k, v] of Object.entries(patch)) stmt.run(k, String(v));
  return getSettings();
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export function transact(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export const lastId = (result) => Number(result.lastInsertRowid);
