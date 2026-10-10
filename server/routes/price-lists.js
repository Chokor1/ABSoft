import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, num, required, str } from '../util.js';

/**
 * Price lists: the same product sold (or bought) at more than one price.
 *
 * Every shop has one list from the start — the default — and that list is not a
 * table of its own: its selling price is the product's own `price` and its
 * buying price the product's own `cost`. Nothing about an existing shop changes
 * until a second list is made.
 *
 * Another list (جملة, a supplier's agreed prices…) holds a price only for the
 * products it actually prices; anything it does not name falls back to the
 * product's own price. A list says whether it is for selling, for buying, or
 * for both, so the Sell form and the Buy form each offer only what fits.
 */

export const USES = ['sell', 'buy', 'both'];

export const defaultList = () => db.prepare(`SELECT * FROM price_lists WHERE is_default = 1`).get() || null;

export const getList = (id) => db.prepare(`SELECT * FROM price_lists WHERE id = ?`).get(id) || null;

/** The id a document should keep: one that exists, and never the default's. */
export const priceListId = (value) => {
  const list = value ? getList(Number(value)) : null;
  return list && !list.is_default ? list.id : null;
};

/** Lists a document can choose from: active, and for selling or buying as asked. */
export const listsFor = (use) =>
  db
    .prepare(
      `SELECT * FROM price_lists
       WHERE active = 1 AND (is_default = 1 OR use_for = 'both' OR use_for = ?)
       ORDER BY is_default DESC, name`,
    )
    .all(use === 'buy' ? 'buy' : 'sell');

/**
 * What one product costs on a list. The default list is the product's own
 * price, and so is any product the list does not name.
 */
export function priceOn(listId, productId, { use = 'sell' } = {}) {
  const product = db.prepare(`SELECT price, cost FROM products WHERE id = ?`).get(productId);
  if (!product) return null;
  const own = use === 'buy' ? num(product.cost) : num(product.price);
  const list = listId ? getList(listId) : null;
  if (!list || list.is_default) return own;
  const row = db.prepare(`SELECT price FROM product_prices WHERE product_id = ? AND list_id = ?`).get(productId, list.id);
  return row ? num(row.price) : own;
}

/** Every price a product carries, by list id; the default list is left out. */
export const pricesOf = (productId) =>
  db.prepare(`SELECT list_id, price FROM product_prices WHERE product_id = ? ORDER BY list_id`).all(productId);

