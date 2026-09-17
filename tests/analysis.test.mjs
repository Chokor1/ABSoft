/**
 * Several barcodes per product, the sales analysis report, and the customer and
 * supplier pages (summary, statement, items).
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'analysisdata');
const PORT = 4557;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['--no-warnings', 'server/index.js'], {
  cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + log); process.exit(1); }

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const get = async (path) => (await call('GET', path)).data;
const q = (o) => new URLSearchParams(o).toString();

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

/* ------------------------------------------------------------------ barcodes */
console.log('\n[a product with several barcodes]');
const tea = (await call('POST', '/api/products', {
  name: 'Mint Tea', barcode: 'TEA-1', barcodes: ['TEA-2', 'TEA-3'], category: 'Food', cost: 4, price: 10, opening_stock: 100,
})).data;
check('it is saved with its other barcodes', JSON.stringify(tea.barcodes) === '["TEA-2","TEA-3"]', JSON.stringify(tea.barcodes));
const juice = (await call('POST', '/api/products', { name: 'Lime Juice', barcode: 'JU-1', category: 'Drinks', cost: 3, price: 6, opening_stock: 100 })).data;
check('a product without extras has an empty list', Array.isArray(juice.barcodes) && juice.barcodes.length === 0);

check('scanning any of them finds it', (await get('/api/products/lookup?code=TEA-3')).id === tea.id);
check('the main barcode still works', (await get('/api/products/lookup?code=TEA-1')).id === tea.id);
check('searching finds it by another barcode', (await get('/api/products?search=TEA-2')).some((p) => p.id === tea.id));
check('the list pages carry the barcodes too',
  (await get('/api/products?page=1&per=10&search=Mint')).rows[0].barcodes.length === 2);

let r = await call('POST', '/api/products', { name: 'Copy', barcode: 'TEA-2' });
check('a new product cannot take another product\'s extra barcode', r.status === 400 && r.data.code === 'BARCODE_TAKEN');
check('and the message names who has it', r.data.params?.name === 'Mint Tea', JSON.stringify(r.data));
r = await call('POST', '/api/products', { name: 'Copy', barcodes: ['JU-1'] });
check('nor list one that is another product\'s main barcode', r.status === 400 && r.data.code === 'BARCODE_TAKEN');
r = await call('PUT', `/api/products/${juice.id}`, { barcodes: ['TEA-3'] });
check('editing cannot steal one either', r.status === 400 && r.data.code === 'BARCODE_TAKEN');

r = await call('PUT', `/api/products/${tea.id}`, { barcodes: ['TEA-2', 'TEA-2', ' ', 'TEA-1', 'TEA-4'] });
check('repeats, blanks and the main code are dropped', JSON.stringify(r.data.barcodes) === '["TEA-2","TEA-4"]', JSON.stringify(r.data.barcodes));
check('a removed barcode no longer scans', (await call('GET', '/api/products/lookup?code=TEA-3')).status === 404);
r = await call('PUT', `/api/products/${tea.id}`, { price: 10 });
check('an edit that leaves them out keeps them', r.data.barcodes.length === 2);
r = await call('PUT', `/api/products/${tea.id}`, { barcode: 'TEA-4', barcodes: ['TEA-1', 'TEA-2'] });
check('the main barcode can swap with an extra one', r.status === 200 && r.data.barcode === 'TEA-4' &&
  JSON.stringify(r.data.barcodes) === '["TEA-1","TEA-2"]', JSON.stringify(r.data));

const temp = (await call('POST', '/api/products', { name: 'Temp', barcodes: ['TMP-9'] })).data;
await call('DELETE', `/api/products/${temp.id}`);
check('deleting a product frees its barcodes', (await call('POST', '/api/products', { name: 'Temp 2', barcode: 'TMP-9' })).status === 200);

const dry = (await call('POST', '/api/products/import', { dry_run: true, rows: [{ name: 'Again', barcode: 'TEA-2' }] })).data;
check('importing skips a row whose barcode is another product\'s extra one', dry.rows[0].status === 'skip');

