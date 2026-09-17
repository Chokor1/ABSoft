import { db, lastId, transact } from '../db.js';
import { canonicalName, listEntities, rememberAll } from '../entities.js';
import { badRequest, notFound } from '../http.js';
import { dateRange, money, num, pageParams, pageResult, qty, required, shiftDays, str, today } from '../util.js';

// After the browser has shrunk it; a phone photo straight off the camera is refused.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
import { createAdjustment, writeAdjustment } from './adjustments.js';


const SELECT_PRODUCT = `
  SELECT p.*, COALESCE(s.stock, 0) AS stock,
         (SELECT json_group_array(b.barcode) FROM
            (SELECT barcode FROM product_barcodes WHERE product_id = p.id ORDER BY id) b) AS barcodes_json,
         (SELECT updated_at FROM product_images i WHERE i.product_id = p.id) AS image_at,
         ROUND(COALESCE(s.stock, 0) * p.cost, 2) AS stock_value,
         CASE WHEN p.price > 0 THEN ROUND((p.price - p.cost) / p.price * 100, 1) ELSE 0 END AS margin
  FROM products p
  LEFT JOIN product_stock s ON s.product_id = p.id`;

/** A product row as the client sees it: the extra barcodes as a list. */
const shape = (row) => {
  if (!row) return row;
  const { barcodes_json, ...rest } = row;
  return { ...rest, barcodes: JSON.parse(barcodes_json || '[]') };
};

