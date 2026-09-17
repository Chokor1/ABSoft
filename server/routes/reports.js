import { db } from '../db.js';
import { dateRange, money, num, pageParams, pageResult, shiftDays, str, today } from '../util.js';

const round = (n) => money(num(n));

/* --------------------------------------------------------- sales analysis -- */

/**
 * Every sold line in the window, with what it really brought in. An invoice
 * discount is shared across its lines by value, so the lines add up to the
 * invoice (before tax) and to the revenue in the profit & loss.
 */
function analysisLines(query) {
  const { from, to } = dateRange(query);
  const where = ['s.date BETWEEN ? AND ?'];
  const args = [from, to];
  // "-" asks for the sales with no customer (or products with no category).
  const customer = str(query.customer);
  if (customer === '-') where.push(`s.customer = ''`);
  else if (customer) (where.push('s.customer = ? COLLATE NOCASE'), args.push(customer));
  if (num(query.product_id) > 0) (where.push('i.product_id = ?'), args.push(num(query.product_id)));
  const category = str(query.category);
  if (category === '-') where.push(`p.category = ''`);
  else if (category) (where.push('p.category = ? COLLATE NOCASE'), args.push(category));
  const sql = `
    WITH L AS (
      SELECT i.id AS line_id, s.id AS sale_id, s.doc_no, s.date, s.customer,
             p.id AS product_id, p.name, p.barcode, p.category, p.unit,
             i.qty, i.unit_price,
             i.qty * i.unit_price AS gross,
             i.total * (CASE WHEN s.subtotal > 0 THEN (s.subtotal - s.discount) / s.subtotal ELSE 1 END) AS net,
             i.qty * i.unit_cost AS cost
      FROM sale_items i
      JOIN sales s ON s.id = i.sale_id
      JOIN products p ON p.id = i.product_id
      WHERE ${where.join(' AND ')}
    )`;
  return { from, to, sql, args };
}

const MEASURES = `
  ROUND(SUM(qty), 3) AS qty,
  ROUND(SUM(gross), 2) AS gross,
  ROUND(SUM(gross - net), 2) AS discount,
  ROUND(SUM(net), 2) AS sales,
  ROUND(SUM(cost), 2) AS cost,
  ROUND(SUM(net - cost), 2) AS profit,
  CASE WHEN SUM(net) > 0 THEN ROUND(SUM(net - cost) / SUM(net) * 100, 1) ELSE 0 END AS margin,
  COUNT(DISTINCT sale_id) AS invoices,
  COUNT(*) AS lines`;

