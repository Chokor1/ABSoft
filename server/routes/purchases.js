import { applyAverageCost } from '../costing.js';
import { db, lastId, transact } from '../db.js';
import { canonicalName, rememberEntity } from '../entities.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, nextDocNo, num, pageParams, pageResult, qty, str } from '../util.js';

const LIST_SQL = `
  SELECT pu.*, u.username,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS line_count,
         (SELECT COALESCE(SUM(i.qty), 0) FROM purchase_items i WHERE i.purchase_id = pu.id) AS total_qty,
         (SELECT COUNT(*) FROM purchase_log l WHERE l.purchase_id = pu.id AND l.action = 'edited') AS edit_count
  FROM purchases pu LEFT JOIN users u ON u.id = pu.user_id`;

export function loadPurchase(id) {
  const head = db.prepare(`${LIST_SQL} WHERE pu.id = ?`).get(id);
  if (!head) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name, p.barcode, p.unit FROM purchase_items i
       JOIN products p ON p.id = i.product_id WHERE i.purchase_id = ? ORDER BY i.id`,
    )
    .all(id);
  const log = db
    .prepare(
      `SELECT l.id, l.action, l.changes, l.reason, l.created_at, u.username, u.full_name
       FROM purchase_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.purchase_id = ? ORDER BY l.created_at DESC, l.id DESC`,
    )
    .all(id)
    .map((row) => ({ ...row, changes: parseJson(row.changes) }));
  return { ...head, items, log };
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

function writeLog(purchase, action, changes, reason, userId) {
  db.prepare(
    `INSERT INTO purchase_log (purchase_id, doc_no, action, changes, reason, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(purchase.id, purchase.doc_no, action, JSON.stringify(changes), str(reason), userId);
}

/**
 * The reverse of applyAverageCost, used when a purchase is edited: take the
 * old line's quantity and cost back out of the average. `stock` is the balance
 * that still includes the line. Once goods have been sold the split is an
 * estimate, and when nothing else is left on hand the current cost is kept.
 */
function removeFromAverageCost(productId, stock, outQty, outCost) {
  const { cost } = db.prepare(`SELECT cost FROM products WHERE id = ?`).get(productId);
  const rest = stock - outQty;
  if (rest <= 0) return;
  const previous = money(Math.max(0, (stock * num(cost) - outQty * outCost) / rest));
  db.prepare(`UPDATE products SET cost = ? WHERE id = ?`).run(previous, productId);
}

/** Validate the lines of a create or edit request. */
function prepareLines(body) {
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw badRequest('Add at least one product to the purchase', 'PURCHASE_EMPTY');
  return lines.map((line) => {
    const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(num(line.product_id));
    if (!product) throw badRequest('Unknown product on one of the lines', 'UNKNOWN_PRODUCT');
    const quantity = qty(num(line.qty));
    const unitCost = money(Math.max(0, num(line.unit_cost)));
    if (quantity <= 0) throw badRequest(`Quantity for "${product.name}" must be greater than zero`, 'QTY_POSITIVE', { name: product.name });
    return { product, qty: quantity, unit_cost: unitCost, total: money(quantity * unitCost) };
  });
}

/** Insert the lines and their stock movements, re-averaging cost as each lands. */
function receiveLines(purchaseId, docNo, supplier, date, time, lines, userId) {
  const insertItem = db.prepare(
    `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, total) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMove = db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
     VALUES (?, ?, ?, 'purchase', 'purchases', ?, ?, ?, ?)`,
  );
  for (const line of lines) {
    insertItem.run(purchaseId, line.product.id, line.qty, line.unit_cost, line.total);
    // Re-average before the movement lands, so the calculation sees the pre-purchase balance.
    applyAverageCost(line.product.id, line.qty, line.unit_cost);
    insertMove.run(
      line.product.id,
      line.qty,
      line.unit_cost,
      purchaseId,
      `${docNo}${supplier ? ' · ' + supplier : ''}`,
      userId,
      `${date} ${time}`,
    );
  }
}

/** Lines summed per product, so reordering or splitting a line is not a change. */
function byProduct(lines) {
  const map = new Map();
  for (const l of lines) {
    const id = l.product_id ?? l.product.id;
    const entry = map.get(id) || { product_id: id, name: l.name ?? l.product.name, qty: 0, value: 0 };
    entry.qty = qty(entry.qty + l.qty);
    entry.value += l.qty * l.unit_cost;
    map.set(id, entry);
  }
  for (const e of map.values()) e.unit_cost = e.qty ? money(e.value / e.qty) : 0;
  return map;
}

/** What an edit changed, in a shape the client can describe line by line. */
function diffPurchase(before, after) {
  const fields = [];
  for (const field of ['supplier', 'date', 'note']) {
    if (String(before[field] ?? '') !== String(after[field] ?? '')) {
      fields.push({ field, from: before[field] ?? '', to: after[field] ?? '' });
    }
  }

  const lines = [];
  const oldLines = byProduct(before.items);
  const newLines = byProduct(after.items);
  for (const [id, o] of oldLines) {
    const n = newLines.get(id);
    if (!n) lines.push({ type: 'removed', name: o.name, from: { qty: o.qty, unit_cost: o.unit_cost } });
    else if (o.qty !== n.qty || o.unit_cost !== n.unit_cost) {
      lines.push({
        type: 'changed',
        name: o.name,
        from: { qty: o.qty, unit_cost: o.unit_cost },
        to: { qty: n.qty, unit_cost: n.unit_cost },
      });
    }
  }
  for (const [id, n] of newLines) {
    if (!oldLines.has(id)) lines.push({ type: 'added', name: n.name, to: { qty: n.qty, unit_cost: n.unit_cost } });
  }

  const total = before.total !== after.total ? { from: before.total, to: after.total } : null;
  return { fields, lines, total };
}

const nowTime = () => new Date().toISOString().slice(11, 19);

export function register(router) {
  router.get('/api/purchases', (ctx) => {
    const where = [];
    const args = [];
    if (str(ctx.query.from)) (where.push('pu.date >= ?'), args.push(str(ctx.query.from)));
    if (str(ctx.query.to)) (where.push('pu.date <= ?'), args.push(str(ctx.query.to)));
    if (str(ctx.query.search)) {
      where.push('(pu.doc_no LIKE ? OR pu.supplier LIKE ?)');
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like);
    }
    if (str(ctx.query.supplier)) (where.push('pu.supplier = ? COLLATE NOCASE'), args.push(str(ctx.query.supplier)));
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const paging = pageParams(ctx.query, { per: 50 });
    if (paging) {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM purchases pu ${clause}`).get(...args).n;
      const rows = db
        .prepare(`${LIST_SQL} ${clause} ORDER BY pu.date DESC, pu.id DESC LIMIT ? OFFSET ?`)
        .all(...args, paging.per, paging.offset);
      const sums = db
        .prepare(`SELECT ROUND(COALESCE(SUM(pu.total), 0), 2) AS total FROM purchases pu ${clause}`)
        .get(...args);
      return { ...pageResult(rows, total, paging), sums };
    }
    return db
      .prepare(`${LIST_SQL} ${clause} ORDER BY pu.date DESC, pu.id DESC LIMIT ${Math.min(500, num(ctx.query.limit, 200))}`)
      .all(...args);
  });

  router.get('/api/purchases/:id', (ctx) => {
    const purchase = loadPurchase(ctx.params.id);
    if (!purchase) throw notFound('Purchase not found', 'PURCHASE_NOT_FOUND');
    return purchase;
  });

  router.post('/api/purchases', (ctx) => {
    const prepared = prepareLines(ctx.body);
    const date = isoDate(ctx.body.date);
    const total = money(prepared.reduce((sum, l) => sum + l.total, 0));
    const supplier = canonicalName('supplier', ctx.body.supplier);

    return transact(() => {
      const docNo = str(ctx.body.doc_no) || nextDocNo(db, 'purchases', 'PO');
      const res = db
        .prepare(
          `INSERT INTO purchases (doc_no, supplier, date, total, note, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(docNo, supplier, date, total, str(ctx.body.note), ctx.user.id);
      const purchaseId = lastId(res);
      receiveLines(purchaseId, docNo, supplier, date, nowTime(), prepared, ctx.user.id);
      writeLog({ id: purchaseId, doc_no: docNo }, 'created', { total, lines: prepared.length }, '', ctx.user.id);
      rememberEntity('supplier', supplier);
      return loadPurchase(purchaseId);
    });
  });

  /**
   * Edit a saved purchase: replace its header and lines. The old lines come back
   * out of stock and out of the average cost, the new ones go in, and what
   * changed is written to the purchase log. Sales already made keep the cost
   * they were sold at, so past profit is not rewritten.
   */
  router.put('/api/purchases/:id', (ctx) => {
    const before = loadPurchase(ctx.params.id);
    if (!before) throw notFound('Purchase not found', 'PURCHASE_NOT_FOUND');
    if (ctx.user.role !== 'admin') throw badRequest('Only an administrator can edit a purchase', 'PURCHASE_EDIT_ADMIN_ONLY');

    const prepared = prepareLines(ctx.body);
    const after = {
      supplier: ctx.body.supplier === undefined ? before.supplier : canonicalName('supplier', ctx.body.supplier),
      date: ctx.body.date === undefined ? before.date : isoDate(ctx.body.date),
      note: ctx.body.note === undefined ? before.note : str(ctx.body.note),
      total: money(prepared.reduce((sum, l) => sum + l.total, 0)),
      items: prepared,
    };
    const changes = diffPurchase(before, after);
    if (!changes.fields.length && !changes.lines.length) return before;

    return transact(() => {
      db.prepare(
        `UPDATE purchases SET supplier = ?, date = ?, note = ?, total = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(after.supplier, after.date, after.note, after.total, before.id);

      if (!changes.lines.length) {
        // Only the header changed: relabel the movements, leave stock and cost alone.
        db.prepare(
          `UPDATE stock_moves SET note = ?, created_at = ? || substr(created_at, 11)
           WHERE ref_table = 'purchases' AND ref_id = ?`,
        ).run(`${before.doc_no}${after.supplier ? ' · ' + after.supplier : ''}`, after.date, before.id);
        writeLog(before, 'edited', changes, ctx.body.reason, ctx.user.id);
        rememberEntity('supplier', after.supplier);
        return loadPurchase(before.id);
      }

      // Take the old lines back out of the average, newest first, while their
      // stock is still on the books.
      const stock = new Map();
      const stockOf = (id) =>
        stock.has(id)
          ? stock.get(id)
          : num(db.prepare(`SELECT stock FROM product_stock WHERE product_id = ?`).get(id)?.stock);
      for (const line of [...before.items].reverse()) {
        const onHand = stockOf(line.product_id);
        removeFromAverageCost(line.product_id, onHand, line.qty, line.unit_cost);
        stock.set(line.product_id, onHand - line.qty);
      }

      // The original movements carry the time of day the goods were received.
      const firstMove = db
        .prepare(`SELECT created_at FROM stock_moves WHERE ref_table = 'purchases' AND ref_id = ? ORDER BY id LIMIT 1`)
        .get(before.id);
      const time = firstMove?.created_at?.slice(11, 19) || nowTime();

      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'purchases' AND ref_id = ?`).run(before.id);
      db.prepare(`DELETE FROM purchase_items WHERE purchase_id = ?`).run(before.id);

      receiveLines(before.id, before.doc_no, after.supplier, after.date, time, prepared, ctx.user.id);
      writeLog(before, 'edited', changes, ctx.body.reason, ctx.user.id);
      rememberEntity('supplier', after.supplier);
      return loadPurchase(before.id);
    });
  });

  router.delete('/api/purchases/:id', (ctx) => {
    const purchase = loadPurchase(ctx.params.id);
    if (!purchase) throw notFound('Purchase not found', 'PURCHASE_NOT_FOUND');
    if (ctx.user.role !== 'admin') throw badRequest('Only an administrator can delete a purchase', 'PURCHASE_ADMIN_ONLY');
    return transact(() => {
      writeLog(
        purchase,
        'deleted',
        {
          supplier: purchase.supplier,
          date: purchase.date,
          total: purchase.total,
          items: purchase.items.map((i) => ({ name: i.name, qty: i.qty, unit_cost: i.unit_cost })),
        },
        '',
        ctx.user.id,
      );
      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'purchases' AND ref_id = ?`).run(purchase.id);
      db.prepare(`DELETE FROM purchases WHERE id = ?`).run(purchase.id);
      return { deleted: true };
    });
  });
}
