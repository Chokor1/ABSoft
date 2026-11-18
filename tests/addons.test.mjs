/**
 * Add-ons and line notes: a crêpe with Lotus and banana, "cut in four" — and a
 * shop with no add-on list selling exactly as it always has.
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

console.log('\n[a shop with no add-ons is as it was]');
check('there are no add-on lists to start with', (await get('/api/addon-groups')).length === 0);
const pepsi = (await call('POST', '/api/products', { name: 'Pepsi', cost: 0.4, price: 1, opening_stock: 20 })).data;
check('a product offers no add-ons', pepsi.addon_group_id === null, String(pepsi.addon_group_id));
let r = await sell([{ product_id: pepsi.id, qty: 1, unit_price: 1 }]);
check('and its line has none, and no note', r.status === 200 && r.data.items[0].addons === '' && r.data.items[0].note === '',
  JSON.stringify(r.data.items?.[0]));

console.log('\n[a list of crêpe toppings]');
r = await call('POST', '/api/addon-groups', {
  name: 'Crêpe toppings',
  items: [
    { name: 'Lotus Biscuit', price: 1, cost: 0.25 },
    { name: 'Banana', price: 1 },
    { name: 'Kiwi', price: 1 },
  ],
});
const group = r.data;
check('a list is made with its toppings, in order', r.status === 200 && group.items.map((a) => a.name).join() === 'Lotus Biscuit,Banana,Kiwi',
  JSON.stringify(r.data));
check('a second list cannot take the same name', (await call('POST', '/api/addon-groups', { name: 'crêpe toppings' })).data.code === 'ADDON_GROUP_EXISTS');
check('a topping listed twice is refused',
  (await call('PUT', `/api/addon-groups/${group.id}`, { items: [{ name: 'Kiwi', price: 1 }, { name: 'kiwi', price: 1 }] })).data.code === 'ADDON_TWICE');
const [lotus, banana, kiwi] = group.items;

console.log('\n[offered on a whole category]');
const nutella = (await call('POST', '/api/products', { name: 'Nutella Crêpe', category: 'Crêpes', cost: 1.5, price: 5 })).data;
const kinder = (await call('POST', '/api/products', { name: 'Kinder Crêpe', category: 'Crêpes', cost: 1.5, price: 5 })).data;
const qashta = (await call('POST', '/api/products', { name: 'Qashta Cup', category: 'crêpes', cost: 1, price: 5 })).data;
r = await call('POST', `/api/addon-groups/${group.id}/apply`, { category: 'Crêpes' });
check('one click gives the list to every product in the category', r.status === 200 && r.data.applied === 3, JSON.stringify(r.data));
check('the products now offer it', (await get(`/api/products/${kinder.id}`)).addon_group_id === group.id);
r = await call('PUT', `/api/products/${qashta.id}`, { addon_group_id: '' });
check('and one product can be taken off it again', r.status === 200 && r.data.addon_group_id === null, String(r.data.addon_group_id));
check('a product outside the category is untouched', (await get(`/api/products/${pepsi.id}`)).addon_group_id === null);
check('the list counts the products offering it', (await get('/api/addon-groups')).find((g) => g.id === group.id).products === 2);

console.log('\n[a crêpe with toppings and a note]');
r = await sell([
  { product_id: nutella.id, qty: 2, unit_price: 7, addons: [lotus.id, banana.id], note: 'cut in four' },
  { product_id: nutella.id, qty: 1, unit_price: 5 },
]);
const sale = r.data;
const dressed = sale.items.find((i) => i.note);
const plain = sale.items.find((i) => !i.note);
check('the line keeps its toppings by name and price', r.status === 200 &&
  JSON.parse(dressed.addons).map((a) => `${a.name}:${a.price}`).join() === 'Lotus Biscuit:1,Banana:1', dressed?.addons);
check('and its note', dressed.note === 'cut in four');
check('the toppings\' cost counts in the profit', near(dressed.unit_cost, 1.5 + 0.25), String(dressed.unit_cost));
check('a crêpe with nothing on it is a plain line', plain.addons === '' && near(plain.unit_cost, 1.5));
check('and the sale adds up', near(sale.total, 2 * 7 + 5), String(sale.total));
check('a topping that does not exist is refused',
  (await sell([{ product_id: nutella.id, qty: 1, unit_price: 6, addons: [999999] }])).data.code === 'ADDON_UNKNOWN');
r = await sell([{ product_id: pepsi.id, qty: 1, unit_price: 1, note: 'no ice' }]);
check('any line can carry a note, toppings or not', r.status === 200 && r.data.items[0].note === 'no ice');

console.log('\n[the list changes later]');
await call('PUT', `/api/addon-groups/${group.id}`, {
  name: 'Toppings',
  items: [{ id: lotus.id, name: 'Lotus', price: 1.5, cost: 0.3 }, { id: kiwi.id, name: 'Kiwi', price: 1 }],
});
const later = await get('/api/addon-groups');
check('a topping can be renamed and repriced, and one removed',
  later[0].name === 'Toppings' && later[0].items.map((a) => `${a.name}:${a.price}`).join() === 'Lotus:1.5,Kiwi:1', JSON.stringify(later[0].items));
const old = await get(`/api/sales/${sale.id}`);
check('an old invoice still reads what was put on it', old.items.some((i) => i.addons.includes('Banana') && i.addons.includes('Lotus Biscuit')));

console.log('\n[a return keeps the toppings]');
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [{ item_id: dressed.id, qty: 1 }] });
check('the returned line names its toppings and note',
  r.status === 200 && r.data.items[0].addons.includes('Banana') && r.data.items[0].note === 'cut in four', JSON.stringify(r.data.items?.[0]));

console.log('\n[a held sale keeps them]');
r = await call('POST', '/api/held', { items: [
  { product_id: kinder.id, qty: 1, unit_price: 7.5, addons: [lotus.id, kiwi.id], note: 'extra crispy' },
] });
check('holding names the toppings', r.status === 200 && (await get('/api/held'))[0].summary.includes('Kinder Crêpe'));
const back = (await call('POST', `/api/held/${r.data.id}/resume`)).data;
check('resuming brings back the toppings and the note',
  back.items[0].addons.map((a) => a.name).join() === 'Lotus,Kiwi' && back.items[0].note === 'extra crispy' && near(back.items[0].unit_price, 7.5),
  JSON.stringify(back.items[0]));

console.log('\n[removing the list]');
r = await call('DELETE', `/api/addon-groups/${group.id}`);
check('a list can be removed', r.status === 200 && (await get('/api/addon-groups')).length === 0);
check('its products no longer offer add-ons', (await get(`/api/products/${nutella.id}`)).addon_group_id === null);
check('and old invoices still read their toppings', (await get(`/api/sales/${sale.id}`)).items.some((i) => i.addons.includes('Banana')));

console.log('\n[a cashier]');
await call('POST', '/api/addon-groups', { name: 'Shake extras', items: [{ name: 'Protein', price: 1 }] });
await call('POST', '/api/users', { username: 'till7', password: 'pass7', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'till7', password: 'pass7' });
check('a cashier can read the lists, to offer them at the till', (await get('/api/addon-groups')).length === 1);
check('but not change them', (await call('POST', '/api/addon-groups', { name: 'Sneaky' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
