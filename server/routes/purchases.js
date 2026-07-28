import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, nextDocNo, num, qty, str } from '../util.js';

const LIST_SQL = `
  SELECT pu.*, u.username,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS line_count,
         (SELECT COALESCE(SUM(i.qty), 0) FROM purchase_items i WHERE i.purchase_id = pu.id) AS total_qty
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
  return { ...head, items };
}

/**
 * Weighted-average costing: blend the new landed cost into the existing stock
 * so margin reporting reflects what the goods on hand actually cost.
 */
function applyAverageCost(productId, inQty, inCost) {
  const row = db
    .prepare(
      `SELECT p.cost, COALESCE(s.stock, 0) AS stock FROM products p
       LEFT JOIN product_stock s ON s.product_id = p.id WHERE p.id = ?`,
    )
    .get(productId);
  const onHand = Math.max(0, num(row.stock));
  const totalQty = onHand + inQty;
  const newCost = totalQty > 0 ? money((onHand * num(row.cost) + inQty * inCost) / totalQty) : inCost;
  db.prepare(`UPDATE products SET cost = ? WHERE id = ?`).run(newCost, productId);
  return newCost;
}

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
    const sql = `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY pu.date DESC, pu.id DESC LIMIT ${Math.min(500, num(ctx.query.limit, 200))}`;
    return db.prepare(sql).all(...args);
  });

  router.get('/api/purchases/:id', (ctx) => {
    const purchase = loadPurchase(ctx.params.id);
    if (!purchase) throw notFound('Purchase not found', 'PURCHASE_NOT_FOUND');
    return purchase;
  });

  router.post('/api/purchases', (ctx) => {
    const lines = Array.isArray(ctx.body.items) ? ctx.body.items : [];
    if (!lines.length) throw badRequest('Add at least one product to the purchase', 'PURCHASE_EMPTY');

    const prepared = lines.map((line) => {
      const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(num(line.product_id));
      if (!product) throw badRequest('Unknown product on one of the lines', 'UNKNOWN_PRODUCT');
      const quantity = qty(num(line.qty));
      const unitCost = money(Math.max(0, num(line.unit_cost)));
      if (quantity <= 0) throw badRequest(`Quantity for "${product.name}" must be greater than zero`, 'QTY_POSITIVE', { name: product.name });
      return { product, qty: quantity, unit_cost: unitCost, total: money(quantity * unitCost) };
    });

    const date = isoDate(ctx.body.date);
    const total = money(prepared.reduce((sum, l) => sum + l.total, 0));

    return transact(() => {
      const docNo = str(ctx.body.doc_no) || nextDocNo(db, 'purchases', 'PO');
      const res = db
        .prepare(
          `INSERT INTO purchases (doc_no, supplier, date, total, note, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(docNo, str(ctx.body.supplier), date, total, str(ctx.body.note), ctx.user.id);
      const purchaseId = lastId(res);

      const insertItem = db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, total) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertMove = db.prepare(
        `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
         VALUES (?, ?, ?, 'purchase', 'purchases', ?, ?, ?, ?)`,
      );

      for (const line of prepared) {
        insertItem.run(purchaseId, line.product.id, line.qty, line.unit_cost, line.total);
        // Re-average before the movement lands, so the calculation sees the pre-purchase balance.
        applyAverageCost(line.product.id, line.qty, line.unit_cost);
        insertMove.run(
          line.product.id,
          line.qty,
          line.unit_cost,
          purchaseId,
          `${docNo}${str(ctx.body.supplier) ? ' · ' + str(ctx.body.supplier) : ''}`,
          ctx.user.id,
          `${date} ${new Date().toISOString().slice(11, 19)}`,
        );
      }
      return loadPurchase(purchaseId);
    });
  });

  router.delete('/api/purchases/:id', (ctx) => {
    const purchase = loadPurchase(ctx.params.id);
    if (!purchase) throw notFound('Purchase not found', 'PURCHASE_NOT_FOUND');
    if (ctx.user.role !== 'admin') throw badRequest('Only an administrator can delete a purchase', 'PURCHASE_ADMIN_ONLY');
    return transact(() => {
      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'purchases' AND ref_id = ?`).run(purchase.id);
      db.prepare(`DELETE FROM purchases WHERE id = ?`).run(purchase.id);
      return { deleted: true };
    });
  });
}