/* ------------------------------------------------------------------ sales */
console.log('\n[the sales analysis]');
// Rana buys twice (typed two ways), a walk-in once. The first invoice has a discount of its own.
const s1 = (await call('POST', '/api/sales', {
  date: '2026-03-10', customer: 'Rana Market', discount: 2, tax: 0,
  items: [{ product_id: tea.id, qty: 2, unit_price: 10 }, { product_id: juice.id, qty: 1, unit_price: 6 }],
})).data;
const s2 = (await call('POST', '/api/sales', {
  date: '2026-03-11', customer: 'rana market', tax: 0, paid: 5,
  items: [{ product_id: tea.id, qty: 1, unit_price: 10, discount: 1 }],
})).data;
await call('POST', '/api/sales', { date: '2026-03-12', tax: 0, items: [{ product_id: juice.id, qty: 3, unit_price: 6 }] });
check('three invoices recorded', s1.total === 24 && s2.total === 9 && s2.paid === 5, JSON.stringify([s1.total, s2.total, s2.paid]));

const march = { from: '2026-03-01', to: '2026-03-31' };
const A = (o) => get(`/api/reports/sales-analysis?${q({ ...march, ...o })}`);

let a = await A({});
check('every line is listed', a.group === 'lines' && a.total === 4 && a.rows.length === 4, JSON.stringify(a.total));
check('totals: sales after discounts, cost and profit', near(a.totals.sales, 51) && near(a.totals.cost, 24) && near(a.totals.profit, 27),
  JSON.stringify(a.totals));
check('and the invoices, items and customers behind them', a.totals.invoices === 3 && a.totals.items === 2 && a.totals.customers === 2,
  JSON.stringify(a.totals));
const pnl = await get(`/api/reports/pnl?${q(march)}`);
check('it agrees with the profit & loss', near(pnl.revenue, a.totals.sales) && near(pnl.cogs, a.totals.cost) && near(pnl.gross_profit, a.totals.profit));
const teaLine = a.rows.find((l) => l.sale_id === s1.id && l.product_id === tea.id);
check('an invoice discount is shared across its lines by value', near(teaLine.sales, 18.46) && near(teaLine.discount, 1.54) &&
  near(teaLine.cost, 8) && near(teaLine.profit, 10.46), JSON.stringify(teaLine));
check('newest first by default', a.rows[0].date === '2026-03-12');

a = await A({ group: 'customer' });
check('by customer: the two spellings are one customer', a.rows.length === 2 && near(a.rows.find((x) => x.label).sales, 33),
  JSON.stringify(a.rows));
check('walk-in sales are their own row', a.rows.some((x) => x.label === '' && near(x.sales, 18)));

a = await A({ customer: 'RANA MARKET' });
check('filtering by a customer ignores capitalisation', a.totals.invoices === 2 && near(a.totals.sales, 33));
a = await A({ customer: '-' });
check('"-" filters to sales with no customer', a.totals.invoices === 1 && near(a.totals.sales, 18));
a = await A({ product_id: juice.id });
check('filtering by an item', near(a.totals.qty, 4) && near(a.totals.sales, 23.54), JSON.stringify(a.totals));
a = await A({ category: 'drinks' });
check('filtering by a category', near(a.totals.sales, 23.54) && a.totals.items === 1);
a = await A({ customer: 'Rana Market', category: 'Food' });
check('filters combine', a.totals.lines === 2 && near(a.totals.sales, 27.46), JSON.stringify(a.totals));

a = await A({ group: 'item', sort: 'profit', dir: 'asc' });
check('by item, sorted by profit, lowest first', a.rows.length === 2 && a.rows[0].name === 'Lime Juice' &&
  near(a.rows[0].profit, 11.54) && near(a.rows[1].profit, 15.46), JSON.stringify(a.rows.map((x) => [x.name, x.profit])));
check('a grouped row counts its invoices and has a margin', a.rows[1].invoices === 2 && a.rows[1].margin > 0);
a = await A({ group: 'invoice' });
check('by invoice', a.rows.length === 3 && a.rows.find((x) => x.sale_id === s1.id).lines === 2 &&
  near(a.rows.find((x) => x.sale_id === s1.id).sales, 24));
a = await A({ group: 'category' });
check('by category, with the items in each', a.rows.length === 2 && a.rows.every((x) => x.items === 1));
check('by day', (await A({ group: 'day' })).rows.length === 3);
check('by month', (await A({ group: 'month' })).rows.map((x) => x.label).join() === '2026-03');
check('an unknown grouping falls back to lines', (await A({ group: 'nope' })).group === 'lines');
check('an unknown sort is ignored, not run', (await A({ sort: 'total; DROP TABLE sales' })).rows.length === 4);

a = await A({ page: 1, per: 5 });
check('it pages', a.page === 1 && a.pages === 1 && a.per === 5);
check('all=1 returns everything for an export', (await A({ all: '1', group: 'lines' })).rows.length === 4);
check('outside the window there is nothing', (await get(`/api/reports/sales-analysis?from=2026-04-01&to=2026-04-30`)).total === 0);

