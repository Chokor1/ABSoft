import { db, lastId, transact } from '../db.js';
import { canonicalName, listEntities, rememberAll } from '../entities.js';
import { badRequest, notFound } from '../http.js';
import { money, num, qty, required, str } from '../util.js';

const SELECT_PRODUCT = `
  SELECT p.*, COALESCE(s.stock, 0) AS stock,
         ROUND(COALESCE(s.stock, 0) * p.cost, 2) AS stock_value,
         CASE WHEN p.price > 0 THEN ROUND((p.price - p.cost) / p.price * 100, 1) ELSE 0 END AS margin
  FROM products p
  LEFT JOIN product_stock s ON s.product_id = p.id`;

export const getProduct = (id) => db.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`).get(id);

function readPayload(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = required(body.name, 'Product name', 'product_name');
  if (!partial || body.description !== undefined) out.description = str(body.description);
  if (!partial || body.barcode !== undefined) out.barcode = str(body.barcode) || null;
  // Match the directory's spelling when these are already known names.
  if (!partial || body.category !== undefined) out.category = canonicalName('category', body.category);
  if (!partial || body.unit !== undefined) out.unit = canonicalName('unit', str(body.unit) || 'pcs');
  if (!partial || body.cost !== undefined) out.cost = money(Math.max(0, num(body.cost)));
  if (!partial || body.price !== undefined) out.price = money(Math.max(0, num(body.price)));
  if (!partial || body.min_stock !== undefined) out.min_stock = qty(Math.max(0, num(body.min_stock)));
  if (!partial || body.active !== undefined) out.active = body.active === false ? 0 : 1;
  return out;
}

function assertBarcodeFree(barcode, ignoreId = 0) {
  if (!barcode) return;
  const clash = db.prepare(`SELECT id FROM products WHERE barcode = ? AND id <> ?`).get(barcode, ignoreId);
  if (clash) {
    throw badRequest(`Barcode "${barcode}" is already used by another product`, 'BARCODE_TAKEN', { barcode });
  }
}

export function register(router) {
  router.get('/api/products', (ctx) => {
    const search = str(ctx.query.search);
    const onlyActive = ctx.query.all !== '1';
    const lowStock = ctx.query.low === '1';
    const where = [];
    const args = [];
    if (onlyActive) where.push('p.active = 1');
    if (search) {
      where.push('(p.name LIKE ? OR p.barcode LIKE ? OR p.category LIKE ? OR p.description LIKE ?)');
      const like = `%${search}%`;
      args.push(like, like, like, like);
    }
    if (lowStock) where.push('COALESCE(s.stock, 0) <= p.min_stock');
    const sql = `${SELECT_PRODUCT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name COLLATE NOCASE`;
    return db.prepare(sql).all(...args);
  });

  // Barcode scanner endpoint: exact barcode first, then a forgiving name match.
  router.get('/api/products/lookup', (ctx) => {
    const code = str(ctx.query.code);
    if (!code) throw badRequest('code is required', 'CODE_REQUIRED');
    const exact = db.prepare(`${SELECT_PRODUCT} WHERE p.barcode = ? AND p.active = 1`).get(code);
    if (exact) return exact;
    const fuzzy = db
      .prepare(`${SELECT_PRODUCT} WHERE p.active = 1 AND p.name LIKE ? ORDER BY p.name LIMIT 1`)
      .get(`%${code}%`);
    if (!fuzzy) throw notFound(`No product matches "${code}"`, 'NO_PRODUCT_MATCH', { code });
    return fuzzy;
  });

  router.get('/api/products/:id', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const history = db
      .prepare(
        `SELECT m.*, u.username FROM stock_moves m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`,
      )
      .all(ctx.params.id);
    return { ...product, history };
  });

  router.post('/api/products', (ctx) => {
    const data = readPayload(ctx.body);
    assertBarcodeFree(data.barcode);
    const opening = qty(num(ctx.body.opening_stock));

    return transact(() => {
      const res = db
        .prepare(
          `INSERT INTO products (name, description, barcode, category, unit, cost, price, min_stock, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.name,
          data.description,
          data.barcode,
          data.category,
          data.unit,
          data.cost,
          data.price,
          data.min_stock,
          data.active,
        );
      const id = lastId(res);

      if (opening > 0) {
        db.prepare(
          `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, note, user_id)
           VALUES (?, ?, ?, 'opening', 'Opening balance', ?)`,
        ).run(id, opening, data.cost, ctx.user.id);
      }
      rememberAll([
        ['category', data.category],
        ['unit', data.unit],
      ]);
      return getProduct(id);
    });
  });

  router.put('/api/products/:id', (ctx) => {
    const existing = getProduct(ctx.params.id);
    if (!existing) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const data = readPayload(ctx.body, { partial: true });
    if (data.barcode !== undefined) assertBarcodeFree(data.barcode, existing.id);
    const merged = { ...existing, ...data };
    db.prepare(
      `UPDATE products SET name = ?, description = ?, barcode = ?, category = ?, unit = ?,
                          cost = ?, price = ?, min_stock = ?, active = ?
       WHERE id = ?`,
    ).run(
      merged.name,
      merged.description ?? '',
      merged.barcode,
      merged.category,
      merged.unit,
      merged.cost,
      merged.price,
      merged.min_stock,
      merged.active ? 1 : 0,
      existing.id,
    );
    rememberAll([
      ['category', merged.category],
      ['unit', merged.unit],
    ]);
    return getProduct(existing.id);
  });

  router.delete('/api/products/:id', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const { n } = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = ?)
              + (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?) AS n`,
      )
      .get(product.id, product.id);
    // Products with history are archived instead of deleted so reports stay intact.
    if (n > 0) {
      db.prepare(`UPDATE products SET active = 0 WHERE id = ?`).run(product.id);
      return { archived: true, ...getProduct(product.id) };
    }
    db.prepare(`DELETE FROM products WHERE id = ?`).run(product.id);
    return { deleted: true };
  });

  // Manual stock correction (damage, count difference, returns).
  router.post('/api/products/:id/adjust', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const delta = qty(num(ctx.body.qty));
    if (!delta) throw badRequest('Adjustment quantity cannot be zero', 'ADJUST_ZERO');
    db.prepare(
      `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, note, user_id)
       VALUES (?, ?, ?, 'adjust', ?, ?)`,
    ).run(product.id, delta, product.cost, str(ctx.body.note) || 'Manual adjustment', ctx.user.id);
    return getProduct(product.id);
  });

  // Backed by the directory, so a category created there shows up before any
  // product uses it.
  router.get('/api/categories', () => listEntities('category').map((e) => e.name));
}
