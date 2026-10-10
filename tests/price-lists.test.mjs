/**
 * Price lists: one shop, more than one price for the same product — and a shop
 * that never makes a second list carries on exactly as before.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'pricelistdata');
const PORT = 4575;
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
const tea = (await call('POST', '/api/products', { name: 'List Tea', barcode: 'PL-T', cost: 4, price: 10, opening_stock: 100 })).data;
const jam = (await call('POST', '/api/products', { name: 'List Jam', barcode: 'PL-J', cost: 2, price: 6, opening_stock: 100 })).data;

console.log('\n[a shop starts with one list]');
let lists = await get('/api/price-lists');
check('the default list is there from the start', lists.length === 1 && lists[0].is_default === true && lists[0].active === true,
  JSON.stringify(lists));
const retail = lists[0];
check('it serves both selling and buying', retail.use_for === 'both');
check('and it cannot be removed', (await call('DELETE', `/api/price-lists/${retail.id}`)).data.code === 'LIST_DEFAULT');
check('a product priced on it is simply the product price',
  near((await get(`/api/products?search=List Tea&price_list=${retail.id}`))[0].price, 10));

console.log('\n[a wholesale list]');
let r = await call('POST', '/api/price-lists', { name: 'جملة', use_for: 'sell' });
const whole = r.data;
check('a new list is made and numbered', r.status === 200 && whole.id !== retail.id && whole.is_default === false, JSON.stringify(r.data));
check('two lists cannot share a name', (await call('POST', '/api/price-lists', { name: 'جملة' })).data.code === 'LIST_EXISTS');

await call('PUT', `/api/products/${tea.id}`, { prices: { [whole.id]: 8 } });
let one = await get(`/api/products/${tea.id}`);
check('a product keeps its price on the list', one.prices.length === 1 && near(one.prices[0].price, 8), JSON.stringify(one.prices));
check('its own price is untouched', near(one.price, 10));

const onList = await get(`/api/products?search=List&price_list=${whole.id}`);
const teaRow = onList.find((p) => p.id === tea.id);
const jamRow = onList.find((p) => p.id === jam.id);
check('the list price comes back beside the product price', near(teaRow.list_price, 8) && near(teaRow.price, 10),
  JSON.stringify({ list: teaRow.list_price, own: teaRow.price }));
check('a product the list does not name has no list price', jamRow.list_price === null, String(jamRow.list_price));
check('a scan can ask for the list too', near((await get(`/api/products/lookup?code=PL-T&price_list=${whole.id}`)).list_price, 8));

console.log('\n[selling on a list]');
r = await call('POST', '/api/sales', {
  customer: 'Wholesale Walid', price_list_id: whole.id, tax: 0,
  items: [{ product_id: tea.id, qty: 10, unit_price: 8 }],
});
check('the sale is kept with the list it was priced at', r.status === 200 && r.data.price_list_id === whole.id,
  JSON.stringify({ id: r.data.price_list_id, total: r.data.total }));
check('and sells at the list price', near(r.data.total, 80), String(r.data.total));
const plain = (await call('POST', '/api/sales', { tax: 0, items: [{ product_id: tea.id, qty: 1, unit_price: 10 }] })).data;
check('a sale with no list is still a sale', plain.price_list_id === null, String(plain.price_list_id));

console.log('\n[a customer served at their own list]');
// Selling to them already put them in the directory; now they are given a list.
const customers = await get('/api/entities/customer');
const walid = (customers.rows || customers).find((e) => e.name === 'Wholesale Walid');
let saved = (await call('PUT', `/api/entities/customer/${walid.id}`, { name: 'Wholesale Walid', price_list_id: whole.id })).data;
check('the customer carries the list', saved.price_list_id === whole.id, JSON.stringify(saved));
await call('PUT', `/api/entities/customer/${walid.id}`, { name: 'Wholesale Walid', price_list_id: '' });
const after = await get('/api/entities/customer');
check('and can be put back on the default', (after.rows || after).find((e) => e.id === walid.id).price_list_id === null);

console.log('\n[a list for buying]');
const supplierList = (await call('POST', '/api/price-lists', { name: 'Fares cost', use_for: 'buy' })).data;
await call('PUT', `/api/products/${tea.id}`, { prices: { [supplierList.id]: 3.5 } });
const forSale = await get('/api/price-lists?use=sell');
const forBuy = await get('/api/price-lists?use=buy');
check('a selling list is not offered when buying', !forBuy.some((l) => l.id === whole.id) && forBuy.some((l) => l.id === supplierList.id),
  JSON.stringify(forBuy.map((l) => l.name)));
check('and a buying list is not offered when selling', !forSale.some((l) => l.id === supplierList.id) && forSale.some((l) => l.id === whole.id),
  JSON.stringify(forSale.map((l) => l.name)));
check('the default list is offered either way', forSale.some((l) => l.is_default) && forBuy.some((l) => l.is_default));
r = await call('POST', '/api/purchases', {
  supplier: 'Fares', price_list_id: supplierList.id,
  items: [{ product_id: tea.id, qty: 10, unit_cost: 3.5 }],
});
check('a purchase keeps the list it was bought on', r.status === 200 && r.data.price_list_id === supplierList.id,
  JSON.stringify(r.data.price_list_id));

console.log('\n[filling a list in one place]');
const sheet = await get(`/api/price-lists/${whole.id}/products`);
check('every product is listed with its price on the list', sheet.length === 2 &&
  near(sheet.find((p) => p.id === tea.id).list_price, 8) && sheet.find((p) => p.id === jam.id).list_price === null,
  JSON.stringify(sheet.map((p) => [p.name, p.list_price])));
check('a list counts what it prices', (await get('/api/price-lists')).find((l) => l.id === whole.id).priced === 1);

console.log('\n[taking a price back off a list]');
await call('PUT', `/api/products/${tea.id}`, { prices: { [whole.id]: '' } });
one = await get(`/api/products/${tea.id}`);
check('an empty price removes it, so the product falls back to its own',
  one.prices.every((p) => p.list_id !== whole.id), JSON.stringify(one.prices));

console.log('\n[removing a list]');
await call('PUT', `/api/products/${jam.id}`, { prices: { [whole.id]: 5 } });
check('removing a list takes its prices with it',
  (await call('DELETE', `/api/price-lists/${whole.id}`)).status === 200 &&
  (await get(`/api/products/${jam.id}`)).prices.length === 0);
check('the sale made on it is untouched', near((await get(`/api/sales/${(await get('/api/sales?limit=5'))[1].id}`)).total, 80) ||
  near((await get(`/api/sales?limit=5`))[1].total, 80));

console.log('\n[a cashier]');
await call('POST', '/api/users', { username: 'till3', password: 'pass3', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'till3', password: 'pass3' });
check('a cashier can read the lists', Array.isArray(await get('/api/price-lists')));
check('but cannot make one', (await call('POST', '/api/price-lists', { name: 'Sneaky' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