/* ---------------------------------------------------------------- customers */
console.log('\n[a customer\'s page]');
const rana = (await get('/api/entities/customer')).find((e) => e.name === 'Rana Market');
let sum = (await get(`/api/entities/customer/${rana.id}/summary`)).summary;
check('summary: invoices, total, paid and what is still owed', sum.invoices === 2 && near(sum.total, 33) && near(sum.paid, 29) &&
  near(sum.balance, 4) && sum.open_invoices === 1, JSON.stringify(sum));
check('with the profit, the dates and the last payment', near(sum.profit, 18) && sum.first_date === '2026-03-10' &&
  sum.last_date === '2026-03-11' && sum.last_payment?.date === '2026-03-11', JSON.stringify(sum));

await call('POST', `/api/sales/${s2.id}/payments`, { amount: 4, date: '2026-03-20', method: 'cash' });
let st = await get(`/api/entities/customer/${rana.id}/statement`);
check('the statement runs from the first invoice to today', st.from === '2026-03-10' && st.opening === 0);
check('invoices and payments in order, with the running balance',
  st.entries.map((e) => `${e.type}:${e.balance}`).join() === 'invoice:24,payment:0,invoice:9,payment:4,payment:0',
  st.entries.map((e) => `${e.type}:${e.balance}`).join());
check('debits, credits and the closing balance', near(st.debit, 33) && near(st.credit, 33) && near(st.closing, 0));

st = await get(`/api/entities/customer/${rana.id}/statement?from=2026-03-12&to=2026-03-31`);
check('a later window brings the balance forward', near(st.opening, 4) && st.entries.length === 1 && near(st.closing, 0),
  JSON.stringify(st));
st = await get(`/api/entities/customer/${rana.id}/statement?from=2026-03-11&to=2026-03-11`);
check('and stops at its end date', near(st.opening, 0) && st.entries.length === 2 && near(st.closing, 4), JSON.stringify(st));
sum = (await get(`/api/entities/customer/${rana.id}/summary`)).summary;
check('once paid up, nothing is owed', near(sum.balance, 0) && sum.open_invoices === 0);

/* ---------------------------------------------------------------- suppliers */
console.log('\n[a supplier\'s page]');
await call('POST', '/api/purchases', { supplier: 'Nour Supply', date: '2026-03-05', items: [{ product_id: tea.id, qty: 10, unit_cost: 4 }] });
await call('POST', '/api/purchases', { supplier: 'nour supply', date: '2026-03-15', items: [{ product_id: juice.id, qty: 5, unit_cost: 3 }, { product_id: tea.id, qty: 2, unit_cost: 5 }] });
const nour = (await get('/api/entities/supplier')).find((e) => e.name === 'Nour Supply');
const ss = (await get(`/api/entities/supplier/${nour.id}/summary`)).summary;
check('summary: purchases, total and items', ss.purchases === 2 && near(ss.total, 65) && ss.items === 2 && ss.last_date === '2026-03-15',
  JSON.stringify(ss));
st = await get(`/api/entities/supplier/${nour.id}/statement?from=2026-03-10`);
check('the statement brings earlier purchases forward', near(st.opening, 40) && st.entries.length === 1 &&
  st.entries[0].lines === 2 && near(st.closing, 65), JSON.stringify(st));
const items = await get(`/api/entities/supplier/${nour.id}/items`);
const teaBought = items.rows.find((x) => x.product_id === tea.id);
check('items: bought quantities, average and last cost', items.rows.length === 2 && near(teaBought.qty, 12) &&
  near(teaBought.total, 50) && near(teaBought.avg_cost, 4.17) && near(teaBought.last_cost, 5), JSON.stringify(teaBought));

check('a category has no statement', (await call('GET', `/api/entities/category/1/statement`)).status === 400);
check('a customer id asked for as a supplier is not found', (await call('GET', `/api/entities/supplier/${rana.id}/summary`)).status === 404);

/* ------------------------------------------------------------------ cashier */
console.log('\n[cashiers]');
await call('POST', '/api/users', { username: 'cash1', password: 'pass1', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'cash1', password: 'pass1' });
check('a cashier cannot open the sales analysis', (await call('GET', '/api/reports/sales-analysis')).status === 403);
check('nor a customer statement', (await call('GET', `/api/entities/customer/${rana.id}/statement`)).status === 403);
check('but still scans an extra barcode at the till', (await call('GET', '/api/products/lookup?code=TEA-1')).data?.id === tea.id);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
