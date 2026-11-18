/**
 * Add-ons as items: Lotus Biscuit and Banana, offered with the crêpes, each with
 * its own price, cost and stock — and a shop with no add-on selling as it always has.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'addonsdata');
const PORT = 4619;
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
const sell = (items, extra = {}) => call('POST', '/api/sales', { tax: 0, items, ...extra });

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const stockOf = async (p) => Number((await get(`/api/products/${p.id}`)).stock);

console.log('\n[a shop with no add-ons is as it was]');
check('there are no add-ons to start with', (await get('/api/addons')).length === 0);
const pepsi = (await call('POST', '/api/products', { name: 'Pepsi', cost: 0.4, price: 1, opening_stock: 20 })).data;
check('a product is not an add-on', pepsi.is_addon === 0);
let r = await sell([{ product_id: pepsi.id, qty: 1, unit_price: 1 }]);
check('and its line has no add-ons, and no note', r.status === 200 && r.data.items[0].addons === '' && r.data.items[0].note === '',
  JSON.stringify(r.data.items?.[0]));

console.log('\n[switched off, as every shop starts]');
check('add-ons are off by default', (await get('/api/settings')).addons === '0');
const early = (await call('POST', '/api/products', { name: 'Early topping', price: 1, is_addon: true })).data;
check('none is offered while it is off', (await get('/api/addons')).length === 0);
r = await sell([{ product_id: pepsi.id, qty: 1, unit_price: 2, addons: [early.id] }]);
check('nor sold on a line', r.status === 400 && r.data.code === 'ADDONS_OFF', JSON.stringify(r.data));
await call('DELETE', `/api/products/${early.id}`);
await call('PUT', '/api/settings', { addons: '1' });

console.log('\n[toppings are items]');
const nutella = (await call('POST', '/api/products', { name: 'Nutella Crêpe', category: 'Crêpes', cost: 1.5, price: 5, opening_stock: 0 })).data;
const lotusCrepe = (await call('POST', '/api/products', { name: 'Lotus Crêpe', category: 'Crêpes', cost: 1.5, price: 5 })).data;
const orange = (await call('POST', '/api/products', { name: 'Orange Juice', category: 'Juices', cost: 1, price: 3 })).data;
const lotus = (await call('POST', '/api/products', { name: 'Lotus Biscuit', category: 'Toppings', price: 1, cost: 0.25, opening_stock: 10, is_addon: true })).data;
check('an item can be an add-on', lotus.is_addon === 1);
let addons = await get('/api/addons');
check('offered with every item until told otherwise', addons.length === 1 && addons[0].scope === 'all', JSON.stringify(addons));
check('the till\'s cards leave it out', !(await get('/api/products?sale=1&templates=1&limit=50')).some((p) => p.id === lotus.id));
check("nor its category a chip on the till's row", !(await get('/api/categories/in-use?sale=1&templates=1')).some((c) => c.name === 'Toppings'));
check('everywhere else it is an item like any', (await get('/api/products?limit=50')).some((p) => p.id === lotus.id));

r = await call('PUT', `/api/products/${lotus.id}/addon-for`, { scope: 'categories', categories: [] });
check('some categories means at least one', r.status === 400 && r.data.code === 'ADDON_SCOPE_EMPTY');
r = await call('PUT', `/api/products/${lotus.id}/addon-for`, { scope: 'categories', categories: ['crêpes'] });
check('offered with the Crêpes', r.status === 200 && r.data.scope === 'categories' && r.data.categories.join() === 'crêpes', JSON.stringify(r.data));
r = await call('PUT', `/api/products/${pepsi.id}/addon-for`, { scope: 'all' });
check('only an add-on is offered with anything', r.status === 400 && r.data.code === 'NOT_ADDON');

const banana = (await call('POST', '/api/products', { name: 'Banana', category: 'Toppings', price: 1, cost: 0.3, opening_stock: 10, is_addon: true })).data;
r = await call('PUT', `/api/products/${banana.id}/addon-for`, { scope: 'products', product_ids: [lotusCrepe.id, banana.id] });
check('Banana goes with the Lotus Crêpe only (and never with itself)', r.status === 200 && r.data.products.map((p) => p.name).join() === 'Lotus Crêpe', JSON.stringify(r.data));
addons = await get('/api/addons');
check('the till reads both, with what they go with', addons.length === 2 && addons.find((a) => a.id === banana.id).product_ids.join() === String(lotusCrepe.id));

console.log('\n[sold on a line]');
r = await sell([{ product_id: lotusCrepe.id, qty: 2, unit_price: 7, addons: [lotus.id, banana.id], note: 'cut in four' }]);
check('a Lotus Crêpe with Lotus and Banana, cut in four', r.status === 200, JSON.stringify(r.data));
const line = r.data.items[0];
check('the line keeps them by name and price', JSON.parse(line.addons).map((a) => `${a.name}:${a.price}`).join() === 'Lotus Biscuit:1,Banana:1' && line.note === 'cut in four',
  line.addons);
check('their costs are the line\'s cost: 1.50 + 0.25 + 0.30', near(line.unit_cost, 2.05), String(line.unit_cost));
check('and their stock moves: two of each', (await stockOf(lotus)) === 8 && (await stockOf(banana)) === 8);
r = await sell([{ product_id: nutella.id, qty: 1, unit_price: 6, addons: [banana.id] }]);
check('Banana is not offered with the Nutella Crêpe', r.status === 400 && r.data.code === 'ADDON_NOT_OFFERED', JSON.stringify(r.data));
r = await sell([{ product_id: orange.id, qty: 1, unit_price: 4, addons: [lotus.id] }]);
check('nor Lotus with a juice', r.status === 400 && r.data.code === 'ADDON_NOT_OFFERED');
r = await sell([{ product_id: orange.id, qty: 1, unit_price: 4, addons: [pepsi.id] }]);
check('an item that is not an add-on is refused', r.status === 400 && r.data.code === 'ADDON_UNKNOWN');

console.log('\n[held]');
r = await call('POST', '/api/held', { items: [{ product_id: lotusCrepe.id, qty: 1, unit_price: 6, addons: [lotus.id], note: 'warm' }] });
check('a held line keeps its add-ons and note', r.status === 200, JSON.stringify(r.data));
const back = (await call('POST', `/api/held/${r.data.id}/resume`)).data;
check('and brings them back, with what decides which add-ons the line offers',
  back.items[0].addons[0].name === 'Lotus Biscuit' && back.items[0].note === 'warm' && back.items[0].category === 'Crêpes', JSON.stringify(back.items[0]));

console.log('\n[an add-on made to order, with a recipe]');
await call('PUT', '/api/settings', { recipes: '1' });
const spread = (await call('POST', '/api/products', { name: 'Nutella spread', unit: 'kg', cost: 9, raw: true, opening_stock: 3 })).data;
const drizzle = (await call('POST', '/api/products', { name: 'Nutella drizzle', price: 1, is_addon: true, made_to_order: true })).data;
await call('PUT', `/api/products/${drizzle.id}/recipe`, { lines: [{ ingredient_id: spread.id, qty: 0.02 }] });
r = await sell([{ product_id: nutella.id, qty: 3, unit_price: 6, addons: [drizzle.id] }]);
check('sold on three crêpes', r.status === 200, JSON.stringify(r.data));
check('its recipe is the cost: 1.50 + 0.18', near(r.data.items[0].unit_cost, 1.68), String(r.data.items[0].unit_cost));
const use = (await get('/api/consumption/ingredients')).find((i) => i.id === spread.id);
check('and what it used waits for the reconciliation: 0.06 kg', use && near(use.suggested, 0.06), JSON.stringify(use));
check('its own stock does not move', (await stockOf(drizzle)) === 0);
await call('PUT', '/api/settings', { recipes: '0' });

console.log('\n[a cashier]');
await call('POST', '/api/users', { username: 'till7', password: 'pass7', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'till7', password: 'pass7' });
check('a cashier reads the add-ons, to offer them at the till', (await get('/api/addons')).length === 3);
check('but does not change what they go with', (await call('PUT', `/api/products/${lotus.id}/addon-for`, { scope: 'all' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