export const getProduct = (id) => shape(db.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`).get(id));

/** The extra barcodes sent with a product: trimmed, without blanks, repeats or the main one. */
function readBarcodes(value, main) {
  const list = Array.isArray(value) ? value : str(value).split(/[\n,|]+/);
  const out = [];
  for (const code of list.map((c) => str(c))) {
    if (code && code !== main && !out.includes(code)) out.push(code);
  }
  if (out.length > 50) throw badRequest('A product can have at most 50 barcodes', 'BARCODES_TOO_MANY');
  return out;
}

/** Which product, other than `ignoreId`, already answers to this code. */
export const barcodeOwner = (code, ignoreId = 0) =>
  db
    .prepare(
      `SELECT id, name FROM products WHERE barcode = ? AND id <> ?
       UNION ALL
       SELECT p.id, p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id
       WHERE b.barcode = ? AND b.product_id <> ?
       LIMIT 1`,
    )
    .get(code, ignoreId, code, ignoreId);

function setBarcodes(productId, codes) {
  db.prepare(`DELETE FROM product_barcodes WHERE product_id = ?`).run(productId);
  const insert = db.prepare(`INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)`);
  for (const code of codes) insert.run(productId, code);
}

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
  const clash = barcodeOwner(barcode, ignoreId);
  if (clash) {
    throw badRequest(`Barcode "${barcode}" is already used by "${clash.name}"`, 'BARCODE_TAKEN', {
      barcode,
      name: clash.name,
    });
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
    // Every word typed must appear somewhere: name, a barcode, category or description.
    // "coffee 500" finds "Ground Coffee 500g" however the words are ordered.
    for (const word of search.split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push(
        `(p.name LIKE ? OR p.barcode LIKE ? OR p.category LIKE ? OR p.description LIKE ?
          OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ?))`,
      );
      const like = `%${word}%`;
      args.push(like, like, like, like, like);
    }
    if (lowStock) where.push('COALESCE(s.stock, 0) <= p.min_stock');
    if (str(ctx.query.category)) (where.push('p.category = ? COLLATE NOCASE'), args.push(str(ctx.query.category)));
    // What is on the shelf: running low, none left, or some in hand.
    const stock = str(ctx.query.stock);
    if (stock === 'low') where.push('COALESCE(s.stock, 0) <= p.min_stock AND COALESCE(s.stock, 0) > 0');
    if (stock === 'out') where.push('COALESCE(s.stock, 0) <= 0');
    if (stock === 'in') where.push('COALESCE(s.stock, 0) > 0');

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // A search puts the closest matches first: the exact barcode or name, then
    // names that start with what was typed, then the rest by name.
    const order = search
      ? `ORDER BY CASE
           WHEN p.barcode = ? OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = ?) THEN 0
           WHEN p.name = ? COLLATE NOCASE THEN 1
           WHEN p.name LIKE ? THEN 2
           ELSE 3 END, p.name COLLATE NOCASE`
      : 'ORDER BY p.name COLLATE NOCASE';
    const orderArgs = search ? [search, search, search, `${search}%`] : [];
    const paging = pageParams(ctx.query, { per: 50 });
    if (paging) {
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN product_stock s ON s.product_id = p.id ${clause}`)
        .get(...args).n;
      const rows = db
        .prepare(`${SELECT_PRODUCT} ${clause} ${order} LIMIT ? OFFSET ?`)
        .all(...args, ...orderArgs, paging.per, paging.offset)
        .map(shape);
      // The figure above the list covers everything that matches, not this page.
      const sums = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(COALESCE(s.stock, 0) * p.cost), 0), 2) AS stock_value
           FROM products p LEFT JOIN product_stock s ON s.product_id = p.id ${clause}`,
        )
        .get(...args);
      return { ...pageResult(rows, total, paging), sums };
    }
    // `limit` keeps the till and the type-ahead pickers light on a large
    // catalogue; the reports omit it and get everything.
    const limit = num(ctx.query.limit, 0);
    // `offset` fetches the next batch, for the till's cards as you scroll down.
    const offset = Math.max(0, Math.round(num(ctx.query.offset, 0)));
    const limitSql = limit > 0 ? `LIMIT ${Math.min(200, limit)}${offset ? ` OFFSET ${offset}` : ''}` : '';
    // The till opens on what sells: most sold over the last 30 days first.
    if (ctx.query.sort === 'popular') {
      return db
        .prepare(
          `${SELECT_PRODUCT}
           LEFT JOIN (SELECT i.product_id, SUM(i.qty) AS sold FROM sale_items i JOIN sales sx ON sx.id = i.sale_id
                      WHERE sx.date >= ? GROUP BY i.product_id) pop ON pop.product_id = p.id
           ${clause} ORDER BY COALESCE(pop.sold, 0) DESC, p.name COLLATE NOCASE ${limitSql}`,
        )
        .all(shiftDays(today(), -29), ...args)
        .map(shape);
    }
    return db
      .prepare(`${SELECT_PRODUCT} ${clause} ${order} ${limitSql}`)
      .all(...args, ...orderArgs)
      .map(shape);
  });

  // Barcode scanner endpoint.
  router.get('/api/products/lookup', (ctx) => {
    const code = str(ctx.query.code);
    if (!code) throw badRequest('code is required', 'CODE_REQUIRED');
    // Exact matches only. This is the scanner path: a partial match here would
    // silently ring up the wrong item. Typed searches go through /api/products,
    // which shows the candidates and lets the cashier choose.
    // Any of a product's barcodes will do.
    const found = shape(
      db
        .prepare(
          `${SELECT_PRODUCT} WHERE p.active = 1 AND (p.barcode = ?
             OR p.id IN (SELECT product_id FROM product_barcodes WHERE barcode = ?))`,
        )
        .get(code, code) || db.prepare(`${SELECT_PRODUCT} WHERE p.name = ? COLLATE NOCASE AND p.active = 1`).get(code),
    );
    if (!found) throw notFound(`No product matches "${code}"`, 'NO_PRODUCT_MATCH', { code });
    return found;
  });

  router.get('/api/products/:id', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const history = db
      .prepare(
        `SELECT m.*, u.username FROM stock_moves m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 500`,
      )
      .all(ctx.params.id);
    const recent = db
      .prepare(
        `SELECT COALESCE(SUM(i.qty), 0) AS qty, COALESCE(SUM(i.total), 0) AS revenue
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
         WHERE i.product_id = ? AND s.date >= ?`,
      )
      .get(product.id, shiftDays(today(), -29));
    return { ...product, sold_30: qty(recent.qty), revenue_30: money(recent.revenue), history };
  });

  /** How a product sold over a period: totals, a day-by-day series and every line. */
  router.get('/api/products/:id/sales', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const { from, to } = dateRange(ctx.query);
    const lines = db
      .prepare(
        `SELECT i.id, i.sale_id, s.doc_no, s.date, s.customer, i.qty, i.unit_price, i.discount, i.total,
                ROUND(i.qty * i.unit_cost, 2) AS cost, ROUND(i.total - i.qty * i.unit_cost, 2) AS profit
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
         WHERE i.product_id = ? AND s.date BETWEEN ? AND ?
         ORDER BY s.date DESC, i.id DESC`,
      )
      .all(product.id, from, to);
    const sum = (key) => money(lines.reduce((a, l) => a + Number(l[key]), 0));
    const byDay = db
      .prepare(
        `SELECT s.date AS date, ROUND(SUM(i.total), 2) AS revenue,
                ROUND(SUM(i.total - i.qty * i.unit_cost), 2) AS profit, SUM(i.qty) AS qty
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
         WHERE i.product_id = ? AND s.date BETWEEN ? AND ?
         GROUP BY s.date ORDER BY s.date`,
      )
      .all(product.id, from, to);
    const revenue = sum('total');
    const profit = sum('profit');
    return {
      from,
      to,
      summary: {
        qty: qty(lines.reduce((a, l) => a + l.qty, 0)),
        revenue,
        cost: sum('cost'),
        profit,
        margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        invoices: new Set(lines.map((l) => l.sale_id)).size,
      },
      byDay,
      lines,
    };
  });

  /** Every purchase line for a product, newest first. */
  router.get('/api/products/:id/purchases', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    return db
      .prepare(
        `SELECT i.id, i.purchase_id, pu.doc_no, pu.date, pu.supplier, i.qty, i.unit_cost, i.total
         FROM purchase_items i JOIN purchases pu ON pu.id = i.purchase_id
         WHERE i.product_id = ? ORDER BY pu.date DESC, i.id DESC LIMIT 500`,
      )
      .all(product.id);
  });

  /* The product picture. Served as a file with a long cache: its URL carries the
     upload time, so a new picture is a new URL. */
  router.get('/api/products/:id/image', (ctx) => {
    const row = db.prepare(`SELECT mime, data FROM product_images WHERE product_id = ?`).get(ctx.params.id);
    if (!row) throw notFound('No image for this product', 'IMAGE_NOT_FOUND');
    const body = Buffer.from(row.data);
    ctx.res.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      // A picture is only ever a picture: nothing in it may run, even opened on its own.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(body);
  });

  router.put('/api/products/:id/image', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(str(ctx.body.data));
    if (!match) throw badRequest('Use a JPEG, PNG or WebP picture', 'IMAGE_TYPE');
    const data = Buffer.from(match[2], 'base64');
    if (data.length > MAX_IMAGE_BYTES) throw badRequest('That picture is too large', 'IMAGE_TOO_LARGE');
    db.prepare(
      `INSERT INTO product_images (product_id, mime, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
    ).run(product.id, match[1], data);
    return getProduct(product.id);
  });

  router.delete('/api/products/:id/image', (ctx) => {
    const product = getProduct(ctx.params.id);
    if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    db.prepare(`DELETE FROM product_images WHERE product_id = ?`).run(product.id);
    return getProduct(product.id);
  });

  router.post('/api/products', (ctx) => {
    const data = readPayload(ctx.body);
    const extra = readBarcodes(ctx.body.barcodes, data.barcode);
    for (const code of [data.barcode, ...extra]) assertBarcodeFree(code);
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
      setBarcodes(id, extra);

      // Stock already on hand is recorded as an opening stock adjustment.
      if (opening > 0) {
        writeAdjustment(
          { type: 'opening', note: data.name, items: [{ product_id: id, qty: opening, unit_cost: data.cost }] },
          ctx.user.id,
        );
      }
      rememberAll([
        ['category', data.category],
        ['unit', data.unit],
      ]);
      return getProduct(id);
    });
  });

  /**
   * Import products from a spreadsheet. The browser reads the file and sends the
   * rows; with dry_run it only checks them, for the preview. Rows whose barcode
   * already exists are skipped, never overwritten. Every opening quantity in the
   * file goes into one opening stock adjustment, not one per product.
   */
  router.post('/api/products/import', (ctx) => {
    const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : [];
    if (!rows.length) throw badRequest('The file has no rows', 'IMPORT_EMPTY');
    if (rows.length > 5000) throw badRequest('Import at most 5000 rows at a time', 'IMPORT_TOO_MANY');

    const inFile = new Map();
    const checked = rows.map((raw, index) => {
      const row = { line: index + 2, name: str(raw.name), barcode: str(raw.barcode) }; // line 1 is the header
      const fail = (code, field) => ({ ...row, status: 'error', code, field });
      if (!row.name) return fail('IMPORT_NAME', 'name');
      const numbers = {};
      for (const field of ['cost', 'price', 'min_stock', 'opening_stock']) {
        const text = str(raw[field]).replace(',', '.');
        if (text === '') {
          numbers[field] = 0;
          continue;
        }
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0) return fail('IMPORT_NUMBER', field);
        numbers[field] = n;
      }
      if (row.barcode) {
        if (inFile.has(row.barcode)) return { ...fail('IMPORT_DUP_FILE', 'barcode'), other: inFile.get(row.barcode) };
        inFile.set(row.barcode, row.line);
        if (barcodeOwner(row.barcode)) {
          return { ...row, status: 'skip', code: 'IMPORT_EXISTS', field: 'barcode' };
        }
      }
      return {
        ...row,
        status: 'ok',
        data: {
          name: row.name,
          description: str(raw.description),
          barcode: row.barcode || null,
          category: canonicalName('category', raw.category),
          unit: canonicalName('unit', str(raw.unit) || 'pcs'),
          cost: money(numbers.cost),
          price: money(numbers.price),
          min_stock: qty(numbers.min_stock),
          opening: qty(numbers.opening_stock),
        },
      };
    });

    const ok = checked.filter((r) => r.status === 'ok');
    const summary = {
      ok: ok.length,
      skip: checked.filter((r) => r.status === 'skip').length,
      error: checked.filter((r) => r.status === 'error').length,
      opening_lines: ok.filter((r) => r.data.opening > 0).length,
      opening_qty: qty(ok.reduce((s, r) => s + r.data.opening, 0)),
    };
    const report = checked.map(({ data, ...r }) => ({ ...r, opening: data?.opening ?? 0 }));
    if (ctx.body.dry_run || !ok.length) return { dry_run: !!ctx.body.dry_run, summary, rows: report, opening: null };

    return transact(() => {
      const insert = db.prepare(
        `INSERT INTO products (name, description, barcode, category, unit, cost, price, min_stock, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      const openingLines = [];
      for (const r of ok) {
        const d = r.data;
        const id = lastId(insert.run(d.name, d.description, d.barcode, d.category, d.unit, d.cost, d.price, d.min_stock));
        rememberAll([
          ['category', d.category],
          ['unit', d.unit],
        ]);
        if (d.opening > 0) openingLines.push({ product_id: id, qty: d.opening, unit_cost: d.cost });
      }
      // One document for the whole file.
      let opening = null;
      if (openingLines.length) {
        const openingId = writeAdjustment(
          { type: 'opening', date: ctx.body.date, note: str(ctx.body.note) || 'Import', items: openingLines },
          ctx.user.id,
        );
        opening = db.prepare(`SELECT id, doc_no FROM adjustments WHERE id = ?`).get(openingId);
      }
      return { dry_run: false, summary, rows: report, opening };
    });
  });

  router.put('/api/products/:id', (ctx) => {
    const existing = getProduct(ctx.params.id);
    if (!existing) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    const data = readPayload(ctx.body, { partial: true });
    if (data.barcode !== undefined) assertBarcodeFree(data.barcode, existing.id);
    const merged = { ...existing, ...data };
    // Sent: replace the extra barcodes. Left out: keep them, minus a new main one.
    const extra = readBarcodes(ctx.body.barcodes !== undefined ? ctx.body.barcodes : existing.barcodes, merged.barcode);
    for (const code of extra) assertBarcodeFree(code, existing.id);
    transact(() => {
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
      setBarcodes(existing.id, extra);
    });
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
              + (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?)
              + (SELECT COUNT(*) FROM adjustment_items WHERE product_id = ?) AS n`,
      )
      .get(product.id, product.id, product.id);
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
    // A one-line adjustment document, so it is numbered and listed like the rest.
    const doc = createAdjustment(
      { reason: str(ctx.body.note) || 'Manual adjustment', items: [{ product_id: product.id, qty: delta }] },
      ctx.user.id,
    );
    return { ...getProduct(product.id), adjustment: { id: doc.id, doc_no: doc.doc_no } };
  });

  // Backed by the directory, so a category created there shows up before any
  // product uses it.
  router.get('/api/categories', () => listEntities('category').map((e) => e.name));
}
