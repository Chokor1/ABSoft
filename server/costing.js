import { db } from './db.js';
import { money, num } from './util.js';

/**
 * Weighted-average costing: blend a quantity coming in at a cost into what is
 * already on hand, so margins reflect what the goods on the shelf actually cost.
 * Call it before the movement lands, so it sees the balance before the goods.
 */
export function applyAverageCost(productId, inQty, inCost) {
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
