/**
 * Sales put aside. A customer who forgot something should not hold up the queue:
 * the cart — its lines, prices and discounts, and the payment details typed so far —
 * is kept here while the till serves the next customer, and comes back at any till.
 *
 * A held sale is not a sale: it moves no stock, takes no money and appears in no
 * report. It keeps the prices it was quoted at, even if the product's price changes
 * while it waits. Taking one back removes it in the same step, so two tills can
 * never ring up the same cart.
 */
import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, num, qty, str } from '../util.js';

const MAX_LINES = 200;

/** The shop's own clock, as the shifts keep it. */
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

const LIST_SQL = `
  SELECT h.id, h.label, h.summary, h.lines, h.total, h.created_at, h.user_id, u.username
  FROM held_sales h LEFT JOIN users u ON u.id = h.user_id`;

export const heldCount = () => num(db.prepare(`SELECT COUNT(*) AS n FROM held_sales`).get().n);

function readCart(body) {
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw badRequest('There is nothing in the cart to hold', 'HOLD_EMPTY');
  if (lines.length > MAX_LINES) throw badRequest('That sale is too long to hold', 'HOLD_TOO_LONG', { n: MAX_LINES });

  const names = [];
  const items = lines.map((line) => {
    const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(num(line.product_id));
    if (!product) throw badRequest('Unknown product in the cart', 'CART_UNKNOWN_PRODUCT');
    const quantity = qty(num(line.qty));
    if (quantity <= 0) {
      throw badRequest(`Quantity for "${product.name}" must be greater than zero`, 'QTY_POSITIVE', { name: product.name });
    }
    names.push(`${product.name} × ${quantity}`);
    return {
      product_id: product.id,
      qty: quantity,
      unit_price: money(Math.max(0, num(line.unit_price))),
      discount_pct: Math.min(100, Math.max(0, num(line.discount_pct))),
    };
  });
  const total = money(items.reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100), 0));

  // What was typed in the payment dialog before the sale was put aside.
  const d = body.draft && typeof body.draft === 'object' ? body.draft : {};
  const draft = {
    customer: str(d.customer),
    method: str(d.method) || 'cash',
    discount: money(Math.max(0, num(d.discount))),
    discountInput: Math.max(0, num(d.discountInput)),
    discountMode: d.discountMode === 'percent' ? 'percent' : 'amount',
    note: str(d.note),
  };
  const summary = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return { items, draft, total, summary };
}

export function register(router) {
  router.get('/api/held', () => db.prepare(`${LIST_SQL} ORDER BY h.id DESC`).all());

  router.post('/api/held', (ctx) => {
    const cart = readCart(ctx.body);
    const res = db
      .prepare(
        `INSERT INTO held_sales (user_id, label, summary, cart, lines, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.user.id,
        cart.draft.customer,
        cart.summary,
        JSON.stringify({ items: cart.items, draft: cart.draft }),
        cart.items.length,
        cart.total,
        localNow(),
      );
    return db.prepare(`${LIST_SQL} WHERE h.id = ?`).get(lastId(res));
  });

  // Take a held sale back. It leaves the list in the same step.
  router.post('/api/held/:id/resume', (ctx) =>
    transact(() => {
      const row = db.prepare(`SELECT * FROM held_sales WHERE id = ?`).get(num(ctx.params.id));
      if (!row) throw notFound('That sale is no longer held — it was taken up at another till', 'HELD_GONE');
      db.prepare(`DELETE FROM held_sales WHERE id = ?`).run(row.id);

      const cart = JSON.parse(row.cart);
      const items = [];
      let dropped = 0;
      for (const line of cart.items || []) {
        // The name and the stock are today's; the price is the one it was held at.
        const product = db
          .prepare(
            `SELECT p.id, p.name, p.unit, p.price, COALESCE(s.stock, 0) AS stock FROM products p
             LEFT JOIN product_stock s ON s.product_id = p.id WHERE p.id = ?`,
          )
          .get(line.product_id);
        if (!product) {
          dropped++;
          continue;
        }
        items.push({ ...line, name: product.name, unit: product.unit, stock: num(product.stock), price: num(product.price) });
      }
      return { id: row.id, label: row.label, created_at: row.created_at, items, draft: cart.draft || {}, dropped };
    }),
  );

  // Give one up. A cashier may discard what they held; an administrator, anyone's.
  router.delete('/api/held/:id', (ctx) => {
    const row = db.prepare(`SELECT id, user_id FROM held_sales WHERE id = ?`).get(num(ctx.params.id));
    if (!row) throw notFound('That sale is no longer held', 'HELD_GONE');
    if (ctx.user.role !== 'admin' && row.user_id !== ctx.user.id) {
      throw badRequest('Only the person who held this sale, or an administrator, can discard it', 'HELD_NOT_YOURS');
    }
    db.prepare(`DELETE FROM held_sales WHERE id = ?`).run(row.id);
    return { deleted: true, left: heldCount() };
  });
}