/** Keep what a price was and what it became, so a shop can see it later. */
export function recordPriceChange(productId, listId, field, oldPrice, newPrice, userId) {
  if (money(num(oldPrice)) === money(num(newPrice))) return;
  db.prepare(
    `INSERT INTO price_changes (product_id, list_id, field, old_price, new_price, changed_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(productId, listId, field, oldPrice === null ? null : money(num(oldPrice)), newPrice === null ? null : money(num(newPrice)), localNow(), userId ?? null);
}

/** The shop's own clock, so a change made at 09:00 reads 09:00. */
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/** Every price this product has carried, newest first. */
export const priceHistory = (productId) =>
  db
    .prepare(
      `SELECT c.*, l.name AS list_name, u.username
       FROM price_changes c
       LEFT JOIN price_lists l ON l.id = c.list_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.product_id = ? ORDER BY c.id DESC LIMIT 200`,
    )
    .all(productId);

/**
 * Write a product's prices. `prices` is { [listId]: price }; an empty value, or
 * anything at or below zero, removes that list's price so the product falls
 * back to its own. The default list is never stored here, and every change is
 * written to the product's price history.
 */
export function setPrices(productId, prices, userId = null) {
  if (!prices || typeof prices !== 'object') return;
  const before = new Map(pricesOf(productId).map((r) => [r.list_id, num(r.price)]));
  const del = db.prepare(`DELETE FROM product_prices WHERE product_id = ? AND list_id = ?`);
  const put = db.prepare(
    `INSERT INTO product_prices (product_id, list_id, price) VALUES (?, ?, ?)
     ON CONFLICT (product_id, list_id) DO UPDATE SET price = excluded.price`,
  );
  for (const [key, value] of Object.entries(prices)) {
    const list = getList(Number(key));
    if (!list || list.is_default) continue;
    const price = money(num(value));
    const had = before.has(list.id) ? before.get(list.id) : null;
    if (value === '' || value === null || value === undefined || price <= 0) {
      if (had === null) continue;
      del.run(productId, list.id);
      recordPriceChange(productId, list.id, 'price', had, null, userId);
    } else {
      if (had === price) continue;
      put.run(productId, list.id, price);
      recordPriceChange(productId, list.id, 'price', had, price, userId);
    }
  }
}

/** The list a customer or supplier is normally served at, if it still exists. */
export function partyList(name, kind) {
  const value = str(name);
  if (!value) return null;
  const row = db
    .prepare(
      `SELECT l.* FROM entities e JOIN price_lists l ON l.id = e.price_list_id
       WHERE e.kind = ? AND e.name = ? AND l.active = 1`,
    )
    .get(kind, value);
  return row || null;
}

const shape = (row) =>
  row && {
    ...row,
    is_default: !!row.is_default,
    active: !!row.active,
    priced: db.prepare(`SELECT COUNT(*) AS n FROM product_prices WHERE list_id = ?`).get(row.id).n,
  };

export function register(router) {
  /** Every list, the default first. `use=sell|buy` narrows it to what fits a document. */
  router.get('/api/price-lists', (ctx) => {
    const use = str(ctx.query.use);
    const rows = use ? listsFor(use) : db.prepare(`SELECT * FROM price_lists ORDER BY is_default DESC, name`).all();
    return rows.map(shape);
  });

  router.post('/api/price-lists', (ctx) => {
    const name = required(ctx.body.name, 'name');
    const use = USES.includes(str(ctx.body.use_for)) ? str(ctx.body.use_for) : 'sell';
    if (db.prepare(`SELECT 1 FROM price_lists WHERE name = ?`).get(name)) {
      throw badRequest(`A price list called "${name}" already exists`, 'LIST_EXISTS', { name });
    }
    const res = db
      .prepare(`INSERT INTO price_lists (name, use_for, note, active) VALUES (?, ?, ?, 1)`)
      .run(name, use, str(ctx.body.note));
    return shape(getList(lastId(res)));
  });

  router.put('/api/price-lists/:id', (ctx) => {
    const list = getList(ctx.params.id);
    if (!list) throw notFound('Price list not found', 'LIST_NOT_FOUND');
    const name = required(ctx.body.name ?? list.name, 'name');
    const clash = db.prepare(`SELECT 1 FROM price_lists WHERE name = ? AND id <> ?`).get(name, list.id);
    if (clash) throw badRequest(`A price list called "${name}" already exists`, 'LIST_EXISTS', { name });
    // The default list is where every product's own price lives: it stays, and it
    // serves both selling and buying.
    const use = list.is_default ? 'both' : USES.includes(str(ctx.body.use_for)) ? str(ctx.body.use_for) : list.use_for;
    const active = list.is_default ? 1 : ctx.body.active === undefined ? list.active : ctx.body.active ? 1 : 0;
    db.prepare(`UPDATE price_lists SET name = ?, use_for = ?, note = ?, active = ? WHERE id = ?`).run(
      name,
      use,
      ctx.body.note === undefined ? list.note : str(ctx.body.note),
      active,
      list.id,
    );
    return shape(getList(list.id));
  });

  router.delete('/api/price-lists/:id', (ctx) => {
    const list = getList(ctx.params.id);
    if (!list) throw notFound('Price list not found', 'LIST_NOT_FOUND');
    if (list.is_default) throw badRequest('The default price list cannot be removed', 'LIST_DEFAULT');
    return transact(() => {
      db.prepare(`DELETE FROM product_prices WHERE list_id = ?`).run(list.id);
      db.prepare(`UPDATE entities SET price_list_id = NULL WHERE price_list_id = ?`).run(list.id);
      db.prepare(`DELETE FROM price_lists WHERE id = ?`).run(list.id);
      return { ok: true };
    });
  });

  /**
   * What one product costs on every list the shop keeps, and every change its
   * prices have been through. This is the product's Pricing tab.
   */
  router.get('/api/products/:id/prices', (ctx) => {
    const product = db.prepare(`SELECT id, price, cost FROM products WHERE id = ?`).get(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const own = new Map(pricesOf(product.id).map((r) => [r.list_id, num(r.price)]));
    const rows = db
      .prepare(`SELECT * FROM price_lists ORDER BY is_default DESC, name`)
      .all()
      .map((l) => ({
        id: l.id,
        name: l.name,
        use_for: l.use_for,
        is_default: !!l.is_default,
        active: !!l.active,
        // The main list is the product's own price; another list only where it says so.
        price: l.is_default ? num(product.price) : own.has(l.id) ? own.get(l.id) : null,
        falls_back: l.is_default ? false : !own.has(l.id),
      }));
    return { cost: num(product.cost), rows, history: priceHistory(product.id) };
  });

  /** Every product with its price on this list, for filling a list in one place. */
  router.get('/api/price-lists/:id/products', (ctx) => {
    const list = getList(ctx.params.id);
    if (!list) throw notFound('Price list not found', 'LIST_NOT_FOUND');
    const search = str(ctx.query.search);
    const like = `%${search}%`;
    return db
      .prepare(
        `SELECT p.id, p.name, p.barcode, p.unit, p.price, p.cost, pp.price AS list_price
         FROM products p
         LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.list_id = ?
         WHERE p.active = 1 ${search ? `AND (p.name LIKE ? OR p.barcode LIKE ?)` : ''}
         ORDER BY p.name LIMIT 500`,
      )
      .all(...(search ? [list.id, like, like] : [list.id]));
  });
}
