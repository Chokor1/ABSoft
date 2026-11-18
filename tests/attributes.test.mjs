/**
 * Attributes and variants: Size and Flavour, a juice template, and the items it
 * generates — each with its own price, stock and recipe — and a shop that never
 * switches attributes on, selling exactly as it always has.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'attributesdata');
const PORT = 4625;
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
const sell = (items) => call('POST', '/api/sales', { tax: 0, items });
const ids = (rows) => rows.map((p) => p.id);

try {
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

  console.log('\n[switched off, as every shop starts]');
  check('attributes are off by default', (await get('/api/settings')).attributes === '0');
  check('there are none', (await get('/api/attributes')).length === 0);
  let r = await call('POST', '/api/attributes', { name: 'Size', values: ['S', 'L'] });
  check('none can be made while it is off', r.status === 400 && r.data.code === 'ATTRIBUTES_OFF', JSON.stringify(r.data));
  const cola = (await call('POST', '/api/products', { name: 'Cola', price: 1, cost: 0.4, opening_stock: 10 })).data;
  check('a product is not a template, nor a variant', cola.has_variants === 0 && cola.variant_of === null && cola.variants === 0);
  check('the till lists it as ever', ids(await get('/api/products?sale=1&templates=1&limit=50')).includes(cola.id));

  console.log('\n[the attribute list]');
  await call('PUT', '/api/settings', { attributes: '1' });
  r = await call('POST', '/api/attributes', { name: 'Size', values: ['S', 'M', 'L', 's'] });
  check('a value is not listed twice', r.status === 400 && r.data.code === 'ATTRIBUTE_VALUE_TWICE');
  r = await call('POST', '/api/attributes', { name: 'Size', values: [] });
  check('an attribute needs values', r.status === 400 && r.data.code === 'ATTRIBUTE_VALUES_REQUIRED');
  const size = (await call('POST', '/api/attributes', { name: 'Size', values: ['S', 'M', 'L'] })).data;
  check('Size: S, M, L', size.values.map((v) => v.name).join(',') === 'S,M,L', JSON.stringify(size));
  r = await call('POST', '/api/attributes', { name: 'size', values: ['X'] });
  check('two attributes do not share a name', r.status === 400 && r.data.code === 'ATTRIBUTE_TAKEN');
  const flavour = (await call('POST', '/api/attributes', { name: 'Flavour', values: ['Mango', 'Strawberry'] })).data;
  const [S, M, L] = size.values;
  const [mango, straw] = flavour.values;

  console.log('\n[a template and its variants]');
  const juice = (await call('POST', '/api/products', {
    name: 'Juice', price: 4, cost: 1, category: 'Juices', has_variants: true, opening_stock: 7,
  })).data;
  check('a template', juice.has_variants === 1);
  check('keeps no stock, even when given an opening stock', Number(juice.stock) === 0, String(juice.stock));
  r = await call('POST', `/api/products/${cola.id}/variants`, { value_ids: [S.id] });
  check('only a template has variants', r.status === 400 && r.data.code === 'PRODUCT_NOT_TEMPLATE');
  r = await call('POST', `/api/products/${juice.id}/variants`, { value_ids: [] });
  check('generating needs values', r.status === 400 && r.data.code === 'VARIANTS_NO_VALUES');
  r = await call('POST', `/api/products/${juice.id}/variants`, { value_ids: [S.id, L.id, mango.id, straw.id] });
  check('S and L, in Mango and Strawberry: 4 variants', r.status === 200 && r.data.created === 4 && r.data.variants.length === 4, JSON.stringify(r.data));
  check('named after the template and their values, in the attributes\' order',
    r.data.variants.map((v) => v.name).join(' | ') === 'Juice S Mango | Juice S Strawberry | Juice L Mango | Juice L Strawberry',
    r.data.variants.map((v) => v.name).join(' | '));
  check('labelled by their values', r.data.variants[0].label === 'S · Mango', r.data.variants[0].label);
  const sMango = (await get(`/api/products/${r.data.variants[0].id}`));
  check('a variant is a product: the template\'s price, cost and category', sMango.price === 4 && sMango.cost === 1 && sMango.category === 'Juices'
    && sMango.variant_of === juice.id && sMango.template_name === 'Juice', JSON.stringify(sMango).slice(0, 300));

  r = await call('POST', `/api/products/${juice.id}/variants`, { value_ids: [S.id, M.id, L.id, mango.id, straw.id] });
  check('adding M makes only the 2 missing ones', r.data.created === 2 && r.data.variants.length === 6, JSON.stringify(r.data.created));
  check('in order: S, M, L', r.data.variants.map((v) => v.label).join(',') === 'S · Mango,S · Strawberry,M · Mango,M · Strawberry,L · Mango,L · Strawberry',
    r.data.variants.map((v) => v.label).join(','));
  check('the template keeps the values chosen', r.data.value_ids.length === 5);
  r = await call('POST', `/api/products/${juice.id}/variants`, { value_ids: [S.id, M.id, L.id, mango.id, straw.id] });
  check('generating again makes nothing new', r.data.created === 0 && r.data.variants.length === 6);
  const byLabel = Object.fromEntries(r.data.variants.map((v) => [v.label, v]));

  r = await call('PUT', `/api/products/${juice.id}/variants`, { prices: { [byLabel['S · Mango'].id]: 3, [byLabel['L · Mango'].id]: 5.5, [cola.id]: 99 } });
  check('each variant at its own price', r.data.variants.find((v) => v.label === 'L · Mango').price === 5.5
    && r.data.variants.find((v) => v.label === 'S · Mango').price === 3, JSON.stringify(r.data.variants.map((v) => v.price)));
  check('and only the template\'s own variants', (await get(`/api/products/${cola.id}`)).price === 1);
  const prices = await get(`/api/products/${byLabel['L · Mango'].id}/prices`);
  check('the change is in its price history', prices.history.some((h) => h.new_price === 5.5), JSON.stringify(prices.history));

  console.log('\n[selling]');
  r = await sell([{ product_id: juice.id, qty: 1, unit_price: 4 }]);
  check('a template is not sold', r.status === 400 && r.data.code === 'PRODUCT_IS_TEMPLATE', JSON.stringify(r.data));
  await call('POST', '/api/adjustments', { items: [{ product_id: byLabel['L · Mango'].id, qty: 10 }], note: 'in' }).catch(() => null);
  r = await sell([{ product_id: byLabel['L · Mango'].id, qty: 2, unit_price: 5.5 }]);
  check('a variant sells like any product', r.status === 200, JSON.stringify(r.data).slice(0, 200));

  const till = await get('/api/products?sale=1&templates=1&limit=50');
  check('the till shows the template, not its variants', ids(till).includes(juice.id) && !till.some((p) => p.variant_of === juice.id), JSON.stringify(ids(till)));
  const tile = till.find((p) => p.id === juice.id);
  check('with how many variants, and where their prices start', tile.variants === 6 && tile.variants_from === 3, JSON.stringify([tile.variants, tile.variants_from]));
  const popular = await get('/api/products?sale=1&templates=1&sort=popular&limit=50');
  check('a template ranks by what its variants sold', popular[0].id === juice.id, JSON.stringify(ids(popular)));
  check('everywhere else, the variants are listed', (await get('/api/products?limit=50')).filter((p) => p.variant_of === juice.id).length === 6);
  check('and a document picker leaves the template out', !ids(await get('/api/products?leaf=1&limit=50')).includes(juice.id));
  const cats = await get('/api/categories/in-use?sale=1&templates=1');
  check('the till counts a template once in its category, not each variant', cats.find((c) => c.name === 'Juices')?.n === 1, JSON.stringify(cats));
  check('a template never runs low', !(await get('/api/products?stock=restock&page=1&per=100')).rows.some((p) => p.id === juice.id));
  check('a template\'s variants, asked for', (await get(`/api/products?variant_of=${juice.id}&limit=50`)).length === 6);
  check('the till asks for the active ones', (await get(`/api/products/${juice.id}/variants?active=1`)).variants.length === 6);

  console.log('\n[keeping it straight]');
  r = await call('PUT', `/api/products/${juice.id}`, { has_variants: false });
  check('a template with variants stays one', r.status === 400 && r.data.code === 'TEMPLATE_HAS_VARIANTS');
  r = await call('PUT', `/api/products/${byLabel['S · Mango'].id}`, { has_variants: true });
  check('a variant is not a template', r.status === 400 && r.data.code === 'VARIANT_NOT_TEMPLATE');
  r = await call('PUT', `/api/products/${cola.id}`, { has_variants: true });
  check('a product with stock history is not made a template', r.status === 400 && r.data.code === 'TEMPLATE_HAS_STOCK');
  r = await call('DELETE', `/api/attributes/${size.id}`);
  check('an attribute in use stays', r.status === 400 && r.data.code === 'ATTRIBUTE_IN_USE');
  r = await call('PUT', `/api/attributes/${size.id}`, { name: 'Size', values: ['S', 'M'] });
  check('so does a value in use', r.status === 400 && r.data.code === 'ATTRIBUTE_VALUE_IN_USE');
  r = await call('PUT', `/api/attributes/${size.id}`, { name: 'Cup', values: ['S', 'M', 'L', 'Bottle'] });
  check('renamed, with a value added: the values kept are the same ones', r.status === 200 && r.data.name === 'Cup'
    && r.data.values.find((v) => v.name === 'S').id === S.id && r.data.values.length === 4, JSON.stringify(r.data));
  const spare = (await call('POST', '/api/attributes', { name: 'Ice', values: ['None'] })).data;
  r = await call('DELETE', `/api/attributes/${spare.id}`);
  check('one nothing uses can go', r.status === 200);

  console.log('\n[switched off again]');
  await call('PUT', '/api/settings', { attributes: '0' });
  const offTill = await get('/api/products?sale=1&templates=1&limit=50');
  check('the till lists the variants as the plain products they are', offTill.filter((p) => p.variant_of === juice.id).length === 6);
  r = await call('POST', `/api/products/${juice.id}/variants`, { value_ids: [S.id] });
  check('and nothing more is generated', r.status === 400 && r.data.code === 'ATTRIBUTES_OFF');
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
