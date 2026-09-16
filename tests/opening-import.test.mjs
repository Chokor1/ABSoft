/** Opening stock as a type of stock adjustment: a new product's opening quantity, by hand, and importing products. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'openingsdata');
const PORT = 4551;
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
const openings = () => get('/api/adjustments?page=1&per=50&type=opening');

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
check('there is no separate opening stock document any more', (await call('GET', '/api/openings')).status === 404);

/* ------------------------------------------------------------------------ */
console.log('\n[a new product with an opening quantity]');
const withStock = (await call('POST', '/api/products', { name: 'Opened Oil', barcode: 'OP-1', cost: 4, price: 6, opening_stock: 12 })).data;
check('the product starts with that stock', near(withStock.stock, 12));
const first = await openings();
check('a stock adjustment of type opening was written', first.total === 1 && first.rows[0].type === 'opening', JSON.stringify(first.rows));
const doc1 = await get(`/api/adjustments/${first.rows[0].id}`);
check('numbered like any adjustment, reason Opening stock', /^ADJ-\d{6}$/.test(doc1.doc_no) && doc1.reason === 'Opening stock', `${doc1.doc_no} ${doc1.reason}`);
check('with the quantity and the product\'s cost', near(doc1.items[0].qty, 12) && near(doc1.items[0].unit_cost, 4), JSON.stringify(doc1.items));
const move = (await get(`/api/products/${withStock.id}`)).history[0];
check('the movement is an opening, pointing at the adjustment', move.kind === 'opening' && move.ref_table === 'adjustments' && move.ref_id === doc1.id, JSON.stringify(move));
const noStock = (await call('POST', '/api/products', { name: 'Unopened Salt', barcode: 'OP-2', cost: 1, price: 2, opening_stock: 0 })).data;
check('with 0, no adjustment and no stock', near(noStock.stock, 0) && (await openings()).total === 1);
check('corrections and openings are told apart', (await get('/api/adjustments?page=1&per=50&type=adjustment')).total === 0);

/* ------------------------------------------------------------------------ */
console.log('\n[opening stock for several products at once]');
const made = await call('POST', '/api/adjustments', {
  type: 'opening', date: '2026-01-01', note: 'Start of year',
  items: [
    { product_id: noStock.id, qty: 40, unit_cost: 1.5 },
    { product_id: withStock.id, qty: 8, unit_cost: 5 },
  ],
});
check('it is saved', made.status === 200 && made.data.items.length === 2 && made.data.type === 'opening', JSON.stringify(made.data));
check('stock goes in', near((await get(`/api/products/${noStock.id}`)).stock, 40) && near((await get(`/api/products/${withStock.id}`)).stock, 20));
check('a product with nothing on hand takes the opening cost', near((await get(`/api/products/${noStock.id}`)).cost, 1.5));
check('a product with stock blends it (12 @ 4 + 8 @ 5 = 4.40)', near((await get(`/api/products/${withStock.id}`)).cost, 4.4),
  String((await get(`/api/products/${withStock.id}`)).cost));
check('a correction still leaves the cost alone',
  (await call('POST', '/api/adjustments', { items: [{ product_id: noStock.id, qty: -1 }] })).status === 200 &&
    near((await get(`/api/products/${noStock.id}`)).cost, 1.5));
check('a negative opening quantity is refused',
  (await call('POST', '/api/adjustments', { type: 'opening', items: [{ product_id: noStock.id, qty: -2 }] })).data.code === 'QTY_POSITIVE');
check('no quantities is refused', (await call('POST', '/api/adjustments', { type: 'opening', items: [{ product_id: noStock.id, qty: 0 }] })).data.code === 'OPENING_EMPTY');
await call('DELETE', `/api/adjustments/${made.data.id}`);
check('deleting takes the stock back out', near((await get(`/api/products/${noStock.id}`)).stock, -1) && near((await get(`/api/products/${withStock.id}`)).stock, 12));

/* ------------------------------------------------------------------------ */
console.log('\n[importing a file]');
const rows = [
  { name: 'Imported Rice 1kg', barcode: 'IM-1', category: 'Grocery', unit: 'pcs', cost: '1.10', price: '1.80', min_stock: '10', opening_stock: '50' },
  { name: 'Imported Sugar 1kg', barcode: 'IM-2', category: 'Grocery', unit: 'pcs', cost: '0,90', price: '1.40', opening_stock: '30' },
  { name: 'Imported Soap', barcode: 'IM-3', category: 'Cleaning', cost: '0.50', price: '1', opening_stock: '' },
  { name: '', barcode: 'IM-4', cost: '1' },
  { name: 'Bad Number', barcode: 'IM-5', cost: 'abc' },
  { name: 'Repeat', barcode: 'IM-1', cost: '1' },
  { name: 'Already Here', barcode: 'OP-2', cost: '1', opening_stock: '5' },
];
const dry = (await call('POST', '/api/products/import', { rows, dry_run: true })).data;
check('the check counts ready, skipped and wrong rows',
  dry.summary.ok === 3 && dry.summary.skip === 1 && dry.summary.error === 3, JSON.stringify(dry.summary));
check('and the opening quantities it will record', dry.summary.opening_lines === 2 && near(dry.summary.opening_qty, 80));
const byLine = Object.fromEntries(dry.rows.map((r) => [r.line, r]));
check('a missing name is an error on its line (line 5: header is line 1)', byLine[5].status === 'error' && byLine[5].code === 'IMPORT_NAME');
check('a word where a number goes is an error', byLine[6].code === 'IMPORT_NUMBER' && byLine[6].field === 'cost');
check('a barcode repeated in the file points at the first one', byLine[7].code === 'IMPORT_DUP_FILE' && byLine[7].other === 2);
check('a barcode already in ABSoft is skipped, not overwritten', byLine[8].status === 'skip' && byLine[8].code === 'IMPORT_EXISTS');
check('the check writes nothing', (await get('/api/products?search=Imported')).length === 0);

const before = (await openings()).total;
const done = (await call('POST', '/api/products/import', { rows, date: '2026-02-01', note: 'Import test.csv' })).data;
check('importing creates the ready products', done.summary.ok === 3 && (await get('/api/products?search=Imported')).length === 3);
check('comma decimals are read as decimals', near((await get('/api/products?search=Imported Sugar'))[0].cost, 0.9));
const after = await openings();
check('ONE opening stock adjustment for the whole file', after.total === before + 1, `${before} → ${after.total}`);
const importDoc = await get(`/api/adjustments/${done.opening.id}`);
check('holding every product that had a quantity', importDoc.type === 'opening' && importDoc.items.length === 2 && near(importDoc.qty_in, 80),
  JSON.stringify(importDoc.items));
check('with the date and note given', importDoc.date === '2026-02-01' && importDoc.note === 'Import test.csv');
check('stock follows', near((await get('/api/products?search=Imported Rice'))[0].stock, 50));
const noOpening = (await call('POST', '/api/products/import', { rows: [{ name: 'Plain Import', barcode: 'IM-9' }] })).data;
check('a file with no opening quantities writes no adjustment', noOpening.opening === null && (await openings()).total === after.total);

/* ------------------------------------------------------------------------ */
console.log('\n[a cashier]');
await call('POST', '/api/users', { username: 'opn-till', password: 'test1234', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'opn-till', password: 'test1234' });
check('cannot import', (await call('POST', '/api/products/import', { rows, dry_run: true })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
