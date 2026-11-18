/**
 * The product list's filter builder: field, operator and value, all of which
 * must hold — and nothing typed ever reaching the database as SQL.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'filtersdata');
const PORT = 4633;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

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
const names = async (filters, extra = '') => {
  const r = await call('GET', `/api/products?page=1&per=100${extra}&filters=${encodeURIComponent(JSON.stringify(filters))}`);
  return r.status === 200 ? r.data.rows.map((p) => p.name).sort().join(',') : `${r.status} ${r.data.code}`;
};

try {
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  for (const p of [
    { name: 'Mango Juice', category: 'Juices', price: 4, cost: 1, opening_stock: 10, barcode: '111' },
    { name: 'Orange Juice', category: 'Juices', price: 3, cost: 1, opening_stock: 0 },
    { name: 'Nutella Crêpe', category: 'Crêpes', price: 5, cost: 1.5, opening_stock: 4, description: '50% off' },
    { name: 'Water', category: '', price: 1, cost: 0.2, opening_stock: 30 },
  ]) await call('POST', '/api/products', p);
  const old = (await call('POST', '/api/products', { name: 'Old Juice', category: 'Juices', price: 9, cost: 1 })).data;
  await call('PUT', `/api/products/${old.id}`, { active: false });

  console.log('\n[text]');
  check('contains', (await names([{ field: 'name', op: 'like', value: 'juice' }])) === 'Mango Juice,Orange Juice');
  check('equals, whatever the case', (await names([{ field: 'category', op: 'eq', value: 'juices' }])) === 'Mango Juice,Orange Juice');
  check('not equal', (await names([{ field: 'category', op: 'neq', value: 'Juices' }])) === 'Nutella Crêpe,Water');
  check('starts with', (await names([{ field: 'name', op: 'starts', value: 'nut' }])) === 'Nutella Crêpe');
  check('does not contain', (await names([{ field: 'name', op: 'not_like', value: 'juice' }])) === 'Nutella Crêpe,Water');
  check('is empty / is set', (await names([{ field: 'category', op: 'not_set' }])) === 'Water' && (await names([{ field: 'barcode', op: 'set' }])) === 'Mango Juice');
  check('a typed % is a percent sign, not "anything"', (await names([{ field: 'description', op: 'like', value: '50%' }])) === 'Nutella Crêpe'
    && (await names([{ field: 'description', op: 'like', value: '%' }])) === 'Nutella Crêpe');

  console.log('\n[numbers]');
  check('price > 3', (await names([{ field: 'price', op: 'gt', value: '3' }])) === 'Mango Juice,Nutella Crêpe');
  check('price ≤ 3', (await names([{ field: 'price', op: 'lte', value: '3' }])) === 'Orange Juice,Water');
  check('stock = 0', (await names([{ field: 'stock', op: 'eq', value: '0' }])) === 'Orange Juice');
  check('margin ≥ 75%', (await names([{ field: 'margin', op: 'gte', value: '75' }])) === 'Mango Juice,Water');
  check('stock value < 10', (await names([{ field: 'stock_value', op: 'lt', value: '10' }])) === 'Nutella Crêpe,Orange Juice,Water');
  const r = await call('GET', `/api/products?page=1&filters=${encodeURIComponent(JSON.stringify([{ field: 'price', op: 'gt', value: 'abc' }]))}`);
  check('a number filter needs a number', r.status === 400 && r.data.code === 'FILTER_NUMBER');

  console.log('\n[together, and with the other filters]');
  check('every condition must hold', (await names([{ field: 'category', op: 'eq', value: 'Juices' }, { field: 'stock', op: 'gt', value: '0' }])) === 'Mango Juice');
  check('and the search narrows further', (await names([{ field: 'price', op: 'gte', value: '1' }], '&search=orange')) === 'Orange Juice');
  check('archived items are left out, as ever', !(await names([{ field: 'category', op: 'eq', value: 'Juices' }])).includes('Old'));
  check('unless the filter asks about Active itself', (await names([{ field: 'active', op: 'is', value: '0' }])) === 'Old Juice');

  console.log('\n[nothing typed becomes SQL]');
  check('an unknown field is refused', (await names([{ field: 'name) OR 1=1 --', op: 'like', value: 'x' }])) === '400 FILTER_INVALID');
  check('so is an unknown operator', (await names([{ field: 'price', op: '> 0 OR 1', value: '1' }])) === '400 FILTER_INVALID');
  check('a value is only ever a value', (await names([{ field: 'name', op: 'eq', value: "x' OR '1'='1" }])) === '');
  const bad = await call('GET', '/api/products?page=1&filters=not-json');
  check('filters that are not JSON are refused', bad.status === 400 && bad.data.code === 'FILTER_INVALID');
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
