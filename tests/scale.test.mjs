/** Labels printed by a weighing scale: prefix, item code, weight or price, check digit. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ean13Check } from '../server/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'scaledata');
const PORT = 4547;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b, eps = 0.0011) => Math.abs(Number(a) - Number(b)) < eps;
/** A scale label: prefix + item + value, with its check digit worked out. */
const label = (prefix, item, value, itemDigits = 5) => {
  const body = `${prefix}${String(item).padStart(itemDigits, '0')}${String(value).padStart(10 - itemDigits, '0')}`;
  return body + ean13Check(body);
};

check('the check digit of a well-known code', ean13Check('590123412345') === '7');
check('…and of the study\'s example, 21 00123 01234', ean13Check('210012301234') === '3');

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
const lookup = (code) => call('GET', `/api/products/lookup?code=${code}`);

const cheese = (await call('POST', '/api/products', { name: 'Akkawi cheese', barcode: '00123', unit: 'kg', cost: 6, price: 9.5, opening_stock: 20 })).data;
const olives = (await call('POST', '/api/products', { name: 'Green olives', barcode: '45', unit: 'kg', cost: 3, price: 5, opening_stock: 20 })).data;
// A real product whose EAN happens to start with 21 — the clash the setting must refuse.
const cola = (await call('POST', '/api/products', { name: 'Cola 21', barcode: label('21', 5, 99), unit: 'pcs', cost: 0.5, price: 1 })).data;
check('three products, one with a 13-digit code starting 21', cheese.id && olives.id && cola.barcode.length === 13);

console.log('\n[switching it on]');
check('off by default: a label is just an unknown code', (await lookup(label('21', 123, 1234))).data.code === 'NO_PRODUCT_MATCH');
let r = await call('PUT', '/api/settings', { scale_enabled: '1', scale_prefix: '21' });
check('refused while a product barcode would read as a weight', r.status === 400 && r.data.code === 'SCALE_PREFIX_TAKEN' && r.data.params.n === 1, JSON.stringify(r.data));
r = await call('PUT', '/api/settings', { scale_enabled: '1', scale_prefix: '2x' });
check('the prefix is two digits', r.status === 400 && r.data.code === 'SCALE_PREFIX_DIGITS');
r = await call('PUT', '/api/settings', { scale_enabled: '1', scale_prefix: '22' });
check('another prefix is accepted', r.status === 200 && r.data.scale_enabled === '1' && r.data.scale_prefix === '22' && r.data.scale_item_digits === '5', JSON.stringify(r.data.scale_prefix));
await call('PUT', '/api/products/' + cola.id, { barcode: '5000000000001' });
r = await call('PUT', '/api/settings', { scale_prefix: '21' });
check('…and 21 once that barcode is changed', r.status === 200 && r.data.scale_prefix === '21');

console.log('\n[weight labels]');
r = await lookup(label('21', 123, 1234));
check('21 00123 01234 rings up the cheese at 1.234 kg', r.status === 200 && r.data.id === cheese.id && near(r.data.scale.qty, 1.234), JSON.stringify(r.data.scale));
r = await lookup(label('21', 45, 500));
check('an item code typed without leading zeros still matches', r.data.id === olives.id && near(r.data.scale.qty, 0.5), JSON.stringify(r.data.scale));
const bad = label('21', 123, 1234).slice(0, 12) + ((Number(label('21', 123, 1234)[12]) + 1) % 10);
check('a wrong check digit is refused rather than guessed', (await lookup(bad)).data.code === 'NO_PRODUCT_MATCH');
check('a label for an unknown item is refused', (await lookup(label('21', 999, 100))).data.code === 'NO_PRODUCT_MATCH');
check('an ordinary 13-digit barcode still matches its product', (await lookup('5000000000001')).data.id === cola.id);
check('the product\'s own code still works on its own', (await lookup('00123')).data.id === cheese.id && !(await lookup('00123')).data.scale);

console.log('\n[price labels]');
await call('PUT', '/api/settings', { scale_mode: 'price' });
r = await lookup(label('21', 123, 475));
check('the label\'s $4.75 becomes 0.5 kg of cheese at $9.50', r.data.id === cheese.id && near(r.data.scale.qty, 0.5) && near(r.data.scale.total, 4.75), JSON.stringify(r.data.scale));
await call('PUT', '/api/settings', { scale_mode: 'weight', scale_item_digits: '4' });
r = await lookup(label('21', 123, 250, 4));
check('four item digits leave six for the weight: 21 0123 000250 is 0.25 kg', r.data.id === cheese.id && near(r.data.scale.qty, 0.25), JSON.stringify(r.data.scale));

console.log('\n[sold by weight]');
await call('PUT', '/api/settings', { scale_item_digits: '5' });
const sale = (await call('POST', '/api/sales', { items: [{ product_id: cheese.id, qty: 1.234, unit_price: 9.5 }] })).data;
check('a sale of 1.234 kg keeps three decimals', near(sale.items[0].qty, 1.234) && near(sale.total, 11.72, 0.011), JSON.stringify([sale.items[0].qty, sale.total]));
check('…and the stock follows', near((await call('GET', `/api/products/${cheese.id}`)).data.stock, 18.766));

const cashier = (await call('POST', '/api/users', { username: 'till7', password: 'test1234', role: 'cashier' })).data;
cookie = '';
await call('POST', '/api/auth/login', { username: 'till7', password: 'test1234' });
check('a cashier can scan a label', cashier.id && (await lookup(label('21', 123, 1000))).data.scale?.qty === 1);
check('…but cannot change the setting', (await call('PUT', '/api/settings', { scale_enabled: '0' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
