import { db, getSettings, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, nextDocNo, num, qty, str } from '../util.js';

const LIST_SQL = `
  SELECT s.*, u.username,
         (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS line_count,
         (SELECT COALESCE(SUM(i.qty), 0) FROM sale_items i WHERE i.sale_id = s.id) AS total_qty,
         ROUND(s.total - s.tax - s.cogs, 2) AS profit
  FROM sales s LEFT JOIN users u ON u.id = s.user_id`;

export function loadSale(id) {
  const head = db.prepare(`${LIST_SQL} WHERE s.id = ?`).get(id);
  if (!head) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name, p.barcode, p.unit FROM sale_items i
       JOIN products p ON p.id = i.product_id WHERE i.sale_id = ? ORDER BY i.id`,
    )
    .all(id);
  return { ...head, items };
}

export function register(router) {
  router.get('/api/sales', (ctx) => {
    const where = [];
    const args = [];
    if (str(ctx.query.from)) (where.push('s.date >= ?'), args.push(str(ctx.query.from)));
    if (str(ctx.query.to)) (where.push('s.date <= ?'), args.push(str(ctx.query.to)));
    if (str(ctx.query.user_id)) (where.push('s.user_id = ?'), args.push(num(ctx.query.user_id)));
    if (str(ctx.query.search)) {
      where.push('(s.doc_no LIKE ? OR s.customer LIKE ?)');
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like);
    }
    const sql = `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY s.date DESC, s.id DESC LIMIT ${Math.min(500, num(ctx.query.limit, 200))}`;
    return db.prepare(sql).all(...args);
  });

  router.get('/api/sales/:id', (ctx) => {
    const sale = loadSale(ctx.params.id);
    if (!sale) throw notFound('Sale not found', 'SALE_NOT_FOUND');
    return { ...sale, settings: getSettings() };
  });

  router.post('/api/sales', (ctx) => {
    const lines = Array.isArray(ctx.body.items) ? ctx.body.items : [];
    if (!lines.length) throw badRequest('The cart is empty', 'CART_EMPTY');

    const prepared = lines.map((line) => {
      const product = db
        .prepare(
          `SELECT p.id, p.name, p.cost, COALESCE(st.stock, 0) AS stock FROM products p
           LEFT JOIN product_stock st ON st.product_id = p.id WHERE p.id = ?`,
        )
        .get(num(line.product_id));
      if (!product) throw badRequest('Unknown product in the cart', 'CART_UNKNOWN_PRODUCT');
      const quantity = qty(num(line.qty));
      if (quantity <= 0) throw badRequest(`Quantity for "${product.name}" must be greater than zero`, 'QTY_POSITIVE', { name: product.name });
      const unitPrice = money(Math.max(0, num(line.unit_price)));
      const lineDiscount = money(Math.max(0, num(line.discount)));
      const total = money(Math.max(0, quantity * unitPrice - lineDiscount));
      return {
        product,
        qty: quantity,
        unit_price: unitPrice,
        unit_cost: money(num(product.cost)),
        discount: lineDiscount,
        total,
      };
    });

    const settings = getSettings();
    const subtotal = money(prepared.reduce((s, l) => s + l.total, 0));
    const discount = money(Math.min(Math.max(0, num(ctx.body.discount)), subtotal));
    const taxable = money(subtotal - discount);
    const taxRate = ctx.body.tax !== undefined ? null : Math.max(0, num(settings.tax_rate));
    const tax = taxRate === null ? money(Math.max(0, num(ctx.body.tax))) : money((taxable * taxRate) / 100);
    const total = money(taxable + tax);
    const cogs = money(prepared.reduce((s, l) => s + l.qty * l.unit_cost, 0));
    const date = isoDate(ctx.body.date);
    const paid = ctx.body.paid === undefined ? total : money(Math.max(0, num(ctx.body.paid)));

    // Selling into negative stock is allowed (counts often lag reality) but reported back.
    const shortages = prepared
      .filter((l) => l.qty > num(l.product.stock))
      .map((l) => ({ name: l.product.name, available: num(l.product.stock), requested: l.qty }));

    const sale = transact(() => {
      const docNo = str(ctx.body.doc_no) || nextDocNo(db, 'sales', 'INV');
      const res = db
        .prepare(
          `INSERT INTO sales (doc_no, customer, date, subtotal, discount, tax, total, cogs, paid, method, note, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docNo,
          str(ctx.body.customer),
          date,
          subtotal,
          discount,
          tax,
          total,
          cogs,
          paid,
          str(ctx.body.method) || 'cash',
          str(ctx.body.note),
          ctx.user.id,
        );
      const saleId = lastId(res);

      const insertItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost, discount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMove = db.prepare(
        `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
         VALUES (?, ?, ?, 'sale', 'sales', ?, ?, ?, ?)`,
      );

      for (const line of prepared) {
        insertItem.run(saleId, line.product.id, line.qty, line.unit_price, line.unit_cost, line.discount, line.total);
        insertMove.run(
          line.product.id,
          -line.qty,
          line.unit_cost,
          saleId,
          `${docNo}${str(ctx.body.customer) ? ' · ' + str(ctx.body.customer) : ''}`,
          ctx.user.id,
          `${date} ${new Date().toISOString().slice(11, 19)}`,
        );
      }
      return loadSale(saleId);
    });

    return { ...sale, shortages, settings };
  });

  router.delete('/api/sales/:id', (ctx) => {
    const sale = loadSale(ctx.params.id);
    if (!sale) throw notFound('Sale not found', 'SALE_NOT_FOUND');
    if (ctx.user.role !== 'admin') throw badRequest('Only an administrator can void a sale', 'SALE_ADMIN_ONLY');
    return transact(() => {
      db.prepare(`DELETE FROM stock_moves WHERE ref_table = 'sales' AND ref_id = ?`).run(sale.id);
      db.prepare(`DELETE FROM sales WHERE id = ?`).run(sale.id);
      return { deleted: true };
    });
  });
}
