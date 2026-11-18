/**
 * Restaurant mode: tables, each free or open with an order.
 *
 * An open table's order is a cart kept on the server, like a held sale: it moves
 * no stock and takes no money until it is paid. Unlike a held sale it stays on
 * its table while it is worked on — the waiter brings it to the till, adds the
 * dessert, and sends it back — and paying it frees the table in the same step.
 *
 * Every save carries the version it started from, so two tills working on one
 * table never overwrite each other, and a till never charges an order that has
 * grown since it opened it.
 *
 * Off until switched on in Settings → POS: off, the till has no tables at all.
 */
import { db, getSettings, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, num, str } from '../util.js';
import { readCart, restoreLines } from './held.js';

export const restaurantEnabled = () => getSettings().restaurant === '1';

const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/** Every table with what is on it: free, or open with its order's total. */
export function listTables({ all = false } = {}) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.sort, t.active, o.total, o.lines, o.summary, o.opened_at, o.updated_at, o.version, u.username
       FROM dining_tables t
       LEFT JOIN table_orders o ON o.table_id = t.id
       LEFT JOIN users u ON u.id = o.user_id
       ${all ? '' : 'WHERE t.active = 1 OR o.table_id IS NOT NULL'}
       ORDER BY t.sort, t.id`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      status: r.version ? 'open' : 'free',
      ...(r.version
        ? { order: { total: num(r.total), lines: num(r.lines), summary: r.summary, opened_at: r.opened_at, updated_at: r.updated_at, version: r.version, by: r.username || '' } }
        : {}),
    }));
}

export const openTablesCount = () => num(db.prepare(`SELECT COUNT(*) AS n FROM table_orders`).get().n);

function tableOf(id) {
  const t = db.prepare(`SELECT * FROM dining_tables WHERE id = ?`).get(num(id));
  if (!t) throw notFound('That table no longer exists', 'TABLE_NOT_FOUND');
  return t;
}

function assertEnabled() {
  if (!restaurantEnabled()) throw badRequest('Restaurant mode is switched off in Settings', 'RESTAURANT_OFF');
}

function readName(body, ignoreId = 0) {
  const name = str(body.name).slice(0, 40);
  if (!name) throw badRequest('Give the table a name', 'TABLE_NAME_REQUIRED');
  if (db.prepare(`SELECT 1 FROM dining_tables WHERE name = ? COLLATE NOCASE AND id <> ?`).get(name, ignoreId)) {
    throw badRequest(`There is already a table called "${name}"`, 'TABLE_TAKEN', { name });
  }
  return name;
}

/**
 * Called by the sale when it pays a table's order: the order must be the one the
 * till opened (same version), and the table is freed in the sale's transaction.
 */
export function closeTableForSale(tableId, version) {
  const table = tableOf(tableId);
  const order = db.prepare(`SELECT version FROM table_orders WHERE table_id = ?`).get(table.id);
  if (!order) throw badRequest(`${table.name} has no open order — it was paid or cleared at another till`, 'TABLE_NOT_OPEN', { name: table.name });
  if (num(version) !== num(order.version)) {
    throw badRequest(`${table.name} changed at another till: open it again before paying`, 'TABLE_CHANGED', { name: table.name });
  }
  db.prepare(`DELETE FROM table_orders WHERE table_id = ?`).run(table.id);
  return table;
}

export function register(router) {
  router.get('/api/tables', (ctx) => listTables({ all: ctx.query.all === '1' }));

  router.post('/api/tables', (ctx) => {
    assertEnabled();
    // Several at once: "Table 1" to "Table 12".
    const count = Math.min(60, Math.max(0, Math.round(num(ctx.body.count))));
    if (count) {
      const prefix = str(ctx.body.prefix) || 'Table';
      return transact(() => {
        let sort = num(db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM dining_tables`).get().s);
        let n = 1;
        let made = 0;
        while (made < count) {
          const name = `${prefix} ${n++}`;
          if (db.prepare(`SELECT 1 FROM dining_tables WHERE name = ? COLLATE NOCASE`).get(name)) continue;
          db.prepare(`INSERT INTO dining_tables (name, sort) VALUES (?, ?)`).run(name, sort++);
          made++;
        }
        return listTables({ all: true });
      });
    }
    const name = readName(ctx.body);
    const sort = num(db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM dining_tables`).get().s);
    const id = lastId(db.prepare(`INSERT INTO dining_tables (name, sort) VALUES (?, ?)`).run(name, sort));
    return listTables({ all: true }).find((t) => t.id === id);
  });

  router.put('/api/tables/:id', (ctx) => {
    assertEnabled();
    const table = tableOf(ctx.params.id);
    const name = ctx.body.name !== undefined ? readName(ctx.body, table.id) : table.name;
    const active = ctx.body.active === undefined ? table.active : ctx.body.active === false || ctx.body.active === 0 || ctx.body.active === '0' ? 0 : 1;
    db.prepare(`UPDATE dining_tables SET name = ?, active = ? WHERE id = ?`).run(name, active, table.id);
    return listTables({ all: true }).find((t) => t.id === table.id);
  });

  router.delete('/api/tables/:id', (ctx) => {
    const table = tableOf(ctx.params.id);
    if (db.prepare(`SELECT 1 FROM table_orders WHERE table_id = ?`).get(table.id)) {
      throw badRequest(`${table.name} has an open order: pay or clear it first`, 'TABLE_OPEN', { name: table.name });
    }
    db.prepare(`DELETE FROM dining_tables WHERE id = ?`).run(table.id);
    return { ok: true };
  });

  /** An open table's order, ready for the till, with the version it is at. */
  router.get('/api/tables/:id/order', (ctx) => {
    const table = tableOf(ctx.params.id);
    const row = db.prepare(`SELECT * FROM table_orders WHERE table_id = ?`).get(table.id);
    if (!row) throw badRequest(`${table.name} is free`, 'TABLE_NOT_OPEN', { name: table.name });
    const cart = JSON.parse(row.cart);
    const { items, dropped } = restoreLines(cart.items || []);
    return { table: { id: table.id, name: table.name }, version: row.version, opened_at: row.opened_at, items, draft: cart.draft || {}, dropped };
  });

  /**
   * Send a cart to a table. `version` given: it replaces the order the till
   * opened at that version. No version: a new order on a free table, or, on an
   * open one, these lines are added to what is already there.
   */
  router.put('/api/tables/:id/order', (ctx) => {
    assertEnabled();
    const table = tableOf(ctx.params.id);
    const cart = readCart(ctx.body);
    return transact(() => {
      const row = db.prepare(`SELECT * FROM table_orders WHERE table_id = ?`).get(table.id);
      const now = localNow();
      const write = (items, draft, opened, version) => {
        const total = money(items.reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100), 0));
        const names = items.map((l) => `${db.prepare(`SELECT name FROM products WHERE id = ?`).get(l.product_id)?.name || ''} × ${l.qty}`);
        const summary = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
        db.prepare(
          `INSERT INTO table_orders (table_id, user_id, cart, summary, lines, total, opened_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(table_id) DO UPDATE SET user_id = excluded.user_id, cart = excluded.cart, summary = excluded.summary,
             lines = excluded.lines, total = excluded.total, updated_at = excluded.updated_at, version = excluded.version`,
        ).run(table.id, ctx.user.id, JSON.stringify({ items, draft }), summary, items.length, total, opened, now, version);
      };
      if (ctx.body.version !== undefined && ctx.body.version !== null) {
        if (!row) throw badRequest(`${table.name} was paid or cleared at another till`, 'TABLE_NOT_OPEN', { name: table.name });
        if (num(ctx.body.version) !== num(row.version)) {
          throw badRequest(`${table.name} changed at another till: open it again`, 'TABLE_CHANGED', { name: table.name });
        }
        write(cart.items, cart.draft, row.opened_at, row.version + 1);
      } else if (row) {
        const was = JSON.parse(row.cart);
        write([...(was.items || []), ...cart.items], was.draft || cart.draft, row.opened_at, row.version + 1);
      } else {
        write(cart.items, cart.draft, now, 1);
      }
      return listTables().find((t) => t.id === table.id);
    });
  });

  /** Clear a table without a sale: the order was a mistake, or the guests left. */
  router.delete('/api/tables/:id/order', (ctx) => {
    const table = tableOf(ctx.params.id);
    if (ctx.user.role !== 'admin') throw badRequest('Only an administrator can clear a table without payment', 'TABLE_CLEAR_ADMIN');
    db.prepare(`DELETE FROM table_orders WHERE table_id = ?`).run(table.id);
    return listTables().find((t) => t.id === table.id) || { id: table.id, status: 'free' };
  });
}
