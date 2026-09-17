/**
 * How people pay is a list the shop keeps: Cash and On account are always there
 * (they can be switched off, never renamed or removed), and a shop adds its own —
 * Whish, OMT, a card machine — each with an icon for the till.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'methodsdata');
const PORT = 4563;
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
const get = async (path) => (await call('GET', path)).data;
const methods = () => get('/api/entities/payment_method?all=1');

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

console.log('\n[what a shop starts with]');
let list = await methods();
check('Cash and On account come first, then the rest', list.slice(0, 2).map((m) => m.name).join() === 'cash,credit',
  list.map((m) => m.name).join());
check('and they are marked as built in', list.slice(0, 2).every((m) => m.builtin === 1));
check('Whish and OMT are there, each wearing its own mark',
  list.find((m) => m.name === 'Whish')?.icon === 'whish' && list.find((m) => m.name === 'OMT')?.icon === 'omt',
  JSON.stringify(list.map((m) => [m.name, m.icon])));
check('the others are ordinary entries', list.find((m) => m.name === 'card')?.builtin === 0);

console.log('\n[a shop adds its own]');
let r = await call('POST', '/api/entities/payment_method', { name: 'Bank cheque', icon: 'bank' });
check('a new method saves with its icon', r.status === 200 && r.data.icon === 'bank', JSON.stringify(r.data));
const cheque = r.data;
check('the same name twice is refused', (await call('POST', '/api/entities/payment_method', { name: 'bank cheque' })).status === 400);

console.log('\n[built-in entries hold their ground]');
const cash = (await methods()).find((m) => m.name === 'cash');
r = await call('PUT', `/api/entities/payment_method/${cash.id}`, { name: 'Money', icon: 'coins' });
check('Cash cannot be renamed', r.status === 400 && r.data.code === 'BUILTIN_ENTRY', JSON.stringify(r.data));
r = await call('DELETE', `/api/entities/payment_method/${cash.id}`);
check('nor removed', r.status === 400 && r.data.code === 'BUILTIN_ENTRY');
r = await call('PUT', `/api/entities/payment_method/${cash.id}`, { name: 'cash', icon: 'wallet', active: false });
check('but it can be switched off, and change its icon', r.status === 200 && r.data.active === 0 && r.data.icon === 'wallet');
check('switched off, it is no longer offered', !(await get('/api/entities/payment_method')).some((m) => m.name === 'cash'));
await call('PUT', `/api/entities/payment_method/${cash.id}`, { name: 'cash', icon: 'coins', active: true });

console.log('\n[a method in use]');
const tea = (await call('POST', '/api/products', { name: 'Method Tea', barcode: 'MT-1', cost: 2, price: 5, opening_stock: 50 })).data;
const sale = (await call('POST', '/api/sales', { method: 'Whish', tax: 0, items: [{ product_id: tea.id, qty: 2, unit_price: 5 }] })).data;
await call('POST', '/api/expenses', { category: 'Transport', amount: 7, method: 'Whish' });
check('a sale and an expense can be paid by a custom method', sale.method === 'Whish');
const whish = (await methods()).find((m) => m.name === 'Whish');
check('the list counts where it is used', whish.in_use === 3, String(whish.in_use)); // the sale, its payment, the expense

r = await call('PUT', `/api/entities/payment_method/${whish.id}`, { name: 'Whish Money', icon: 'phone' });
check('renaming it corrects the documents that used it', r.status === 200 &&
  (await get(`/api/sales/${sale.id}`)).method === 'Whish Money' &&
  (await get(`/api/sales/${sale.id}`)).payments[0].method === 'Whish Money', JSON.stringify(r.data));
check('and the expenses too', (await get('/api/expenses?page=1&per=10')).rows[0].method === 'Whish Money');

r = await call('DELETE', `/api/entities/payment_method/${cheque.id}`);
check('an unused method of your own can be removed', r.status === 200 && r.data.deleted === true);

console.log('\n[at the till]');
await call('POST', '/api/users', { username: 'till1', password: 'pass1', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'till1', password: 'pass1' });
check('a cashier is given the list to sell with', (await get('/api/entities/payment_method')).some((m) => m.name === 'Whish Money'));
check('but cannot change it', (await call('POST', '/api/entities/payment_method', { name: 'Sneaky' })).status === 403 ||
  (await call('PUT', `/api/entities/payment_method/${whish.id}`, { name: 'Sneaky' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
