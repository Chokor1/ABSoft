/** One page at a time, and the filters the list screens send with it. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'pagingdata');
const PORT = 4545;
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

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

// 60 products: two categories, some out of stock, some running low.
for (let i = 1; i <= 60; i++) {
  await call('POST', '/api/products', {
    name: `Paged Item ${String(i).padStart(2, '0')}`,
    barcode: `PG-${i}`,
    category: i % 2 ? 'Left' : 'Right',
    cost: 1,
    price: 3,
    min_stock: 5,
    opening_stock: i % 10 === 0 ? 0 : i % 5 === 0 ? 3 : 40,
  });
}

console.log('\n[a page at a time]');
const all = await get('/api/products');
check('without a page, the answer is the whole list, as before', Array.isArray(all) && all.length === 60, String(all.length));
const p1 = await get('/api/products?page=1&per=25');
check('with a page, it says what it is sending', p1.rows.length === 25 && p1.page === 1 && p1.per === 25, JSON.stringify({ n: p1.rows?.length, ...p1, rows: undefined }));
check('and how much there is in total', p1.total === 60 && p1.pages === 3);
const p3 = await get('/api/products?page=3&per=25');
check('the last page holds the remainder', p3.rows.length === 10);
check('the pages do not overlap', !p3.rows.some((r) => p1.rows.some((x) => x.id === r.id)));
check('page 99 is simply empty, not an error', (await get('/api/products?page=99&per=25')).rows.length === 0);
check('a silly page size is brought back into range', (await get('/api/products?page=1&per=9999')).per === 200);
check('the value above the list covers everything that matches, not the page',
  near(p1.sums.stock_value, all.reduce((s, p) => s + p.stock_value, 0)), JSON.stringify(p1.sums));

console.log('\n[filters]');
const left = await get('/api/products?page=1&per=25&category=Left');
check('by category', left.total === 30 && left.rows.every((r) => r.category === 'Left'), String(left.total));
const out = await get('/api/products?page=1&per=100&stock=out');
check('out of stock', out.total === 6 && out.rows.every((r) => r.stock <= 0), String(out.total));
const low = await get('/api/products?page=1&per=100&stock=low');
check('running low, but not empty', low.rows.every((r) => r.stock > 0 && r.stock <= r.min_stock) && low.total === 6, String(low.total));
const inStock = await get('/api/products?page=1&per=100&stock=in');
check('in stock', inStock.total === 54, String(inStock.total));
check('search and category together', (await get('/api/products?page=1&per=100&category=Right&search=Item 02')).total === 1);

console.log('\n[invoices]');
const item = all[0];
const sell = (qty, paid) => call('POST', '/api/sales', { paid, items: [{ product_id: item.id, qty, unit_price: 10 }] });
await sell(1, 10); // paid
await sell(1, 4); // part paid
await sell(1, 0); // unpaid
const sales = await get('/api/sales?page=1&per=5');
check('invoices come a page at a time', sales.rows.length === 3 && sales.total === 3 && sales.pages === 1,
  JSON.stringify({ n: sales.rows?.length, total: sales.total, pages: sales.pages }));
check('a tiny page size is brought up to a sensible minimum', (await get('/api/sales?page=1&per=1')).per === 5);
check('the badges above the list add up everything that matches', near(sales.sums.total, 30), JSON.stringify(sales.sums));
check('paid only', (await get('/api/sales?page=1&per=50&status=paid')).total === 1);
check('part paid only', (await get('/api/sales?page=1&per=50&status=partial')).total === 1);
check('unpaid only', (await get('/api/sales?page=1&per=50&status=unpaid')).total === 1);
check('and the old unpaid flag still works', (await get('/api/sales?unpaid=1')).length === 2);

console.log('\n[the rest of the lists]');
await call('POST', '/api/purchases', { supplier: 'Pager Supplies', items: [{ product_id: item.id, qty: 2, unit_cost: 1 }] });
const purchases = await get('/api/purchases?page=1&per=10');
check('purchases', purchases.total === 1 && near(purchases.sums.total, 2));
check('by supplier', (await get('/api/purchases?page=1&per=10&supplier=Pager Supplies')).total === 1);
await call('POST', '/api/expenses', { amount: 30, category: 'Rent', note: 'March' });
await call('POST', '/api/expenses', { amount: 12, category: 'Power' });
const expenses = await get('/api/expenses?page=1&per=5');
check('expenses', expenses.total === 2 && expenses.rows.length === 2);
check('with the period total and breakdown beside them',
  near(expenses.sums.total, 42) && expenses.byCategory.length === 2, JSON.stringify({ sums: expenses.sums, byCategory: expenses.byCategory }));
check('and by category', (await get('/api/expenses?page=1&per=10&category=Rent')).total === 1);
await call('POST', `/api/products/${item.id}/adjust`, { qty: -1, note: 'Damaged' });
const adjustments = await get('/api/adjustments?page=1&per=10&type=adjustment');
check('adjustments', adjustments.total === 1 && adjustments.rows.length === 1);
check('the reasons used are offered for filtering', (await get('/api/adjustment-reasons')).includes('Damaged'));
check('and filter', (await get('/api/adjustments?page=1&per=10&reason=Damaged')).total === 1);

for (let i = 0; i < 30; i++) await call('POST', '/api/entities/customer', { name: `Paged Customer ${i}` });
const customers = await get('/api/entities/customer?page=2&per=12');
check('customers and suppliers page too', customers.rows.length === 12 && customers.total === 30 && customers.pages === 3,
  JSON.stringify({ n: customers.rows?.length, total: customers.total }));
check('while the pickers still get every name', (await get('/api/entities/customer')).length === 30);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
