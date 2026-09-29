/**
 * Server-side regression over the surface this change touched, plus the core
 * money paths that must never move: costing, stock, P&L.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Anchored to this file, so the suite runs from any clone on any machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const WORK = resolve(APP, '.test-run');


const DATA = resolve(WORK, 'regressapi');
const PORT = 4507;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

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

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

console.log('\n[catalogue for the pickers]');
const made = [];
for (const [name, barcode, cat, cost, price] of [
  ['Alpha Coffee', 'BC-100', 'Drinks', 4, 10],
  ['Beta Coffee', 'BC-200', 'Drinks', 5, 12],
  ['Gamma Soap', 'BC-300', 'Cleaning', 2, 6],
  ['Delta Brush', 'BC-400', 'Cleaning', 1, 3],
]) {
  const r = await call('POST', '/api/products', { name, barcode, category: cat, cost, price, opening_stock: 100 });
  made.push(r.data);
}
check('four products created', made.every((p) => p && p.id));

console.log('\n[search - what the picker calls]');
check('search matches on name', (await call('GET', '/api/products?search=Alpha')).data.length === 1);
check('search matches on barcode', (await call('GET', '/api/products?search=BC-300')).data[0].name === 'Gamma Soap');
check('search matches on category', (await call('GET', '/api/products?search=Cleaning')).data.length === 2);
const coffee = (await call('GET', '/api/products?search=coffee')).data;
check('search is case-insensitive and partial', coffee.length === 2, coffee.map((p) => p.name).join('|'));
check('an unmatched search returns nothing, not everything',
  (await call('GET', '/api/products?search=zzzzz')).data.length === 0);

console.log('\n[the new limit]');
check('limit caps the result count', (await call('GET', '/api/products?limit=2')).data.length === 2);
check('no limit still returns everything', (await call('GET', '/api/products')).data.length === 4);
check('limit combines with search', (await call('GET', '/api/products?search=coffee&limit=1')).data.length === 1);
check('a silly limit is clamped, not obeyed blindly',
  (await call('GET', '/api/products?limit=99999')).data.length === 4);
check('limit=0 means unlimited', (await call('GET', '/api/products?limit=0')).data.length === 4);

console.log('\n[lookup is exact only - the scanner path]');
check('an exact barcode resolves', (await call('GET', '/api/products/lookup?code=BC-100')).data.name === 'Alpha Coffee');
check('an exact name resolves', (await call('GET', '/api/products/lookup?code=Gamma Soap')).data.name === 'Gamma Soap');
check('an exact name ignores capitalisation',
  (await call('GET', '/api/products/lookup?code=gamma soap')).data.name === 'Gamma Soap');
check('a partial name no longer silently matches',
  (await call('GET', '/api/products/lookup?code=Coffee')).status === 404);
check('a partial barcode no longer silently matches',
  (await call('GET', '/api/products/lookup?code=BC-')).status === 404);
check('a single letter no longer silently matches',
  (await call('GET', '/api/products/lookup?code=a')).status === 404);
check('an empty code is rejected', (await call('GET', '/api/products/lookup?code=')).status === 400);

console.log('\n[buying still works end to end]');
const buy = await call('POST', '/api/purchases', {
  supplier: 'Picker Supplier',
  items: [
    { product_id: made[0].id, qty: 50, unit_cost: 6 },
    { product_id: made[2].id, qty: 20, unit_cost: 3 },
  ],
});
check('a two-line purchase saves', buy.status === 200 && buy.data.items.length === 2);
check('total = 50*6 + 20*3 = 360', near(buy.data.total, 360), String(buy.data.total));
const alpha = (await call('GET', `/api/products/${made[0].id}`)).data;
check('stock rose to 150', near(alpha.stock, 150), String(alpha.stock));
check('average cost re-blended: (100*4 + 50*6)/150 = 4.67', near(alpha.cost, 4.67), String(alpha.cost));
check('the supplier was remembered',
  (await call('GET', '/api/entities/supplier')).data.some((s) => s.name === 'Picker Supplier'));

console.log('\n[selling still works end to end]');
const sale = await call('POST', '/api/sales', {
  customer: 'Picker Customer',
  items: [{ product_id: made[0].id, qty: 10, unit_price: 10 }],
});
check('the sale saves', sale.status === 200);
check('cogs uses the blended cost: 10 * 4.67 = 46.70', near(sale.data.cogs, 46.7), String(sale.data.cogs));
check('profit = 100 - 46.70 = 53.30', near(sale.data.profit, 53.3), String(sale.data.profit));
check('stock fell to 140', near((await call('GET', `/api/products/${made[0].id}`)).data.stock, 140));
check('the customer was remembered',
  (await call('GET', '/api/entities/customer')).data.some((c) => c.name === 'Picker Customer'));

console.log('\n[reports unchanged]');
// The shop's own date, as the server records it — not UTC, which is a day off at night.
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const pnl = (await call('GET', `/api/reports/pnl?from=${today}&to=${today}`)).data;
check('revenue = 100', near(pnl.revenue, 100), String(pnl.revenue));
check('cogs = 46.70', near(pnl.cogs, 46.7), String(pnl.cogs));
check('gross profit = 53.30', near(pnl.gross_profit, 53.3), String(pnl.gross_profit));
check('purchases counted separately = 360', near(pnl.purchases, 360), String(pnl.purchases));

console.log('\n[dashboard comparisons]');
const shift = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const yday = shift(today, -1);
const [ty, tm, td] = today.split('-').map(Number);
const lm = new Date(Date.UTC(ty, tm - 2, 1));
const lmDays = new Date(Date.UTC(lm.getUTCFullYear(), lm.getUTCMonth() + 1, 0)).getUTCDate();
const lmKey = `${lm.getUTCFullYear()}-${String(lm.getUTCMonth() + 1).padStart(2, '0')}`;
const dashBefore = (await call('GET', '/api/reports/dashboard')).data;
check('the tiles get yesterday to compare with', dashBefore.yesterday?.from === yday && dashBefore.yesterday?.to === yday, JSON.stringify(dashBefore.yesterday));
check("…and the same days of last month, its 1st to today's date",
  dashBefore.last_month?.from === `${lmKey}-01` && dashBefore.last_month?.to === `${lmKey}-${String(Math.min(td, lmDays)).padStart(2, '0')}`,
  JSON.stringify(dashBefore.last_month));
const cmpProduct = (await call('GET', '/api/products?page=1&per=1')).data.rows[0].id;
for (const [date, price] of [[yday, 7.77], [`${lmKey}-01`, 3.33], [dashBefore.last_month.to, 2.22]]) {
  const r = await call('POST', '/api/sales', { date, items: [{ product_id: cmpProduct, qty: 1, unit_price: price }] });
  if (r.status !== 201 && r.status !== 200) console.log('  (sale on', date, 'answered', r.status, JSON.stringify(r.data), ')');
}
const dashAfter = (await call('GET', '/api/reports/dashboard')).data;
check("a sale dated yesterday moves yesterday's figure, not today's",
  near(dashAfter.yesterday.gross_sales - dashBefore.yesterday.gross_sales, 7.77) && near(dashAfter.today.gross_sales, dashBefore.today.gross_sales),
  JSON.stringify({ before: dashBefore.yesterday.gross_sales, after: dashAfter.yesterday.gross_sales }));
check('sales on the first and the last compared day of last month both count for it',
  near(dashAfter.last_month.gross_sales - dashBefore.last_month.gross_sales, 5.55),
  JSON.stringify({ before: dashBefore.last_month.gross_sales, after: dashAfter.last_month.gross_sales }));

console.log('\n[unchanged guards]');
check('an empty purchase is still rejected', (await call('POST', '/api/purchases', { items: [] })).status === 400);
check('an empty cart is still rejected', (await call('POST', '/api/sales', { items: [] })).status === 400);
check('a bad product id is still rejected',
  (await call('POST', '/api/sales', { items: [{ product_id: 99999, qty: 1, unit_price: 1 }] })).status === 400);
check('the schema is current', (await call('GET', '/api/system')).data.schema_version === (await call('GET', '/api/system')).data.schema_latest);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
