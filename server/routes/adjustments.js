import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, nextDocNo, num, qty, str } from '../util.js';

const LIST_SQL = `
  SELECT a.*, u.username, u.full_name,
         (SELECT COUNT(*) FROM adjustment_items i WHERE i.adjustment_id = a.id) AS line_count,
         (SELECT COALESCE(SUM(CASE WHEN i.qty > 0 THEN i.qty END), 0) FROM adjustment_items i WHERE i.adjustment_id = a.id) AS qty_in,
         (SELECT COALESCE(SUM(CASE WHEN i.qty < 0 THEN -i.qty END), 0) FROM adjustment_items i WHERE i.adjustment_id = a.id) AS qty_out,
         (SELECT ROUND(COALESCE(SUM(i.qty * i.unit_cost), 0), 2) FROM adjustment_items i WHERE i.adjustment_id = a.id) AS value
  FROM adjustments a LEFT JOIN users u ON u.id = a.user_id`;

export function loadAdjustment(id) {
  const head = db.prepare(`${LIST_SQL} WHERE a.id = ?`).get(id);
  if (!head) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name, p.barcode, p.unit, ROUND(i.qty * i.unit_cost, 2) AS value
       FROM adjustment_items i JOIN products p ON p.id = i.product_id
       WHERE i.adjustment_id = ? ORDER BY i.id`,
    )
    .all(id);
  return { ...head, items };
}

/**
 * Record an adjustment document. Each line either says what was counted
 * (`counted`, the physical quantity found) or how much to change by (`qty`,
 * signed). A count is turned into a change against the balance at the moment of
 * saving, so a sale rung up while someone was counting is not lost.
 * Movements are valued at the product's current average cost, which an
 * adjustment does not change.
 */
export function createAdjustment({ date, reason, note, items }, userId) {
  const lines = Array.isArray(items) ? items : [];
  if (!lines.length) throw badRequest('Add at least one product to the adjustment', 'ADJUST_EMPTY');

  return transact(() => {
    const seen = new Set();
    const prepared = lines.map((line) => {
      const product = db
        .prepare(
          `SELECT p.id, p.name, p.cost, COALESCE(s.stock, 0) AS stock FROM products p
           LEFT JOIN product_stock s ON s.product_id = p.id WHERE p.id = ?`,
        )
        .get(num(line.product_id));
      if (!product) throw badRequest('Unknown product on one of the lines', 'UNKNOWN_PRODUCT');
      if (seen.has(product.id)) {
        throw badRequest(`"${product.name}" is on the adjustment twice`, 'ADJUST_DUPLICATE', { name: product.name });
      }
      seen.add(product.id);

      const before = qty(num(product.stock));
      const counted = line.counted !== undefined && line.counted !== null && line.counted !== '';
      if (counted && num(line.counted) < 0) {
        throw badRequest(`Counted quantity for "${product.name}" cannot be negative`, 'COUNT_NEGATIVE', { name: product.name });
      }
      const change = counted ? qty(num(line.counted) - before) : qty(num(line.qty));
      return { product, before, change };
    });

    const moving = prepared.filter((l) => l.change !== 0);
    if (!moving.length) throw badRequest('None of these lines changes the stock', 'ADJUST_ZERO');

    const docDate = isoDate(date);
    const docNo = nextDocNo(db, 'adjustments', 'ADJ');
    const cleanReason = str(reason);
    const res = db
      .prepare(`INSERT INTO adjustments (doc_no, date, reason, note, user_id) VALUES (?, ?, ?, ?, ?)`)
      .run(docNo, docDate, cleanReason, str(note), userId);
    const id = lastId(res);

    const insertItem = db.prepare(
      `INSERT INTO adjustment_items (adjustment_id, product_id, stock_before, qty, unit_cost) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMove = db.prepare(
      `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
       VALUES (?, ?, ?, 'adjust', 'adjustments', ?, ?, ?, ?)`,
    );
    const time = new Date().toISOString().slice(11, 19);
    const label = [docNo, cleanReason, str(note)].filter(Boolean).join(' · ');
    // Only lines that move stock are kept; a count that matched needs no record.
    for (const line of moving) {
      const cost = money(num(line.product.cost));
      insertItem.run(id, line.product.id, line.before, line.change, cost);
      insertMove.run(line.product.id, line.change, cost, id, label, userId, `${docDate} ${time}`);
    }
    return loadAdjustment(id);
  });
}

export function register(router) {
  router.get('/api/adjustments', (ctx) => {
    const where = [];
    const args = [];
    if (str(ctx.query.from)) (where.push('a.date >= ?'), args.push(str(ctx.query.from)));
    if (str(ctx.query.to)) (where.push('a.date <= ?'), args.push(str(ctx.query.to)));
    if (str(ctx.query.search)) {
      where.push(`(a.doc_no LIKE ? OR a.reason LIKE ? OR a.note LIKE ? OR EXISTS (
        SELECT 1 FROM adjustment_items i JOIN products p ON p.id = i.product_id
        WHERE i.adjustment_id = a.id AND (p.name LIKE ? OR p.barcode LIKE ?)))`);
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like, like, like, like);
    }
    const sql = `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY a.date DESC, a.id DESC LIMIT ${Math.min(500, num(ctx.query.limit, 200))}`;
    return db.prepare(sql).all(...args);
  });

  router.get('/api/adjustments/:id', (ctx) => {
    const doc = loadAdjustment(ctx.params.id);
    if (!doc) throw notFound('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
    return doc;
  });

  router.post('/api/adjustments', (ctx) => createAdjustment(ctx.body, ctx.user.id));

  router.delete('/api/adjustments/:id', (ctx) => {
    const doc = loadAdjustment(ctx.params.id);
    if (!doc) throw notFound('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
    return transact(() => {
      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'adjustments' AND ref_id = ?`).run(doc.id);
      db.prepare(`DELETE FROM adjustments WHERE id = ?`).run(doc.id);
      return { deleted: true };
    });
  });
}
