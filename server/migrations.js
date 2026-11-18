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
  {
    // Opening stock as documents: what was on the shelf when a product (or the
    // whole shop) started in ABSoft, with its cost. Opening balances entered
    // before this stay in the movement ledger as they are.
    name: 'opening-stock-documents',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS openings (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_no     TEXT    NOT NULL,
          date       TEXT    NOT NULL,
          note       TEXT    NOT NULL DEFAULT '',
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_openings_date ON openings(date);

        CREATE TABLE IF NOT EXISTS opening_items (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          opening_id INTEGER NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          qty        REAL    NOT NULL,
          unit_cost  REAL    NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_opening_items_doc ON opening_items(opening_id);
      `);
    },
  },
  {
    // Opening stock is a type of stock adjustment after all, not a document of
    // its own. Any opening stock documents already written become adjustments
    // of type "opening", their stock movements follow them, and the separate
    // tables go.
    name: 'opening-stock-as-adjustments',
    up: (db) => {
      addColumn(db, 'adjustments', 'type', `TEXT NOT NULL DEFAULT 'adjustment'`);
      if (!hasTable(db, 'openings')) return;

      const openings = db.prepare(`SELECT * FROM openings ORDER BY id`).all();
      const lastAdj = () => Number(db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM adjustments`).get().n);
      for (const o of openings) {
        const docNo = `ADJ-${String(lastAdj() + 1).padStart(6, '0')}`;
        const res = db
          .prepare(
            `INSERT INTO adjustments (doc_no, date, reason, note, user_id, created_at, type)
             VALUES (?, ?, 'Opening stock', ?, ?, ?, 'opening')`,
          )
          .run(docNo, o.date, o.note, o.user_id, o.created_at);
        const adjId = Number(res.lastInsertRowid);
        db.prepare(
          `INSERT INTO adjustment_items (adjustment_id, product_id, stock_before, qty, unit_cost)
           SELECT ?, product_id, 0, qty, unit_cost FROM opening_items WHERE opening_id = ?`,
        ).run(adjId, o.id);
        db.prepare(`UPDATE stock_moves SET ref_table = 'adjustments', ref_id = ? WHERE ref_table = 'openings' AND ref_id = ?`).run(adjId, o.id);
      }
      db.exec(`DROP TABLE IF EXISTS opening_items; DROP TABLE IF EXISTS openings;`);
    },
  },
  {
    // More than one barcode per product: the same item from two suppliers, an
    // old and a new pack. products.barcode stays the main one; the others live
    // here, and no code may belong to two products.
    name: 'product-barcodes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_barcodes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          barcode    TEXT    NOT NULL UNIQUE,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);
      `);
    },
  },
  {
    // Customer and supplier pages read every document by name.
    name: 'party-indexes',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier COLLATE NOCASE);
      `);
    },
  },
  {
    // How people pay is a list of its own: Cash and On account are always there
    // (they can be switched off, never deleted), and a shop adds its own — Whish,
    // OMT, a card machine — each with an icon for the till.
    name: 'payment-methods',
    up: (db) => {
      addColumn(db, 'entities', 'icon', `TEXT NOT NULL DEFAULT ''`);
      addColumn(db, 'entities', 'builtin', 'INTEGER NOT NULL DEFAULT 0');

      const add = db.prepare(
        `INSERT OR IGNORE INTO entities (kind, name, icon, builtin, used_count) VALUES ('payment_method', ?, ?, ?, ?)`,
      );
      // The names are what documents already hold, so nothing needs rewriting. The
      // count only decides the order they are offered in, and usage takes over.
      for (const [name, glyph, builtin, order] of [
        ['cash', 'coins', 1, 5],
        ['credit', 'receipt', 1, 4],
        ['card', 'card', 0, 3],
        ['transfer', 'transfer', 0, 2],
        ['Whish', 'whish', 0, 1],
        ['OMT', 'omt', 0, 1],
      ]) {
        add.run(name, glyph, builtin, order);
      }
      // Anything else already written on a document joins the list as it stands.
      db.exec(
        `INSERT OR IGNORE INTO entities (kind, name, icon, used_count)
         SELECT 'payment_method', m, '', COUNT(*) FROM (
           SELECT TRIM(method) AS m FROM sales WHERE TRIM(COALESCE(method, '')) <> ''
           UNION ALL SELECT TRIM(method) FROM payments WHERE TRIM(COALESCE(method, '')) <> ''
           UNION ALL SELECT TRIM(method) FROM expenses WHERE TRIM(COALESCE(method, '')) <> ''
         ) GROUP BY m COLLATE NOCASE`,
      );
    },
  },
  {
    // Shifts at the till: opened with the cash in the drawer, closed by counting
    // it. Sales and payments taken during a shift carry its id, so the count can
    // be checked against what the drawer should hold.
    name: 'pos-shifts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shifts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_no        TEXT    NOT NULL,
          opened_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          opened_at     TEXT    NOT NULL,
          opening_cash  REAL    NOT NULL DEFAULT 0,
          opening_cash2 REAL    NOT NULL DEFAULT 0,
          opening_note  TEXT    NOT NULL DEFAULT '',
          closed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          closed_at     TEXT,
          expected_cash  REAL,
          expected_cash2 REAL,
          counted_cash   REAL,
          counted_cash2  REAL,
          closing_note  TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts(closed_at);
      `);
      addColumn(db, 'sales', 'shift_id', 'INTEGER');
      addColumn(db, 'payments', 'shift_id', 'INTEGER');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
               CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);`);
    },
  },
  {
    // Closing a shift counts every way of paying, not only the cash: what the
    // card terminal, Whish or OMT say came in, kept as { method: amount }.
    name: 'shift-method-counts',
    up: (db) => {
      addColumn(db, 'shifts', 'counted_methods', "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    // A return is a sale document with negative quantities and money, linked to the
    // invoice it undoes, so every figure that sums sales nets it out by itself. Each
    // line says whether the goods went back on the shelf; a damaged one refunds the
    // money but keeps the cost on the books, which is what a loss is.
    name: 'returns',
    up: (db) => {
      addColumn(db, 'sales', 'kind', "TEXT NOT NULL DEFAULT 'sale'");
      addColumn(db, 'sales', 'return_of', 'INTEGER');
      addColumn(db, 'sale_items', 'restock', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'sale_items', 'return_of_item', 'INTEGER');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_return_of ON sales(return_of);
               CREATE INDEX IF NOT EXISTS idx_sale_items_return_of ON sale_items(return_of_item);`);
    },
  },
  {
    // Sales put aside at the till while the next customer is served. The cart is
    // kept whole, as JSON: it is not a sale yet, so it touches no sale, stock or
    // payment table.
    name: 'held-sales',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS held_sales (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          label      TEXT    NOT NULL DEFAULT '',
          summary    TEXT    NOT NULL DEFAULT '',
          cart       TEXT    NOT NULL,
          lines      INTEGER NOT NULL DEFAULT 0,
          total      REAL    NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL
        );
      `);
    },
  },
  {
    // Price lists: the same product sold or bought at more than one price. Every
    // shop starts with one list, the default, whose prices are the products' own
    // — so a shop that never makes a second list works exactly as before.
    name: 'price-lists',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_lists (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
          use_for    TEXT    NOT NULL DEFAULT 'sell',
          is_default INTEGER NOT NULL DEFAULT 0,
          active     INTEGER NOT NULL DEFAULT 1,
          note       TEXT    NOT NULL DEFAULT '',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS product_prices (
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          list_id    INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
          price      REAL    NOT NULL DEFAULT 0,
          PRIMARY KEY (product_id, list_id)
        );
        CREATE INDEX IF NOT EXISTS idx_product_prices_list ON product_prices(list_id);
      `);
      // The list every shop already sells at, whether it knows it or not.
      db.prepare(
        `INSERT INTO price_lists (name, use_for, is_default, active, note)
         SELECT 'Retail', 'both', 1, 1, ''
         WHERE NOT EXISTS (SELECT 1 FROM price_lists WHERE is_default = 1)`,
      ).run();
      // A customer or supplier can be served at a list of their own.
      addColumn(db, 'entities', 'price_list_id', 'INTEGER');
      // What a document was priced at, kept with it.
      addColumn(db, 'sales', 'price_list_id', 'INTEGER');
      addColumn(db, 'purchases', 'price_list_id', 'INTEGER');
    },
  },
  {
    // Every price change a product goes through, on any list: what it was, what
    // it became, when, and who did it.
    name: 'price-history',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_changes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          list_id    INTEGER REFERENCES price_lists(id) ON DELETE CASCADE,
          field      TEXT    NOT NULL DEFAULT 'price',
          old_price  REAL,
          new_price  REAL,
          changed_at TEXT    NOT NULL DEFAULT (datetime('now')),
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_price_changes_product ON price_changes(product_id, id DESC);
      `);
    },
  },
  {
    // Sizes: one product sold in several sizes (S, M, L, Bottle), each at its own
    // price. A product with no sizes has no rows here and sells exactly as it
    // always has. A sale line keeps the size's name as text, so an old invoice
    // still reads "Mango · L" after a size is renamed or removed.
    name: 'product-sizes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_sizes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          price      REAL    NOT NULL DEFAULT 0,
          cost       REAL    NOT NULL DEFAULT 0,
          sort       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_product_sizes_product ON product_sizes(product_id, sort);
      `);
      addColumn(db, 'sale_items', 'size_id', 'INTEGER');
      addColumn(db, 'sale_items', 'size', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Add-ons and line notes: toppings on a crêpe, protein in a shake, each at its
    // own price, kept in lists a product can offer; and a note on any line. With
    // no list and no note, a sale is exactly what it was.
    name: 'addons-and-notes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS addon_groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL COLLATE NOCASE,
          sort       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS addons (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
          name     TEXT    NOT NULL,
          price    REAL    NOT NULL DEFAULT 0,
          cost     REAL    NOT NULL DEFAULT 0,
          sort     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_addons_group ON addons(group_id, sort);
      `);
      addColumn(db, 'products', 'addon_group_id', 'INTEGER');
      // What a line was made with, by name and price, and its note — kept as text,
      // so an old invoice reads the same after a list is changed or removed.
      addColumn(db, 'sale_items', 'addons', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sale_items', 'note', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Recipes and consumption reconciliation, for shops that make what they sell.
    // Nothing here changes how stock moves until the shop switches recipes on:
    // every product keeps stock (stocked = 1) and none is a raw material (raw = 0).
    name: 'recipes-and-consumption',
    up: (db) => {
      addColumn(db, 'products', 'stocked', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'products', 'raw', 'INTEGER NOT NULL DEFAULT 0');
      // Where an ingredient's unreconciled use starts: its own last reconciliation.
      addColumn(db, 'products', 'consumed_until', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS recipe_lines (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          ingredient_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          qty           REAL    NOT NULL DEFAULT 0,
          sort          INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_recipe_product ON recipe_lines(product_id);
        CREATE INDEX IF NOT EXISTS idx_recipe_ingredient ON recipe_lines(ingredient_id);

        -- What each sale probably used, written when it was made.
        CREATE TABLE IF NOT EXISTS estimated_use (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          sale_item_id  INTEGER,
          ingredient_id INTEGER NOT NULL,
          qty           REAL    NOT NULL,
          created_at    TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_estimated_use ON estimated_use(ingredient_id, created_at);

        CREATE TABLE IF NOT EXISTS consumptions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_no       TEXT    NOT NULL,
          until        TEXT,
          note         TEXT    NOT NULL DEFAULT '',
          status       TEXT    NOT NULL DEFAULT 'draft',
          user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at   TEXT    NOT NULL,
          submitted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS consumption_items (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          consumption_id INTEGER NOT NULL REFERENCES consumptions(id) ON DELETE CASCADE,
          product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          since          TEXT    NOT NULL DEFAULT '',
          suggested      REAL    NOT NULL DEFAULT 0,
          actual         REAL    NOT NULL DEFAULT 0,
          counted        REAL,
          unit_cost      REAL    NOT NULL DEFAULT 0,
          sort           INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    // Attributes: a template item ("Mango juice") whose variants ("Mango juice L",
    // "Mango juice Bottle") are items of their own, each with its price, barcode,
    // stock and recipe. Nothing changes for a shop that never makes a template.
    name: 'attributes-and-variants',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attributes (
          id   INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT    NOT NULL COLLATE NOCASE UNIQUE,
          sort INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS attribute_values (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          attribute_id INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
          name         TEXT    NOT NULL,
          sort         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_attribute_values ON attribute_values(attribute_id, sort);
        -- A template: the values it comes in. A variant: the values it is.
        CREATE TABLE IF NOT EXISTS product_attribute_values (
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          value_id   INTEGER NOT NULL REFERENCES attribute_values(id) ON DELETE CASCADE,
          PRIMARY KEY (product_id, value_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pav_value ON product_attribute_values(value_id);
      `);
      addColumn(db, 'products', 'has_variants', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'products', 'variant_of', 'INTEGER REFERENCES products(id) ON DELETE SET NULL');
      // The variant's values, as sorted ids: one variant per combination.
      addColumn(db, 'products', 'variant_key', 'TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_products_variant_of ON products(variant_of)`);
    },
  },
  {
    // Restaurant mode: tables, and the order open on each. Nothing here is used
    // until the shop switches restaurant mode on.
    name: 'restaurant-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dining_tables (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          name   TEXT    NOT NULL COLLATE NOCASE UNIQUE,
          sort   INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1
        );
        -- One open order per table, kept like a held sale until it is paid.
        CREATE TABLE IF NOT EXISTS table_orders (
          table_id   INTEGER PRIMARY KEY REFERENCES dining_tables(id) ON DELETE CASCADE,
          user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          cart       TEXT    NOT NULL,
          summary    TEXT    NOT NULL DEFAULT '',
          lines      INTEGER NOT NULL DEFAULT 0,
          total      REAL    NOT NULL DEFAULT 0,
          opened_at  TEXT    NOT NULL,
          updated_at TEXT    NOT NULL,
          version    INTEGER NOT NULL DEFAULT 1
        );
      `);
      // Which table a sale was served at, by name, for the receipt and the record.
      addColumn(db, 'sales', 'table_name', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Add-ons become items: an item marked as an add-on, with what it is offered
    // with — every item, some categories, or some items. The add-on lists of v20
    // are left in place, unused.
    name: 'addon-items',
    up: (db) => {
      addColumn(db, 'products', 'is_addon', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'products', 'addon_scope', "TEXT NOT NULL DEFAULT 'all'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS addon_links (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          addon_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          category   TEXT,
          product_id INTEGER REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_addon_links ON addon_links(addon_id);
      `);
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
      `This database was created by a newer version of ABSoft POS (schema v${from}, this build ` +
        `understands v${LATEST_VERSION}). Update ABSoft POS before opening it, so your data stays safe.`,
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
