import { applyAverageCost } from '../costing.js';
import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, nextDocNo, num, pageParams, pageResult, qty, str } from '../util.js';

/**
 * Opening stock documents: what was already on the shelf when the shop started
 * using ABSoft (or when a product was added), with what it cost. One document
 * can open many products at once — the import tool writes a single one for a
 * whole file.
 */

const LIST_SQL = `
  SELECT o.*, u.username, u.full_name,
         (SELECT COUNT(*) FROM opening_items i WHERE i.opening_id = o.id) AS line_count,
         (SELECT COALESCE(SUM(i.qty), 0) FROM opening_items i WHERE i.opening_id = o.id) AS total_qty,
         (SELECT ROUND(COALESCE(SUM(i.qty * i.unit_cost), 0), 2) FROM opening_items i WHERE i.opening_id = o.id) AS value
  FROM openings o LEFT JOIN users u ON u.id = o.user_id`;

export function loadOpening(id) {
  const head = db.prepare(`${LIST_SQL} WHERE o.id = ?`).get(id);
  if (!head) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name, p.barcode, p.unit, ROUND(i.qty * i.unit_cost, 2) AS value
       FROM opening_items i JOIN products p ON p.id = i.product_id
       WHERE i.opening_id = ? ORDER BY i.id`,
    )
    .all(id);
  return { ...head, items };
}

/**
 * Write an opening stock document. Runs inside the caller's transaction (a new
 * product, an import); use createOpening to run it on its own.
 * Each line is { product_id, qty, unit_cost? }; the cost defaults to the
 * product's own.
 */
export function writeOpening({ date, note, items }, userId) {
  const lines = (Array.isArray(items) ? items : []).filter((l) => qty(num(l.qty)) !== 0);
  if (!lines.length) throw badRequest('Add at least one product with a quantity', 'OPENING_EMPTY');

  const seen = new Set();
  const prepared = lines.map((line) => {
    const product = db.prepare(`SELECT id, name, cost FROM products WHERE id = ?`).get(num(line.product_id));
    if (!product) throw badRequest('Unknown product on one of the lines', 'UNKNOWN_PRODUCT');
    if (seen.has(product.id)) {
      throw badRequest(`"${product.name}" is on the document twice`, 'OPENING_DUPLICATE', { name: product.name });
    }
    seen.add(product.id);
    const quantity = qty(num(line.qty));
    if (quantity < 0) throw badRequest(`Quantity for "${product.name}" cannot be negative`, 'QTY_POSITIVE', { name: product.name });
    const cost = line.unit_cost === undefined || line.unit_cost === '' || line.unit_cost === null
      ? money(num(product.cost))
      : money(Math.max(0, num(line.unit_cost)));
    return { product, qty: quantity, unit_cost: cost };
  });

  const docDate = isoDate(date);
  const docNo = nextDocNo(db, 'openings', 'OPN');
  const id = lastId(
    db.prepare(`INSERT INTO openings (doc_no, date, note, user_id) VALUES (?, ?, ?, ?)`).run(docNo, docDate, str(note), userId),
  );
  const insertItem = db.prepare(`INSERT INTO opening_items (opening_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?)`);
  const insertMove = db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
     VALUES (?, ?, ?, 'opening', 'openings', ?, ?, ?, ?)`,
  );
  const time = new Date().toISOString().slice(11, 19);
  const label = [docNo, str(note)].filter(Boolean).join(' · ');
  for (const line of prepared) {
    insertItem.run(id, line.product.id, line.qty, line.unit_cost);
    applyAverageCost(line.product.id, line.qty, line.unit_cost);
    insertMove.run(line.product.id, line.qty, line.unit_cost, id, label, userId, `${docDate} ${time}`);
  }
  return id;
}

export const createOpening = (body, userId) => transact(() => loadOpening(writeOpening(body, userId)));

export function register(router) {
  router.get('/api/openings', (ctx) => {
    const where = [];
    const args = [];
    if (str(ctx.query.from)) (where.push('o.date >= ?'), args.push(str(ctx.query.from)));
    if (str(ctx.query.to)) (where.push('o.date <= ?'), args.push(str(ctx.query.to)));
    if (str(ctx.query.search)) {
      where.push(`(o.doc_no LIKE ? OR o.note LIKE ? OR EXISTS (
        SELECT 1 FROM opening_items i JOIN products p ON p.id = i.product_id
        WHERE i.opening_id = o.id AND (p.name LIKE ? OR p.barcode LIKE ?)))`);
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like, like, like);
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const paging = pageParams(ctx.query, { per: 50 });
    if (paging) {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM openings o ${clause}`).get(...args).n;
      const rows = db
        .prepare(`${LIST_SQL} ${clause} ORDER BY o.date DESC, o.id DESC LIMIT ? OFFSET ?`)
        .all(...args, paging.per, paging.offset);
      const sums = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(i.qty * i.unit_cost), 0), 2) AS value
           FROM opening_items i WHERE i.opening_id IN (SELECT o.id FROM openings o ${clause})`,
        )
        .get(...args);
      return { ...pageResult(rows, total, paging), sums };
    }
    return db
      .prepare(`${LIST_SQL} ${clause} ORDER BY o.date DESC, o.id DESC LIMIT ${Math.min(500, num(ctx.query.limit, 200))}`)
      .all(...args);
  });

  router.get('/api/openings/:id', (ctx) => {
    const doc = loadOpening(ctx.params.id);
    if (!doc) throw notFound('Opening stock document not found', 'OPENING_NOT_FOUND');
    return doc;
  });

  router.post('/api/openings', (ctx) => createOpening(ctx.body, ctx.user.id));

  // Deleting takes the stock back out. The average cost is left as it is: once
  // goods have moved there is no honest way to unblend it.
  router.delete('/api/openings/:id', (ctx) => {
    const doc = loadOpening(ctx.params.id);
    if (!doc) throw notFound('Opening stock document not found', 'OPENING_NOT_FOUND');
    return transact(() => {
      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'openings' AND ref_id = ?`).run(doc.id);
      db.prepare(`DELETE FROM openings WHERE id = ?`).run(doc.id);
      return { deleted: true };
    });
  });
}
