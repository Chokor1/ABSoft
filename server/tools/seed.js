/**
 * Fills a fresh database with a few weeks of believable demo activity so the
 * dashboard and reports have something to show. Safe to skip entirely.
 *
 *   npm run seed
 */
import { db, transact } from '../db.js';
import { ensureSeedAdmin } from '../auth.js';
import { money, qty } from '../util.js';

ensureSeedAdmin();
const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();

const { n } = db.prepare(`SELECT COUNT(*) AS n FROM products`).get();
if (n > 0) {
  console.log('Database already has products - seeding skipped.');
  process.exit(0);
}

const CATALOGUE = [
  ['Espresso Beans 1kg', '5901234123457', 'Coffee', 'kg', 9.5, 18.0, 5],
  ['Ground Coffee 500g', '5901234123464', 'Coffee', 'pcs', 4.8, 9.5, 8],
  ['Green Tea Box', '4006381333931', 'Tea', 'box', 3.2, 7.0, 6],
  ['Paper Cups 100pcs', '8712345678906', 'Supplies', 'pack', 2.4, 5.5, 10],
  ['Whole Milk 1L', '3017620422003', 'Dairy', 'pcs', 0.9, 1.8, 20],
  ['Chocolate Muffin', '7622210992796', 'Bakery', 'pcs', 0.7, 2.5, 15],
  ['Croissant', '7622210992802', 'Bakery', 'pcs', 0.55, 2.0, 15],
  ['Bottled Water 500ml', '5449000000996', 'Drinks', 'pcs', 0.25, 1.0, 30],
  ['Orange Juice 1L', '5449000131805', 'Drinks', 'pcs', 1.4, 3.2, 12],
  ['Sugar Sachets 500pcs', '8901234567890', 'Supplies', 'box', 6.0, 12.0, 4],
];

const EXPENSES = [
  ['Rent', 'Monthly shop rent', 850],
  ['Salaries', 'Part-time barista', 620],
  ['Utilities', 'Electricity and water', 145],
  ['Supplies', 'Cleaning materials', 38],
  ['Marketing', 'Local flyers', 60],
  ['Transport', 'Supplier pickup', 25],
];

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (a, b) => a + Math.random() * (b - a);

transact(() => {
  const insertProduct = db.prepare(
    `INSERT INTO products (name, barcode, category, unit, cost, price, min_stock) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids = CATALOGUE.map((p) => Number(insertProduct.run(...p).lastInsertRowid));
  const products = ids.map((id, i) => ({ id, cost: CATALOGUE[i][4], price: CATALOGUE[i][5] }));

  const insertPurchase = db.prepare(
    `INSERT INTO purchases (doc_no, supplier, date, total, note, user_id) VALUES (?, ?, ?, ?, '', ?)`,
  );
  const insertPurchaseItem = db.prepare(
    `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, total) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMove = db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSale = db.prepare(
    `INSERT INTO sales (doc_no, customer, date, subtotal, discount, tax, total, cogs, paid, method, note, user_id)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, '', ?)`,
  );
  const insertSaleItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost, discount, total) VALUES (?, ?, ?, ?, ?, 0, ?)`,
  );

  // Three restocks, sized to comfortably cover the sales generated below.
  let purchaseNo = 0;
  for (const offset of [40, 22, 8]) {
    const date = day(offset);
    const lines = products.map((p) => ({ ...p, qty: qty(Math.round(between(120, 220))) }));
    const total = money(lines.reduce((s, l) => s + l.qty * l.cost, 0));
    const docNo = `PO-${String(++purchaseNo).padStart(6, '0')}`;
    const purchaseId = Number(insertPurchase.run(docNo, 'Wholesale Depot', date, total, admin.id).lastInsertRowid);
    for (const l of lines) {
      insertPurchaseItem.run(purchaseId, l.id, l.qty, l.cost, money(l.qty * l.cost));
      insertMove.run(l.id, l.qty, l.cost, 'purchase', 'purchases', purchaseId, docNo, admin.id, `${date} 09:00:00`);
    }
  }

  // Daily sales for the last 35 days.
  let saleNo = 0;
  for (let offset = 35; offset >= 0; offset--) {
    const date = day(offset);
    const transactions = Math.round(between(3, 11));
    for (let t = 0; t < transactions; t++) {
      const lineCount = Math.round(between(1, 4));
      const lines = [];
      for (let i = 0; i < lineCount; i++) {
        const p = pick(products);
        if (lines.some((l) => l.id === p.id)) continue;
        lines.push({ ...p, qty: Math.round(between(1, 4)) });
      }
      if (!lines.length) continue;
      const subtotal = money(lines.reduce((s, l) => s + l.qty * l.price, 0));
      const cogs = money(lines.reduce((s, l) => s + l.qty * l.cost, 0));
      const docNo = `INV-${String(++saleNo).padStart(6, '0')}`;
      const method = pick(['cash', 'cash', 'card', 'transfer']);
      const saleId = Number(
        insertSale.run(docNo, '', date, subtotal, subtotal, cogs, subtotal, method, admin.id).lastInsertRowid,
      );
      for (const l of lines) {
        insertSaleItem.run(saleId, l.id, l.qty, l.price, l.cost, money(l.qty * l.price));
        insertMove.run(l.id, -l.qty, l.cost, 'sale', 'sales', saleId, docNo, admin.id, `${date} 12:00:00`);
      }
    }
  }

  const insertExpense = db.prepare(
    `INSERT INTO expenses (date, category, note, amount, method, user_id) VALUES (?, ?, ?, ?, 'cash', ?)`,
  );
  // Spread the running costs across the period rather than dumping them on one day.
  EXPENSES.forEach(([category, note, amount], i) => {
    for (const offset of [34 - i * 2, 6 - (i % 5)]) {
      insertExpense.run(day(offset), category, note, money(amount * between(0.85, 1.15)), admin.id);
    }
  });
});

const counts = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM sales) AS sales,
            (SELECT COUNT(*) FROM purchases) AS purchases, (SELECT COUNT(*) FROM expenses) AS expenses`,
  )
  .get();
console.log('Demo data created:', counts);