/** How the lines can be rolled up: what each grouping shows, what it sorts by, and its default order. */
const GROUPS = {
  lines: {
    select: `line_id AS key, sale_id, doc_no, date, customer, product_id, name, barcode, category, unit, qty, unit_price,
             ROUND(gross, 2) AS gross, ROUND(gross - net, 2) AS discount, ROUND(net, 2) AS sales,
             ROUND(cost, 2) AS cost, ROUND(net - cost, 2) AS profit,
             CASE WHEN net > 0 THEN ROUND((net - cost) / net * 100, 1) ELSE 0 END AS margin`,
    group: '',
    sorts: ['date', 'doc_no', 'customer', 'name', 'qty', 'unit_price', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'date DESC, sale_id DESC, key',
  },
  invoice: {
    select: `sale_id AS key, sale_id, doc_no AS label, doc_no, date, customer, ${MEASURES}`,
    group: 'GROUP BY sale_id',
    sorts: ['date', 'doc_no', 'customer', 'lines', 'qty', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'date DESC, sale_id DESC',
  },
  item: {
    select: `product_id AS key, product_id, name AS label, name, barcode, category, unit, ${MEASURES}`,
    group: 'GROUP BY product_id',
    sorts: ['name', 'qty', 'invoices', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'sales DESC, name COLLATE NOCASE',
  },
  category: {
    select: `category AS key, category AS label, COUNT(DISTINCT product_id) AS items, ${MEASURES}`,
    group: 'GROUP BY category COLLATE NOCASE',
    sorts: ['label', 'items', 'qty', 'invoices', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'sales DESC, label COLLATE NOCASE',
  },
  customer: {
    select: `customer AS key, customer AS label, COUNT(DISTINCT product_id) AS items, ${MEASURES}`,
    group: 'GROUP BY customer COLLATE NOCASE',
    sorts: ['label', 'items', 'qty', 'invoices', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'sales DESC, label COLLATE NOCASE',
  },
  day: {
    select: `date AS key, date AS label, ${MEASURES}`,
    group: 'GROUP BY date',
    sorts: ['label', 'qty', 'invoices', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'label DESC',
  },
  month: {
    select: `substr(date, 1, 7) AS key, substr(date, 1, 7) AS label, ${MEASURES}`,
    group: 'GROUP BY substr(date, 1, 7)',
    sorts: ['label', 'qty', 'invoices', 'discount', 'sales', 'cost', 'profit', 'margin'],
    order: 'label DESC',
  },
};

export function salesAnalysis(query) {
  const groupKey = Object.hasOwn(GROUPS, str(query.group)) ? str(query.group) : 'lines';
  const g = GROUPS[groupKey];
  const { from, to, sql, args } = analysisLines(query);

  const sortKey = g.sorts.includes(str(query.sort)) ? str(query.sort) : '';
  const dir = str(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const text = ['doc_no', 'customer', 'name', 'label'].includes(sortKey) ? ' COLLATE NOCASE' : '';
  const order = sortKey ? `${sortKey}${text} ${dir}, ${g.order}` : g.order;

  const totals = db
    .prepare(
      `${sql} SELECT ${MEASURES}, COUNT(DISTINCT product_id) AS items,
              COUNT(DISTINCT lower(customer)) AS customers FROM L`,
    )
    .get(...args);
  for (const k of ['qty', 'gross', 'discount', 'sales', 'cost', 'profit']) totals[k] = num(totals[k]);

  const body = `${sql} SELECT ${g.select} FROM L ${g.group}`;
  const count = g.group
    ? db.prepare(`${sql} SELECT COUNT(*) AS n FROM (SELECT 1 FROM L ${g.group})`).get(...args).n
    : num(totals.lines);

  const head = { from, to, group: groupKey, sort: sortKey, dir: dir.toLowerCase(), totals };
  // Everything, for an export; capped so a runaway range cannot stall the server.
  if (query.all === '1') {
    return { ...head, rows: db.prepare(`${body} ORDER BY ${order} LIMIT 50000`).all(...args), total: count };
  }
  const paging = pageParams({ page: str(query.page) || '1', per: query.per }, { per: 50 });
  const rows = db.prepare(`${body} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, paging.per, paging.offset);
  return { ...head, ...pageResult(rows, count, paging) };
}

/** Core numbers behind every report and the dashboard tiles. */
function summarise(from, to) {
  const sales = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(tax), 0) AS tax,
              COALESCE(SUM(discount), 0) AS discount, COALESCE(SUM(cogs), 0) AS cogs,
              COUNT(*) AS count
       FROM sales WHERE date BETWEEN ? AND ?`,
    )
    .get(from, to);
  const expenses = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses WHERE date BETWEEN ? AND ?`)
    .get(from, to);
  const purchases = db
    .prepare(`SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count FROM purchases WHERE date BETWEEN ? AND ?`)
    .get(from, to);

  const revenue = round(num(sales.gross) - num(sales.tax)); // net of sales tax
  const cogs = round(sales.cogs);
  const grossProfit = round(revenue - cogs);
  const expenseTotal = round(expenses.total);

  return {
    from,
    to,
    revenue,
    gross_sales: round(sales.gross),
    tax_collected: round(sales.tax),
    discounts: round(sales.discount),
    cogs,
    gross_profit: grossProfit,
    gross_margin: revenue > 0 ? money((grossProfit / revenue) * 100) : 0,
    expenses: expenseTotal,
    net_profit: round(grossProfit - expenseTotal),
    net_margin: revenue > 0 ? money(((grossProfit - expenseTotal) / revenue) * 100) : 0,
    sale_count: num(sales.count),
    expense_count: num(expenses.count),
    purchases: round(purchases.total),
    purchase_count: num(purchases.count),
    avg_ticket: num(sales.count) > 0 ? money(num(sales.gross) / num(sales.count)) : 0,
  };
}

/** Daily revenue/profit series, with empty days filled in so charts stay honest. */
function dailySeries(from, to) {
  const rows = db
    .prepare(
      `SELECT date,
              ROUND(SUM(total - tax), 2) AS revenue,
              ROUND(SUM(total - tax - cogs), 2) AS gross_profit,
              COUNT(*) AS sales
       FROM sales WHERE date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(from, to);
  const expenseRows = db
    .prepare(`SELECT date, ROUND(SUM(amount), 2) AS expenses FROM expenses WHERE date BETWEEN ? AND ? GROUP BY date`)
    .all(from, to);

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const expByDate = new Map(expenseRows.map((r) => [r.date, r.expenses]));
  const out = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let guard = 0;
  while (cursor <= end && guard++ < 3660) {
    const key = cursor.toISOString().slice(0, 10);
    const row = byDate.get(key);
    const expenses = num(expByDate.get(key));
    out.push({
      date: key,
      revenue: num(row?.revenue),
      gross_profit: num(row?.gross_profit),
      expenses,
      net_profit: money(num(row?.gross_profit) - expenses),
      sales: num(row?.sales),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function register(router) {
  // Everything the dashboard needs, in one round trip.
  router.get('/api/reports/dashboard', () => {
    const day = today();
    const monthStart = `${day.slice(0, 7)}-01`;
    const chartStart = shiftDays(day, -29);

    const inventory = db
      .prepare(
        `SELECT COUNT(*) AS products,
                COALESCE(SUM(CASE WHEN COALESCE(s.stock, 0) <= p.min_stock THEN 1 ELSE 0 END), 0) AS low_stock,
                ROUND(COALESCE(SUM(COALESCE(s.stock, 0) * p.cost), 0), 2) AS stock_value,
                ROUND(COALESCE(SUM(COALESCE(s.stock, 0) * p.price), 0), 2) AS retail_value
         FROM products p LEFT JOIN product_stock s ON s.product_id = p.id
         WHERE p.active = 1`,
      )
      .get();

    return {
      today: summarise(day, day),
      month: summarise(monthStart, day),
      chart: dailySeries(chartStart, day),
      inventory,
      low_stock: db
        .prepare(
          `SELECT p.id, p.name, p.unit, p.min_stock, COALESCE(s.stock, 0) AS stock
           FROM products p LEFT JOIN product_stock s ON s.product_id = p.id
           WHERE p.active = 1 AND COALESCE(s.stock, 0) <= p.min_stock
           ORDER BY (COALESCE(s.stock, 0) - p.min_stock) LIMIT 8`,
        )
        .all(),
      receivable: db
        .prepare(
          `SELECT COUNT(*) AS invoices, ROUND(COALESCE(SUM(total - paid), 0), 2) AS balance
           FROM sales WHERE ROUND(total - paid, 2) > 0.005`,
        )
        .get(),
      recent_sales: db
        .prepare(
          `SELECT s.id, s.doc_no, s.customer, s.date, s.total, s.method, u.username
           FROM sales s LEFT JOIN users u ON u.id = s.user_id
           ORDER BY s.id DESC LIMIT 8`,
        )
        .all(),
      top_products: db
        .prepare(
          `SELECT p.name, ROUND(SUM(i.qty), 3) AS qty, ROUND(SUM(i.total), 2) AS revenue
           FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
           WHERE s.date BETWEEN ? AND ?
           GROUP BY p.id ORDER BY revenue DESC LIMIT 6`,
        )
        .all(monthStart, day),
    };
  });

  // Profit & loss for any from/to window.
  router.get('/api/reports/pnl', (ctx) => {
    const { from, to } = dateRange(ctx.query);
    return {
      ...summarise(from, to),
      series: dailySeries(from, to),
      expense_breakdown: db
        .prepare(
          `SELECT category, ROUND(SUM(amount), 2) AS amount, COUNT(*) AS count
           FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`,
        )
        .all(from, to),
      payment_breakdown: db
        .prepare(
          `SELECT method, ROUND(SUM(total), 2) AS amount, COUNT(*) AS count
           FROM sales WHERE date BETWEEN ? AND ? GROUP BY method ORDER BY amount DESC`,
        )
        .all(from, to),
      top_products: db
        .prepare(
          `SELECT p.name, ROUND(SUM(i.qty), 3) AS qty, ROUND(SUM(i.total), 2) AS revenue,
                  ROUND(SUM(i.total - i.qty * i.unit_cost), 2) AS profit
           FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
           WHERE s.date BETWEEN ? AND ?
           GROUP BY p.id ORDER BY profit DESC LIMIT 15`,
        )
        .all(from, to),
    };
  });

  // Full movement ledger — the "history" behind every stock balance.
  router.get('/api/reports/stock-history', (ctx) => {
    const { from, to } = dateRange(ctx.query);
    const where = [`date(m.created_at) BETWEEN ? AND ?`];
    const args = [from, to];
    if (str(ctx.query.product_id)) (where.push('m.product_id = ?'), args.push(num(ctx.query.product_id)));
    if (str(ctx.query.kind)) (where.push('m.kind = ?'), args.push(str(ctx.query.kind)));
    if (str(ctx.query.search)) {
      where.push('(p.name LIKE ? OR p.barcode LIKE ? OR m.note LIKE ?)');
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like, like);
    }
    return db
      .prepare(
        `SELECT m.*, p.name, p.unit, p.barcode, u.username
         FROM stock_moves m JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.id DESC LIMIT ${Math.min(2000, num(ctx.query.limit, 500))}`,
      )
      .all(...args);
  });

  // Stock valuation with in/out totals for the window.
  router.get('/api/reports/stock', (ctx) => {
    const { from, to } = dateRange(ctx.query);
    return db
      .prepare(
        `SELECT p.id, p.name, p.barcode, p.category, p.unit, p.cost, p.price, p.min_stock,
                COALESCE(s.stock, 0) AS stock,
                ROUND(COALESCE(s.stock, 0) * p.cost, 2) AS stock_value,
                COALESCE((SELECT SUM(m.qty) FROM stock_moves m
                          WHERE m.product_id = p.id AND m.qty > 0 AND date(m.created_at) BETWEEN ? AND ?), 0) AS qty_in,
                COALESCE((SELECT -SUM(m.qty) FROM stock_moves m
                          WHERE m.product_id = p.id AND m.qty < 0 AND date(m.created_at) BETWEEN ? AND ?), 0) AS qty_out
         FROM products p LEFT JOIN product_stock s ON s.product_id = p.id
         WHERE p.active = 1
         ORDER BY p.name COLLATE NOCASE`,
      )
      .all(from, to, from, to);
  });

  // Per-product sales performance for the window.
  router.get('/api/reports/products', (ctx) => {
    const { from, to } = dateRange(ctx.query);
    return db
      .prepare(
        `SELECT p.id, p.name, p.category, p.unit,
                ROUND(SUM(i.qty), 3) AS qty,
                ROUND(SUM(i.total), 2) AS revenue,
                ROUND(SUM(i.qty * i.unit_cost), 2) AS cost,
                ROUND(SUM(i.total - i.qty * i.unit_cost), 2) AS profit,
                COUNT(DISTINCT s.id) AS transactions
         FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
         WHERE s.date BETWEEN ? AND ?
         GROUP BY p.id ORDER BY revenue DESC`,
      )
      .all(from, to);
  });

  // What customers still owe, newest first. Accrual accounting means these sales
  // are already counted as revenue; this is the cash not yet collected.
  router.get('/api/reports/receivables', () => {
    const rows = db
      .prepare(
        `SELECT s.id, s.doc_no, s.date, s.customer, s.total, s.paid,
                ROUND(s.total - s.paid, 2) AS balance
         FROM sales s
         WHERE ROUND(s.total - s.paid, 2) > 0.005
         ORDER BY s.date DESC, s.id DESC`,
      )
      .all();
    const byCustomer = db
      .prepare(
        `SELECT CASE WHEN s.customer = '' THEN NULL ELSE s.customer END AS customer,
                COUNT(*) AS invoices,
                ROUND(SUM(s.total - s.paid), 2) AS balance
         FROM sales s
         WHERE ROUND(s.total - s.paid, 2) > 0.005
         GROUP BY s.customer COLLATE NOCASE
         ORDER BY balance DESC`,
      )
      .all();
    return {
      total: round(rows.reduce((sum, r) => sum + r.balance, 0)),
      count: rows.length,
      rows,
      by_customer: byCustomer,
    };
  });

  // Sales lines with their cost and profit, filtered and rolled up however is asked.
  router.get('/api/reports/sales-analysis', (ctx) => salesAnalysis(ctx.query));

  // Sales per cashier — useful for shift reconciliation.
  router.get('/api/reports/staff', (ctx) => {
    const { from, to } = dateRange(ctx.query);
    return db
      .prepare(
        `SELECT COALESCE(u.username, 'unknown') AS username, COALESCE(u.full_name, '') AS full_name,
                COUNT(*) AS sales, ROUND(SUM(s.total), 2) AS revenue,
                ROUND(SUM(s.total - s.tax - s.cogs), 2) AS profit
         FROM sales s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.date BETWEEN ? AND ?
         GROUP BY s.user_id ORDER BY revenue DESC`,
      )
      .all(from, to);
  });
}
