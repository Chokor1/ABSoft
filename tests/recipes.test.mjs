/**
 * Recipes and consumption reconciliation: a banana shake that keeps no stock of
 * its own, bananas bought by the kilo and reconciled when the shop chooses —
 * and a shop that never switches it on, selling exactly as it always has.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'recipesdata');
const PORT = 4623;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0011;

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
const stockOf = async (id) => Number((await get(`/api/products/${id}`)).stock);

try {
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

  console.log('\n[switched off, as every shop starts: nothing changes]');
  check('recipes are off by default', (await get('/api/settings')).recipes === '0');
  const banana = (await call('POST', '/api/products', { name: 'Banana', unit: 'kg', cost: 2, price: 3, barcode: 'BAN1', opening_stock: 10, raw: true })).data;
  const milk = (await call('POST', '/api/products', { name: 'Milk', unit: 'l', cost: 1, price: 2, opening_stock: 20, raw: true })).data;
  // Two shakes, as two variants of one would be: each an item with its own recipe.
  const large = (await call('POST', '/api/products', { name: 'Banana shake L', cost: 0.5, price: 5, opening_stock: 5, made_to_order: true })).data;
  const small = (await call('POST', '/api/products', { name: 'Banana shake S', cost: 0.4, price: 3, opening_stock: 5, made_to_order: true })).data;
  const shake = large;
  check('a product can be marked made to order and raw, and keeps the marks', shake.stocked === 0 && banana.raw === 1 && milk.raw === 1,
    JSON.stringify([shake.stocked, banana.raw]));
  let r = await sell([{ product_id: large.id, qty: 1, unit_price: 5 }]);
  check('switched off, a made-to-order product still sells from its own stock', r.status === 200 && (await stockOf(shake.id)) === 4,
    String(await stockOf(shake.id)));
  check('at its own cost, as before', near(r.data.items[0].unit_cost, 0.5), String(r.data.items[0].unit_cost));
  r = await call('PUT', `/api/products/${shake.id}/recipe`, { lines: [{ ingredient_id: banana.id, qty: 0.2 }] });
  check('a recipe cannot be saved while it is off', r.status === 400 && r.data.code === 'RECIPES_OFF', JSON.stringify(r.data));
  r = await call('GET', '/api/consumption/ingredients');
  check('nor reconciled', r.status === 400 && r.data.code === 'RECIPES_OFF');
  const forSale = await get('/api/products?sale=1&limit=50');
  check('raw materials are still sold at the till', forSale.some((p) => p.id === banana.id));
  check('and scanned', (await call('GET', '/api/products/lookup?code=BAN1&sale=1')).status === 200);
  r = await sell([{ product_id: banana.id, qty: 0.5, unit_price: 3 }]);
  check('a raw material still sells like any product', r.status === 200 && near(await stockOf(banana.id), 9.5));

  console.log('\n[switched on]');
  check('the switch turns on', (await call('PUT', '/api/settings', { recipes: '1' })).data.recipes === '1');
  check('and only takes 1 or 0', (await call('PUT', '/api/settings', { recipes: 'yes' })).data.recipes === '0');
  await call('PUT', '/api/settings', { recipes: '1' });

  r = await call('PUT', `/api/products/${shake.id}/recipe`, { lines: [{ ingredient_id: shake.id, qty: 1 }] });
  check('a product is not one of its own ingredients', r.status === 400 && r.data.code === 'RECIPE_SELF');
  r = await call('PUT', `/api/products/${large.id}/recipe`, {
    lines: [{ ingredient_id: banana.id, qty: 0.3 }, { ingredient_id: milk.id, qty: 0.4 }, { ingredient_id: milk.id, qty: 9 }, { ingredient_id: banana.id, qty: 0 }],
  });
  check('a large takes 0.3 kg of banana and 0.4 l of milk', r.status === 200 && r.data.lines.length === 2
    && r.data.lines[0].qty === 0.3 && r.data.lines[1].qty === 0.4, JSON.stringify(r.data));
  check('and costs 1.00 at today\'s prices', near(r.data.cost, 1), JSON.stringify(r.data));
  r = await call('PUT', `/api/products/${small.id}/recipe`, { lines: [{ ingredient_id: banana.id, qty: 0.15 }, { ingredient_id: milk.id, qty: 0.25 }] });
  check('a small its own: 0.15 and 0.25, costing 0.55', r.status === 200 && near(r.data.cost, 0.55), JSON.stringify(r.data));

  const shakeBefore = await stockOf(shake.id);
  r = await sell([
    { product_id: large.id, qty: 2, unit_price: 5 },
    { product_id: small.id, qty: 1, unit_price: 3 },
  ]);
  check('a made-to-order shake sells with no stock of its own to go short of', r.status === 200, JSON.stringify(r.data));
  check('its stock does not move', (await stockOf(shake.id)) === shakeBefore, String(await stockOf(shake.id)));
  const lineL = r.data.items.find((i) => i.product_id === large.id);
  check('a line costs what its recipe costs today', near(lineL.unit_cost, 1), String(lineL.unit_cost));
  check('the bananas do not move yet either: they move when reconciled', near(await stockOf(banana.id), 9.5));

  // Going short does not apply to something made to order, even with nothing "in stock".
  const crepe = (await call('POST', '/api/products', { name: 'Crêpe', price: 4, made_to_order: true })).data;
  r = await sell([{ product_id: crepe.id, qty: 3, unit_price: 4 }]);
  check('a made-to-order product with no recipe sells too, at its own cost, and moves nothing', r.status === 200 && (await stockOf(crepe.id)) === 0,
    JSON.stringify(r.data).slice(0, 200));

  let ing = await get('/api/consumption/ingredients');
  const bananaNow = ing.find((i) => i.id === banana.id);
  const milkNow = ing.find((i) => i.id === milk.id);
  check('the sales say 0.75 kg of banana was used (2 × 0.3 + 0.15)', near(bananaNow.suggested, 0.75), JSON.stringify(bananaNow));
  check('and 1.05 l of milk (2 × 0.4 + 0.25)', near(milkNow.suggested, 1.05), JSON.stringify(milkNow));
  check('neither has been reconciled yet', bananaNow.since === '' && milkNow.since === '');

  console.log('\n[the till does not sell ingredients]');
  const sale1 = await get('/api/products?sale=1&limit=50');
  check('the till list leaves the raw materials out', !sale1.some((p) => p.raw === 1) && sale1.some((p) => p.id === shake.id));
  check('the product list still has them', (await get('/api/products?limit=50')).some((p) => p.id === banana.id));
  check('scanning one at the till finds nothing', (await call('GET', '/api/products/lookup?code=BAN1&sale=1')).status === 404);
  check('scanning it elsewhere (a stock count) still finds it', (await call('GET', '/api/products/lookup?code=BAN1')).status === 200);

  console.log('\n[a reconciliation of bananas only]');
  r = await call('POST', '/api/consumptions', { items: [] });
  check('a reconciliation needs at least one ingredient', r.status === 400 && r.data.code === 'CONSUMPTION_EMPTY');
  r = await call('POST', '/api/consumptions', { items: [{ product_id: banana.id, actual: 0.9 }], note: 'evening' });
  const draft = r.data;
  check('it starts as a draft, CON-000001', r.status === 200 && draft.status === 'draft' && draft.doc_no === 'CON-000001', JSON.stringify(draft));
  check('suggested 0.75, actually used 0.9: 0.15 more than the recipes say',
    near(draft.items[0].suggested, 0.75) && near(draft.items[0].actual, 0.9) && near(draft.items[0].difference, 0.15), JSON.stringify(draft.items));
  check('worth 1.80, and 0.30 of it over the estimate', near(draft.value, 1.8) && near(draft.difference_value, 0.3));
  check('a draft moves no stock', near(await stockOf(banana.id), 9.5));

  // Another large shake before it is submitted: a draft reaches to when it is submitted.
  await sell([{ product_id: large.id, qty: 1, unit_price: 5 }]);
  const live = await get(`/api/consumptions/${draft.id}`);
  check('a draft follows the sales up to now: 1.05', near(live.items[0].suggested, 1.05), JSON.stringify(live.items));

  r = await call('PUT', `/api/consumptions/${draft.id}`, { items: [{ product_id: banana.id, actual: 1.1, counted: 8.4 }], note: 'evening' });
  check('a draft can be changed: actually used 1.1, 8.4 kg counted', r.status === 200 && near(r.data.items[0].actual, 1.1) && near(r.data.items[0].counted, 8.4));

  // A second draft for the same bananas, made before the first is submitted.
  const second = (await call('POST', '/api/consumptions', { items: [{ product_id: banana.id, actual: 1 }] })).data;

  r = await call('POST', `/api/consumptions/${draft.id}/submit`);
  check('submitted', r.status === 200 && r.data.status === 'submitted' && r.data.submitted_at && r.data.until, JSON.stringify(r.data));
  check('the bananas go down by what was really used: 9.5 − 1.1 = 8.4', near(await stockOf(banana.id), 8.4), String(await stockOf(banana.id)));
  check('its figures are kept: suggested 1.05, difference 0.05', near(r.data.items[0].suggested, 1.05) && near(r.data.items[0].difference, 0.05),
    JSON.stringify(r.data.items));
  r = await call('POST', `/api/consumptions/${draft.id}/submit`);
  check('a reconciliation is submitted once', r.status === 400 && r.data.code === 'CONSUMPTION_SUBMITTED');
  r = await call('PUT', `/api/consumptions/${draft.id}`, { items: [{ product_id: banana.id, actual: 5 }] });
  check('and is not changed afterwards', r.status === 400 && r.data.code === 'CONSUMPTION_SUBMITTED');
  r = await call('DELETE', `/api/consumptions/${draft.id}`);
  check('nor removed', r.status === 400 && r.data.code === 'CONSUMPTION_SUBMITTED');

  r = await call('POST', `/api/consumptions/${second.id}/submit`);
  check('the older draft of the same bananas is refused: they would be taken out twice', r.status === 400 && r.data.code === 'CONSUMPTION_ALREADY',
    JSON.stringify(r.data));
  check('and nothing moved', near(await stockOf(banana.id), 8.4));
  r = await call('DELETE', `/api/consumptions/${second.id}`);
  check('a draft can be thrown away', r.status === 200 && (await call('GET', `/api/consumptions/${second.id}`)).status === 404);

  console.log('\n[each ingredient keeps its own cutoff]');
  ing = await get('/api/consumption/ingredients');
  const b2 = ing.find((i) => i.id === banana.id);
  const m2 = ing.find((i) => i.id === milk.id);
  check('bananas start again from their reconciliation: nothing since', near(b2.suggested, 0) && b2.since !== '', JSON.stringify(b2));
  check('milk was never reconciled: all of it, 1.45', near(m2.suggested, 1.45) && m2.since === '', JSON.stringify(m2));
  await sell([{ product_id: small.id, qty: 2, unit_price: 3 }]);
  ing = await get('/api/consumption/ingredients');
  check('a sale after it counts for the next one: 0.3 of banana', near(ing.find((i) => i.id === banana.id).suggested, 0.3));

  r = await call('POST', '/api/consumptions', { items: [{ product_id: milk.id, actual: 2 }, { product_id: banana.id, actual: 0.3 }] });
  r = await call('POST', `/api/consumptions/${r.data.id}/submit`);
  check('milk and bananas together: milk 1.95 suggested, bananas 0.3', r.status === 200
    && near(r.data.items.find((i) => i.product_id === milk.id).suggested, 1.95)
    && near(r.data.items.find((i) => i.product_id === banana.id).suggested, 0.3), JSON.stringify(r.data.items));
  check('milk 20 − 2 = 18, bananas 8.4 − 0.3 = 8.1', near(await stockOf(milk.id), 18) && near(await stockOf(banana.id), 8.1));

  const docs = await get('/api/consumptions');
  // The draft thrown away freed its number, as with any document.
  check('the reconciliations are listed, newest first', docs.rows.length === 2 && docs.rows[0].doc_no === 'CON-000002' && docs.rows[0].lines === 2,
    JSON.stringify(docs.rows.map((d) => d.doc_no)));

  // A reconciliation dated a past day reaches only to the end of that day.
  r = await call('POST', '/api/consumptions', { items: [{ product_id: milk.id, actual: 0 }], until: '2020-01-01' });
  check('a past day reaches to its end', r.data.until === '2020-01-01 23:59:59.999', String(r.data.until));
  r = await call('POST', `/api/consumptions/${r.data.id}/submit`);
  check('and is refused for milk already reconciled after it', r.status === 400 && r.data.code === 'CONSUMPTION_ALREADY');

  console.log('\n[returns]');
  const sold = (await sell([{ product_id: large.id, qty: 1, unit_price: 5 }])).data;
  const before = await stockOf(shake.id);
  r = await call('POST', `/api/sales/${sold.id}/returns`, { items: [{ item_id: sold.items[0].id, qty: 1, restock: true }], method: 'cash' });
  check('a returned shake goes back on no shelf', r.status === 200 && (await stockOf(shake.id)) === before && r.data.items[0].restock === 0,
    JSON.stringify(r.data.items?.[0]));
  ing = await get('/api/consumption/ingredients');
  check('and what it used stays used', near(ing.find((i) => i.id === banana.id).suggested, 0.3), JSON.stringify(ing));

  console.log('\n[switched off again]');
  await call('PUT', '/api/settings', { recipes: '0' });
  const back = await stockOf(shake.id);
  r = await sell([{ product_id: large.id, qty: 1, unit_price: 5 }]);
  check('the shake sells from its own stock again', r.status === 200 && (await stockOf(shake.id)) === back - 1);
  check('at its own cost', near(r.data.items[0].unit_cost, 0.5), String(r.data.items[0].unit_cost));
  check('the reconciliations are still there to read', (await get('/api/consumptions')).rows.length === 3);
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
