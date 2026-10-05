/** Sales put aside at the till: held whole, taken back once, and never mistaken for a sale. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'helddata');
const PORT = 4553;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) < eps;

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

const client = () => {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
};
const admin = client();
await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const water = (await admin('POST', '/api/products', { name: 'Water', barcode: 'H-W', cost: 0.25, price: 1, opening_stock: 50 })).data;
const beans = (await admin('POST', '/api/products', { name: 'Beans', barcode: 'H-B', cost: 9.5, price: 18, opening_stock: 50 })).data;
const gum = (await admin('POST', '/api/products', { name: 'Gum', barcode: 'H-G', cost: 0.1, price: 0.5 })).data;
await admin('POST', '/api/users', { username: 'anna', password: 'test1234', role: 'cashier' });
await admin('POST', '/api/users', { username: 'bilal', password: 'test1234', role: 'cashier' });
const anna = client();
await anna('POST', '/api/auth/login', { username: 'anna', password: 'test1234' });
const bilal = client();
await bilal('POST', '/api/auth/login', { username: 'bilal', password: 'test1234' });
const stock = async (id) => (await admin('GET', `/api/products/${id}`)).data.stock;
const today = (await admin('GET', '/api/reports/dashboard')).data.today;

console.log('\n[holding]');
check('nothing is held to begin with', (await anna('GET', '/api/held')).data.length === 0);
let r = await anna('POST', '/api/held', { items: [] });
check('an empty cart is not held', r.status === 400 && r.data.code === 'HOLD_EMPTY');
r = await anna('POST', '/api/held', { items: [{ product_id: 99999, qty: 1, unit_price: 1 }] });
check('nor one with a product that does not exist', r.status === 400 && r.data.code === 'CART_UNKNOWN_PRODUCT');
// 2 water at 1.00, 1 beans at 18 less 25%, and the customer already typed in the payment dialog.
r = await anna('POST', '/api/held', {
  items: [{ product_id: water.id, qty: 2, unit_price: 1 }, { product_id: beans.id, qty: 1, unit_price: 18, discount_pct: 25 }, { product_id: gum.id, qty: 3, unit_price: 0.5 }],
  draft: { customer: 'Rita', method: 'Whish', discountInput: 1, discountMode: 'amount', discount: 1, note: 'back in 5 minutes' },
});
const first = r.data;
check('a cashier holds a sale: three lines, 2 + 13.50 + 1.50 = 17.00', r.status === 200 && first.lines === 3 && near(first.total, 17) && first.username === 'anna', JSON.stringify(first));
check('it is labelled by its customer and says what is in it', first.label === 'Rita' && first.summary.includes('Water × 2') && first.summary.includes('Beans × 1'), first.summary);
r = await bilal('POST', '/api/held', { items: [{ product_id: water.id, qty: 5, unit_price: 1 }] });
const second = r.data;
check('another cashier holds one too; the list is the shop\'s, newest first',
  (await anna('GET', '/api/held')).data.map((h) => h.id).join() === `${second.id},${first.id}`);

console.log('\n[a held sale is not a sale]');
const after = (await admin('GET', '/api/reports/dashboard')).data.today;
check('no stock has moved', (await stock(water.id)) === 50 && (await stock(beans.id)) === 50);
check('and nothing was sold', after.sale_count === today.sale_count && near(after.gross_sales, today.gross_sales) &&
  (await admin('GET', '/api/sales?page=1&per=5')).data.total === 0);

console.log('\n[taking it back]');
// Meanwhile the price of beans goes up, and the gum is taken off the catalogue altogether.
await admin('PUT', `/api/products/${beans.id}`, { price: 20 });
await admin('DELETE', `/api/products/${gum.id}`);
r = await bilal('POST', `/api/held/${first.id}/resume`);
const back = r.data;
check('any till can take it back', r.status === 200 && back.items.length === 2, JSON.stringify(back).slice(0, 200));
const b = back.items.find((i) => i.product_id === beans.id);
check('at the price and discount it was held at, not today\'s', b.unit_price === 18 && b.discount_pct === 25 && b.price === 20 && b.qty === 1, JSON.stringify(b));
check('with today\'s name, unit and stock on each line', b.name === 'Beans' && b.stock === 50 && !!b.unit);
check('a product deleted meanwhile is left out, and counted', back.dropped === 1);
check('the payment details come back too', back.draft.customer === 'Rita' && back.draft.method === 'Whish' && back.draft.note === 'back in 5 minutes' && near(back.draft.discount, 1));
check('it has left the list', (await anna('GET', '/api/held')).data.map((h) => h.id).join() === String(second.id));
r = await anna('POST', `/api/held/${first.id}/resume`);
check('so it cannot be taken back twice', r.status === 404 && r.data.code === 'HELD_GONE', JSON.stringify(r.data));

console.log('\n[discarding]');
r = await anna('DELETE', `/api/held/${second.id}`);
check('a cashier cannot discard a sale someone else held', r.status === 400 && r.data.code === 'HELD_NOT_YOURS');
r = await bilal('DELETE', `/api/held/${second.id}`);
check('the one who held it can', r.status === 200 && r.data.left === 0);
const third = (await anna('POST', '/api/held', { items: [{ product_id: water.id, qty: 1, unit_price: 1 }] })).data;
check('and an administrator can discard anyone\'s', (await admin('DELETE', `/api/held/${third.id}`)).status === 200 && (await admin('GET', '/api/held')).data.length === 0);
check('discarding what is gone says so', (await admin('DELETE', `/api/held/${third.id}`)).data.code === 'HELD_GONE');
const sys = (await admin('GET', '/api/system')).data;
check('the schema is current', sys.schema_version === sys.schema_latest);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
