/**
 * Sizes: one product sold as S, M, L or Bottle, each at its own price — and a
 * product without sizes selling exactly as it always has.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'sizesdata');
const PORT = 4613;
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

console.log('\n[a product without sizes is as it was]');
const pepsi = (await call('POST', '/api/products', { name: 'Pepsi', barcode: 'SZ-P', cost: 0.4, price: 1, opening_stock: 50 })).data;
check('it has no sizes', Array.isArray(pepsi.sizes) && pepsi.sizes.length === 0, JSON.stringify(pepsi.sizes));
let r = await sell([{ product_id: pepsi.id, qty: 2, unit_price: 1 }]);
check('and sells exactly as before, with no size on the line',
  r.status === 200 && r.data.items[0].size === '' && r.data.items[0].size_id === null && near(r.data.items[0].unit_cost, 0.4),
  JSON.stringify(r.data.items?.[0]));

console.log('\n[a juice in four sizes]');
r = await call('POST', '/api/products', {
  name: 'Mango', category: 'Juices', cost: 1, price: 3,
  sizes: [
    { name: 'S', price: 3, cost: 0.7 },
    { name: 'M', price: 4 },
    { name: 'L', price: 5, cost: 1.11 },
    { name: 'Bottle', price: 8, cost: 2 },
  ],
});
const mango = r.data;
check('a product is made with its sizes, in the order given',
  r.status === 200 && mango.sizes.map((z) => z.name).join() === 'S,M,L,Bottle', JSON.stringify(mango.sizes));
check('each with its price and cost', near(mango.sizes[2].price, 5) && near(mango.sizes[2].cost, 1.11) && near(mango.sizes[1].cost, 0));
const sz = Object.fromEntries(mango.sizes.map((z) => [z.name, z]));
const listed = (await get('/api/products?search=Mango&limit=5')).find((p) => p.id === mango.id);
check('the till gets the sizes with the product', listed.sizes.length === 4, JSON.stringify(listed.sizes));
const scanned = (await call('PUT', `/api/products/${mango.id}`, { barcode: 'SZ-M' })).data;
check('an edit that leaves the sizes out keeps them', scanned.sizes.length === 4);
check('and a scan finds them too', (await get('/api/products/lookup?code=SZ-M')).sizes.length === 4);
check('one size twice is refused',
  (await call('PUT', `/api/products/${mango.id}`, { sizes: [{ name: 'L', price: 5 }, { name: 'l', price: 6 }] })).data.code === 'SIZE_TWICE');

console.log('\n[selling in a size]');
r = await sell([
  { product_id: mango.id, size_id: sz.L.id, qty: 2, unit_price: 5 },
  { product_id: mango.id, size_id: sz.M.id, qty: 1, unit_price: 4 },
]);
const sale = r.data;
const lineL = sale.items.find((i) => i.size === 'L');
const lineM = sale.items.find((i) => i.size === 'M');
check('each line keeps its size', r.status === 200 && lineL && lineM && lineL.size_id === sz.L.id, JSON.stringify(sale.items));
check('a size with its own cost makes the profit', near(lineL.unit_cost, 1.11), String(lineL.unit_cost));
check('a size without one falls back to the product cost', near(lineM.unit_cost, 1), String(lineM.unit_cost));
check('and the sale adds up', near(sale.total, 14) && near(sale.cogs, 2 * 1.11 + 1), `${sale.total} / ${sale.cogs}`);
check('the same sale read back still has its sizes', (await get(`/api/sales/${sale.id}`)).items.every((i) => i.size));

r = await sell([{ product_id: mango.id, size_id: (await get(`/api/products/${pepsi.id}`)).sizes[0]?.id || 999999, qty: 1, unit_price: 5 }]);
check('a size that is not this product\'s is refused', r.status === 400 && r.data.code === 'SIZE_UNKNOWN', JSON.stringify(r.data));
r = await sell([{ product_id: mango.id, qty: 1, unit_price: 3 }]);
check('a sized product sold with no size still goes through, as the product', r.status === 200 && r.data.items[0].size === '');

console.log('\n[changing the sizes later]');
r = await call('PUT', `/api/products/${mango.id}`, {
  sizes: [
    { id: sz.S.id, name: 'S', price: 3, cost: 0.7 },
    { id: sz.M.id, name: 'M', price: 4 },
    { id: sz.L.id, name: 'Large', price: 5.5, cost: 1.2 },
  ],
});
check('a size can be renamed and repriced, and one removed', r.status === 200 &&
  r.data.sizes.map((z) => z.name).join() === 'S,M,Large' && r.data.sizes[2].id === sz.L.id, JSON.stringify(r.data.sizes));
const old = await get(`/api/sales/${sale.id}`);
check('an old invoice still reads the size it was sold in', old.items.some((i) => i.size === 'L') && near(old.total, 14),
  JSON.stringify(old.items.map((i) => i.size)));

console.log('\n[a return goes back in its size]');
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [{ item_id: lineL.id, qty: 1 }] });
check('the return line names the size', r.status === 200 && r.data.items[0].size === 'L' && r.data.items[0].size_id === sz.L.id,
  JSON.stringify(r.data.items?.[0]));

console.log('\n[a held sale keeps its sizes]');
r = await call('POST', '/api/held', { items: [
  { product_id: mango.id, size_id: sz.L.id, qty: 1, unit_price: 5.5 },
  { product_id: mango.id, size_id: sz.S.id, qty: 2, unit_price: 3 },
  { product_id: pepsi.id, qty: 1, unit_price: 1 },
] });
check('holding names the sizes', r.status === 200 && (await get('/api/held'))[0].summary.includes('Mango · Large'),
  (await get('/api/held'))[0]?.summary);
await call('PUT', `/api/products/${mango.id}`, { sizes: [{ id: sz.L.id, name: 'Large', price: 5.5, cost: 1.2 }, { id: sz.M.id, name: 'M', price: 4 }] });
const back = (await call('POST', `/api/held/${r.data.id}/resume`)).data;
const large = back.items.find((i) => i.size === 'Large');
const small = back.items.find((i) => i.size === 'S');
check('resuming brings each size back', large && large.size_id === sz.L.id && near(large.unit_price, 5.5), JSON.stringify(back.items));
check('a size removed while held keeps its name and its price', small && small.size_id === null && near(small.unit_price, 3),
  JSON.stringify(small));
check('and the line without a size is as it was', back.items.some((i) => i.product_id === pepsi.id && !i.size_id && !i.size));

console.log('\n[taking sizes away]');
r = await call('PUT', `/api/products/${mango.id}`, { sizes: [] });
check('an empty list sells the product without sizes again', r.status === 200 && r.data.sizes.length === 0);
check('and the old invoice still reads its size', (await get(`/api/sales/${sale.id}`)).items.some((i) => i.size === 'L'));

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
