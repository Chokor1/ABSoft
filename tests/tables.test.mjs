/**
 * Restaurant mode: tables free or open, an order sent, added to and paid — never
 * twice, never out of date — and a shop that never switches it on, unchanged.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'tablesdata');
const PORT = 4629;
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
const line = (p, q = 1) => ({ product_id: p.id, qty: q, unit_price: p.price });

try {
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const burger = (await call('POST', '/api/products', { name: 'Burger', price: 8, cost: 3, opening_stock: 20 })).data;
  const cola = (await call('POST', '/api/products', { name: 'Cola', price: 1.5, cost: 0.5, opening_stock: 50 })).data;
  const cake = (await call('POST', '/api/products', { name: 'Cake', price: 4, cost: 1, opening_stock: 10 })).data;
  const stock = async (p) => Number((await get(`/api/products/${p.id}`)).stock);

  console.log('\n[switched off, as every shop starts]');
  check('restaurant mode is off by default', (await get('/api/settings')).restaurant === '0');
  check('there are no tables', (await get('/api/tables')).length === 0);
  let r = await call('POST', '/api/tables', { name: 'Table 1' });
  check('none can be made while it is off', r.status === 400 && r.data.code === 'RESTAURANT_OFF');
  r = await call('POST', '/api/sales', { tax: 0, items: [line(cola)], table_id: 1, table_version: 1 });
  check('a sale naming a table sells as ever', r.status === 200 && r.data.table_name === '', JSON.stringify(r.data).slice(0, 200));

  console.log('\n[the tables]');
  await call('PUT', '/api/settings', { restaurant: '1' });
  let tables = (await call('POST', '/api/tables', { count: 4 })).data;
  check('four at once: Table 1 to Table 4', tables.map((tb) => tb.name).join() === 'Table 1,Table 2,Table 3,Table 4', JSON.stringify(tables));
  const terrace = (await call('POST', '/api/tables', { name: 'Terrace' })).data;
  check('and one by name', terrace.name === 'Terrace' && terrace.status === 'free');
  r = await call('POST', '/api/tables', { name: 'terrace' });
  check('two tables do not share a name', r.status === 400 && r.data.code === 'TABLE_TAKEN');
  tables = (await call('POST', '/api/tables', { count: 2 })).data;
  check('adding more carries on the numbering', tables.map((tb) => tb.name).includes('Table 6'), JSON.stringify(tables.map((tb) => tb.name)));
  check('every table starts free', tables.every((tb) => tb.status === 'free'));
  const t1 = tables.find((tb) => tb.name === 'Table 1');

  console.log('\n[an order on Table 1]');
  r = await call('PUT', `/api/tables/${t1.id}/order`, { items: [line(burger, 2), line(cola, 2)] });
  check('sent: Table 1 is open with $19', r.status === 200 && r.data.status === 'open' && near(r.data.order.total, 19) && r.data.order.version === 1, JSON.stringify(r.data));
  check('nothing has left the shelf yet', (await stock(burger)) === 20 && (await stock(cola)) === 49);
  r = await call('PUT', `/api/tables/${t1.id}/order`, { items: [line(cola)] });
  check('another round from another till is added to it', r.data.order.lines === 3 && near(r.data.order.total, 20.5) && r.data.order.version === 2, JSON.stringify(r.data.order));
  let order = await get(`/api/tables/${t1.id}/order`);
  check('opened at the till: its lines, by name, at version 2', order.items.length === 3 && order.items[0].name === 'Burger' && order.version === 2, JSON.stringify(order));

  r = await call('PUT', `/api/tables/${t1.id}/order`, { items: [...order.items, line(cake)], version: 1 });
  check('saving over an older version is refused', r.status === 400 && r.data.code === 'TABLE_CHANGED');
  r = await call('PUT', `/api/tables/${t1.id}/order`, { items: [...order.items, line(cake)], version: 2 });
  check('saving the version it opened: dessert added, version 3', r.status === 200 && r.data.order.lines === 4 && r.data.order.version === 3 && near(r.data.order.total, 24.5));

  const before = (await get('/api/sales?limit=100')).length;
  r = await call('POST', '/api/sales', { tax: 0, items: order.items, table_id: t1.id, table_version: 2 });
  check('paying an order that has grown since is refused', r.status === 400 && r.data.code === 'TABLE_CHANGED');
  check('and nothing was sold', (await get('/api/sales?limit=100')).length === before);

  order = await get(`/api/tables/${t1.id}/order`);
  r = await call('DELETE', `/api/tables/${t1.id}`);
  check('a table with an open order stays', r.status === 400 && r.data.code === 'TABLE_OPEN');
  r = await call('POST', '/api/sales', { tax: 0, items: order.items, table_id: t1.id, table_version: order.version, source: 'pos' });
  check('paid: a sale at Table 1 for $24.50', r.status === 200 && r.data.table_name === 'Table 1' && near(r.data.total, 24.5), JSON.stringify(r.data).slice(0, 300));
  check('the stock moves now', (await stock(burger)) === 18 && (await stock(cake)) === 9);
  check('and the table is free again', (await get('/api/tables')).find((tb) => tb.id === t1.id).status === 'free');
  r = await call('POST', '/api/sales', { tax: 0, items: order.items, table_id: t1.id, table_version: order.version });
  check('it cannot be paid twice', r.status === 400 && r.data.code === 'TABLE_NOT_OPEN');

  console.log('\n[clearing and setting up]');
  await call('PUT', `/api/tables/${terrace.id}/order`, { items: [line(cola)] });
  r = await call('DELETE', `/api/tables/${terrace.id}/order`);
  check('an administrator can clear a table without a sale', r.status === 200 && r.data.status === 'free');
  r = await call('PUT', `/api/tables/${terrace.id}`, { active: false });
  check('a table can be taken out of use', r.data.active === 0);
  check('the till no longer lists it', !(await get('/api/tables')).some((tb) => tb.id === terrace.id));
  check('Settings still does', (await get('/api/tables?all=1')).some((tb) => tb.id === terrace.id));
  r = await call('DELETE', `/api/tables/${terrace.id}`);
  check('a free table can be removed', r.status === 200);
  r = await call('PUT', `/api/tables/${t1.id}/order`, { items: [] });
  check('an empty order is not sent', r.status === 400);

  console.log('\n[switched off again]');
  const t2 = (await get('/api/tables')).find((tb) => tb.name === 'Table 2');
  await call('PUT', `/api/tables/${t2.id}/order`, { items: [line(cake)] });
  await call('PUT', '/api/settings', { restaurant: '0' });
  r = await call('POST', '/api/sales', { tax: 0, items: [line(cake)], table_id: t2.id, table_version: 99 });
  check('a sale ignores tables while it is off', r.status === 200 && r.data.table_name === '');
  r = await call('PUT', `/api/tables/${t2.id}/order`, { items: [line(cake)] });
  check('and nothing is sent to one', r.status === 400 && r.data.code === 'RESTAURANT_OFF');
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
