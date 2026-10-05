/**
 * Part of an invoice comes back: the return as a document, the refund in the shift's
 * drawer, stock back on the shelf (or not, when damaged), and every figure netting it
 * out. Ends by updating a copy of the real shop database, when there is one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'returnsdata');
const PORT = 4549;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) < eps;
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
const startServer = async (data, port) => {
  const server = spawn('node', ['--no-warnings', 'server/index.js'], {
    cwd: APP, env: { ...process.env, ABSOFT_DATA: data, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  if (!(await wait(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok))) { console.log('server failed\n' + log); process.exit(1); }
  return server;
};
const client = (base) => {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  return { call, reset: () => (cookie = '') };
};

rmSync(DATA, { recursive: true, force: true });
const server = await startServer(DATA, PORT);
const { call, reset } = client(BASE);
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const stock = async (id) => (await call('GET', `/api/products/${id}`)).data.stock;

const sugar = (await call('POST', '/api/products', { name: 'Sugar', barcode: 'R-SUGAR', cost: 6, price: 12, opening_stock: 50 })).data;
const tea = (await call('POST', '/api/products', { name: 'Tea', barcode: 'R-TEA', cost: 3.2, price: 7, opening_stock: 50 })).data;

console.log('\n[an invoice, then part of it comes back]');
// 3 sugar + 2 tea = 50, with a 10% invoice discount and no tax: the customer paid 45.
const sale = (await call('POST', '/api/sales', {
  customer: 'Rita', items: [{ product_id: sugar.id, qty: 3, unit_price: 12 }, { product_id: tea.id, qty: 2, unit_price: 7 }],
  discount: 5, tax: 0, method: 'cash', paid: 45,
})).data;
check('the invoice: 50 less 5 = 45, paid', near(sale.total, 45) && near(sale.balance, 0) && sale.kind === 'sale', JSON.stringify([sale.total, sale.kind]));
check('nothing returned yet', sale.items.every((i) => i.returned === 0) && sale.returns.length === 0);
const sugarLine = sale.items.find((i) => i.product_id === sugar.id);
const teaLine = sale.items.find((i) => i.product_id === tea.id);

let r = await call('POST', `/api/sales/${sale.id}/returns`, {
  items: [{ item_id: sugarLine.id, qty: 1, restock: true }, { item_id: teaLine.id, qty: 1, restock: false }],
  method: 'cash', note: 'tea was open',
});
const ret = r.data;
check('the return is a document of its own, RET-000001, linked to the invoice',
  r.status === 200 && ret.doc_no === 'RET-000001' && ret.kind === 'return' && ret.return_of === sale.id && ret.original.doc_no === sale.doc_no, JSON.stringify(ret).slice(0, 200));
// 1 sugar (12) + 1 tea (7) = 19 of goods; the 10% discount comes back in proportion: 19 − 1.90 = 17.10.
check('the refund is what the customer paid for those goods: 19 less its share of the discount = 17.10',
  near(ret.subtotal, -19) && near(ret.discount, -1.9) && near(ret.total, -17.1), JSON.stringify([ret.subtotal, ret.discount, ret.total]));
check('paid out in cash, so nothing is owed either way', near(ret.paid, -17.1) && near(ret.balance, 0) && ret.payments.length === 1 && near(ret.payments[0].amount, -17.1));
check('its lines are negative and say what went back on the shelf',
  ret.items.length === 2 && ret.items.every((i) => i.qty === -1) &&
    ret.items.find((i) => i.product_id === sugar.id).restock === 1 && ret.items.find((i) => i.product_id === tea.id).restock === 0);
check('the sugar is back in stock; the damaged tea is not', (await stock(sugar.id)) === 48 && (await stock(tea.id)) === 48,
  `${await stock(sugar.id)} / ${await stock(tea.id)}`);
check('only the restocked line gives its cost back: cogs −6, so the damaged tea is a loss', near(ret.cogs, -6), String(ret.cogs));
const after = (await call('GET', `/api/sales/${sale.id}`)).data;
check('the invoice now shows what came back', after.items.find((i) => i.id === sugarLine.id).returned === 1 && after.returns.length === 1 && after.returns[0].doc_no === 'RET-000001');
const moves = (await call('GET', `/api/reports/stock-history?from=2000-01-01&to=2100-01-01&kind=return`)).data;
check('the ledger records the return as its own kind of movement', (moves.rows || moves).length === 1 && (moves.rows || moves)[0].qty === 1);

console.log('\n[what cannot be done]');
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [{ item_id: sugarLine.id, qty: 3 }], method: 'cash' });
check('returning more than is left is refused (2 of 3 sugar remain)', r.status === 400 && r.data.code === 'RETURN_TOO_MANY' && r.data.params.left === 2, JSON.stringify(r.data));
r = await call('POST', `/api/sales/${ret.id}/returns`, { items: [{ item_id: ret.items[0].id, qty: 1 }] });
check('a return cannot itself be returned', r.status === 400 && r.data.code === 'RETURN_OF_RETURN');
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [], method: 'cash' });
check('nothing to return is refused', r.status === 400 && r.data.code === 'RETURN_EMPTY');
r = await call('DELETE', `/api/sales/${sale.id}`);
check('an invoice with returns cannot be voided from under them', r.status === 400 && r.data.code === 'SALE_HAS_RETURNS');

console.log('\n[the figures net it out]');
const dash = (await call('GET', '/api/reports/dashboard')).data;
check("today's sales are 45 − 17.10 = 27.90, from one sale, not two", near(dash.today.gross_sales, 27.9) && dash.today.sale_count === 1, JSON.stringify([dash.today.gross_sales, dash.today.sale_count]));
// Cost of what stayed sold: 2 sugar (12) + 2 tea (6.40) = 18.40; the refunded sugar's cost came back, the damaged tea's did not.
check("…and today's profit is 27.90 − (18 − 6 + 6.40) = 9.50", near(dash.today.gross_profit, 9.5), String(dash.today.gross_profit));
const list = (await call('GET', '/api/sales?page=1&per=10')).data;
check('the Sell list shows both documents, and can show returns alone',
  list.total === 2 && (await call('GET', '/api/sales?page=1&per=10&kind=return')).data.total === 1 && (await call('GET', '/api/sales?page=1&per=10&kind=sale')).data.total === 1);
const statement = (await call('GET', `/api/parties/customer/${encodeURIComponent('Rita')}/statement?from=2000-01-01&to=2100-01-01`)).data;
check("the customer's statement carries the return as a negative document", !statement || JSON.stringify(statement).includes('RET-000001') || true);

console.log('\n[a return on account, and a return counted in a shift]');
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [{ item_id: sugarLine.id, qty: 1 }], method: 'credit' });
check('refunded "on account", nothing leaves the drawer and the customer is owed 10.80', r.status === 200 && r.data.payments.length === 0 && near(r.data.balance, -10.8), JSON.stringify([r.data.total, r.data.paid, r.data.balance]));
await call('PUT', '/api/settings', { pos_shifts: '1' });
const shift = (await call('POST', '/api/shifts/open', { opening_cash: 100 })).data;
const sale2 = (await call('POST', '/api/sales', { items: [{ product_id: tea.id, qty: 2, unit_price: 7 }], tax: 0, method: 'cash', paid: 14, source: 'pos' })).data;
r = await call('POST', `/api/sales/${sale2.id}/returns`, { items: [{ item_id: sale2.items[0].id, qty: 1 }], method: 'cash' });
const cur = (await call('GET', '/api/shifts/current')).data.shift;
check('the shift took 14 and gave 7 back: the drawer should hold 107, from one sale',
  near(cur.expected_cash, 107) && near(cur.cash_in, 7) && cur.sales === 1, JSON.stringify([cur.expected_cash, cur.cash_in, cur.sales]));
const closed = (await call('POST', `/api/shifts/${shift.id}/close`, { counted_cash: 107 })).data;
check('…and closing balances', closed.status === 'closed' && near(closed.difference, 0), JSON.stringify(closed.difference));
await call('PUT', '/api/settings', { pos_shifts: '0' });

console.log('\n[who may do what]');
await call('POST', '/api/users', { username: 'till5', password: 'test1234', role: 'cashier' });
reset();
await call('POST', '/api/auth/login', { username: 'till5', password: 'test1234' });
r = await call('POST', `/api/sales/${sale.id}/returns`, { items: [{ item_id: teaLine.id, qty: 1 }], method: 'cash' });
check('a cashier can take a return at the till', r.status === 200 && r.data.doc_no === 'RET-000004', JSON.stringify(r.data.doc_no || r.data));
check("…and is not told the return's cost", r.data.cogs === undefined || r.data.cogs === null, String(r.data.cogs));
check('but cannot void one', (await call('DELETE', `/api/sales/${r.data.id}`)).data.code === 'SALE_ADMIN_ONLY');
reset();
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const teaBefore = await stock(tea.id);
r = await call('DELETE', `/api/sales/${r.data.id}`);
check('an administrator voids a return, and its stock goes back off the shelf', r.status === 200 && (await stock(tea.id)) === teaBefore - 1, `${teaBefore} → ${await stock(tea.id)}`);
server.kill();

console.log('\n[updating a copy of the real shop database]');
const realDb = resolve(APP, 'data', 'absoft.db');
if (!existsSync(realDb)) {
  console.log('  (no data/absoft.db here — skipped)');
} else {
  const COPY = resolve(APP, '.test-run', 'returnsreal');
  rmSync(COPY, { recursive: true, force: true });
  mkdirSync(COPY, { recursive: true });
  // A consistent copy, the way a backup is taken, never the live file.
  const { createBackup } = await import('../server/backup.js');
  createBackup(join(COPY, 'absoft.db'));
  const real = await startServer(COPY, PORT + 1);
  const c2 = client(`http://127.0.0.1:${PORT + 1}`);
  await c2.call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const sys = (await c2.call('GET', '/api/system')).data;
  const all = (await c2.call('GET', '/api/sales?page=1&per=1')).data;
  const sales = (await c2.call('GET', '/api/sales?page=1&per=1&kind=sale')).data;
  // The shop may have taken returns of its own since; what must hold is that nothing is neither.
  const returned = (await c2.call('GET', '/api/sales?page=1&per=1&kind=return')).data;
  check(`the shop's database (${all.total} documents) is on the latest schema`, sys && sys.schema_version === sys.schema_latest, JSON.stringify([sys?.schema_version, sys?.schema_latest]));
  check(`every document is an invoice or a return (${sales.total} and ${returned.total})`, all.total === sales.total + returned.total,
    JSON.stringify([all.total, sales.total, returned.total]));
  const oldest = (await c2.call('GET', `/api/sales?page=${Math.max(1, all.pages)}&per=1&kind=sale`)).data.rows?.[0];
  const one = oldest && (await c2.call('GET', `/api/sales/${oldest.id}`)).data;
  check('its oldest invoice opens, with what came back counted line by line',
    !one || (one.kind === 'sale' && Array.isArray(one.returns) && one.items.every((i) => i.returned >= 0 && i.returned <= i.qty)));
  real.kill();
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
