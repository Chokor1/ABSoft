/** What a cashier may reach, and stock adjustments as multi-line documents. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'rolesdata');
const PORT = 4527;
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

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const admin = cookie;
const mk = async (name, barcode, stock = 50) =>
  (await call('POST', '/api/products', { name, barcode, category: 'Counted', cost: 2, price: 5, opening_stock: stock })).data;
const soap = await mk('Adj Soap', 'ADJ-1', 50);
const salt = await mk('Adj Salt', 'ADJ-2', 30);
const oil = await mk('Adj Oil', 'ADJ-3', 10);
const product = async (p) => (await call('GET', `/api/products/${p.id}`)).data;

/* ------------------------------------------------------------------------ */
console.log('\n[a multi-line adjustment document]');
const doc = await call('POST', '/api/adjustments', {
  date: '2026-09-10', reason: 'Stock count', note: 'Aisle 3',
  items: [
    { product_id: soap.id, counted: 47 },     // three missing
    { product_id: salt.id, qty: 5 },          // five found
    { product_id: oil.id, counted: 10 },      // matched: no change
  ],
});
check('it is saved', doc.status === 200, JSON.stringify(doc.data));
check('with a document number', /^ADJ-\d{6}$/.test(doc.data.doc_no), doc.data.doc_no);
check('only the lines that change stock are kept', doc.data.items.length === 2, JSON.stringify(doc.data.items));
check('a count becomes a change against the balance', near(doc.data.items.find((i) => i.product_id === soap.id).qty, -3));
check('the balance before is recorded', near(doc.data.items.find((i) => i.product_id === soap.id).stock_before, 50));
check('soap stock is now 47', near((await product(soap)).stock, 47));
check('salt stock is now 35', near((await product(salt)).stock, 35));
check('oil is untouched', near((await product(oil)).stock, 10));
check('cost does not change', near((await product(soap)).cost, 2) && near((await product(salt)).cost, 2));
const move = (await product(soap)).history.find((m) => m.kind === 'adjust');
check('the movement points at the document and says why',
  move.ref_table === 'adjustments' && move.note.includes(doc.data.doc_no) && move.note.includes('Stock count'), JSON.stringify(move));
check('and carries the document date', move.created_at.startsWith('2026-09-10'));

const list = (await call('GET', '/api/adjustments?from=2026-09-01&to=2026-09-30&type=adjustment')).data;
check('the list shows it with its totals',
  list.length === 1 && near(list[0].qty_in, 5) && near(list[0].qty_out, 3) && near(list[0].value, 4), JSON.stringify(list[0]));
check('it can be found by product name', (await call('GET', '/api/adjustments?from=2026-09-01&to=2026-09-30&type=adjustment&search=Salt')).data.length === 1);

console.log('\n[refusals]');
const code = async (body) => (await call('POST', '/api/adjustments', body)).data.code;
check('an empty document', (await code({ items: [] })) === 'ADJUST_EMPTY');
check('nothing changing', (await code({ items: [{ product_id: oil.id, counted: 10 }] })) === 'ADJUST_ZERO');
check('the same product twice', (await code({ items: [{ product_id: oil.id, qty: 1 }, { product_id: oil.id, qty: 2 }] })) === 'ADJUST_DUPLICATE');
check('a negative count', (await code({ items: [{ product_id: oil.id, counted: -1 }] })) === 'COUNT_NEGATIVE');
check('refusals changed nothing', near((await product(oil)).stock, 10));

console.log('\n[the product screen adjustment is a document too]');
const single = (await call('POST', `/api/products/${oil.id}/adjust`, { qty: -2, note: 'Damaged' })).data;
check('it returns the new stock', near(single.stock, 8));
check('and the document it made', /^ADJ-/.test(single.adjustment?.doc_no || ''), JSON.stringify(single.adjustment));
const singleDoc = (await call('GET', `/api/adjustments/${single.adjustment.id}`)).data;
check('which has the one line and the reason', singleDoc.items.length === 1 && singleDoc.reason === 'Damaged');

console.log('\n[deleting reverses it]');
await call('DELETE', `/api/adjustments/${doc.data.id}`);
check('soap is back to 50', near((await product(soap)).stock, 50));
check('salt is back to 30', near((await product(salt)).stock, 30));
check('the document is gone', (await call('GET', `/api/adjustments/${doc.data.id}`)).status === 404);

/* ------------------------------------------------------------------------ */
console.log('\n[a cashier works the till and nothing else]');
await call('POST', '/api/entities/customer', { name: 'Regular Rana', phone: '70 123 456' });
await call('POST', '/api/users', { username: 'till3', password: 'test1234', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'till3', password: 'test1234' });

const products = await call('GET', '/api/products?search=Adj');
check('can search products', products.status === 200 && products.data.length === 3);
check('but sees no cost, value or margin',
  products.data.every((p) => !('cost' in p) && !('stock_value' in p) && !('margin' in p) && 'price' in p && 'stock' in p),
  JSON.stringify(products.data[0]));
check('can scan a barcode', (await call('GET', '/api/products/lookup?code=ADJ-1')).status === 200);
check('can see saved customers', (await call('GET', '/api/entities/customer')).data.some((c) => c.name === 'Regular Rana'));
const sale = await call('POST', '/api/sales', { customer: 'Regular Rana', paid: 2, items: [{ product_id: soap.id, qty: 1, unit_price: 5 }] });
check('can sell', sale.status === 200, JSON.stringify(sale.data));
check('the sale comes back without cost or profit', !('cogs' in sale.data) && !('profit' in sale.data) &&
  sale.data.items.every((i) => !('unit_cost' in i)), JSON.stringify(sale.data));
check('can take a payment on it', (await call('POST', `/api/sales/${sale.data.id}/payments`, { amount: 3 })).status === 200);
const sales = await call('GET', '/api/sales');
check('can list sales, without cost or profit', sales.status === 200 && sales.data.every((s) => !('cogs' in s) && !('profit' in s)));
check('can read settings for the receipt', (await call('GET', '/api/settings')).status === 200);
check('cannot void a sale', (await call('DELETE', `/api/sales/${sale.data.id}`)).status === 400);

const denied = [
  ['GET', '/api/reports/dashboard'],
  ['GET', '/api/reports/pnl'],
  ['GET', '/api/purchases'],
  ['POST', '/api/purchases', { items: [{ product_id: soap.id, qty: 1, unit_cost: 1 }] }],
  ['GET', '/api/adjustments'],
  ['POST', '/api/adjustments', { items: [{ product_id: soap.id, qty: -40 }] }],
  ['POST', `/api/products/${soap.id}/adjust`, { qty: -40 }],
  ['GET', `/api/products/${soap.id}`],
  ['POST', '/api/products', { name: 'Sneaky', price: 1 }],
  ['PUT', `/api/products/${soap.id}`, { price: 0.01 }],
  ['GET', '/api/expenses'],
  ['POST', '/api/expenses', { amount: 50 }],
  ['GET', '/api/users'],
  ['PUT', '/api/settings', { store_name: 'Mine' }],
  ['GET', '/api/backup'],
  ['POST', '/api/entities/customer', { name: 'X' }],
];
for (const [method, path, body] of denied) {
  const res = await call(method, path, body);
  check(`cannot ${method} ${path}`, res.status === 403 && res.data?.code === 'ADMIN_ONLY', `${res.status} ${JSON.stringify(res.data).slice(0, 80)}`);
}
check('and none of that moved stock', near((await (async () => { cookie = admin; return product(soap); })()).stock, 49));

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
