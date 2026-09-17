/** Partial payments: the ledger, the balance, and what it must not disturb. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Anchored to this file, so the suite runs from any clone on any machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const WORK = resolve(APP, '.test-run');


const DATA = resolve(WORK, 'paydata');
const PORT = 4511;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

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

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const product = (await call('POST', '/api/products', {
  name: 'Payment Test Item', barcode: 'PAY-1', cost: 4, price: 25, opening_stock: 500,
})).data;
const sell = (qty, paid, customer = 'Debtor Co') =>
  call('POST', '/api/sales', { customer, paid, items: [{ product_id: product.id, qty, unit_price: 25 }] });

// The shop's own date, as the server records it — not UTC, which is a day off at night.
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------------ */
console.log('\n[paying in full, as before]');
const full = await sell(4, 100);
check('a fully paid sale reports no balance', near(full.data.balance, 0), String(full.data.balance));
check('paid equals the total', near(full.data.paid, 100), String(full.data.paid));
check('it records one instalment', full.data.payments.length === 1);

console.log('\n[overpaying is change, not credit]');
const over = await sell(4, 150);
check('paid is capped at the total', near(over.data.paid, 100), String(over.data.paid));
check('and the balance is zero, not negative', near(over.data.balance, 0), String(over.data.balance));

console.log('\n[paying part of it]');
const part = await sell(4, 30);
check('the sale is accepted', part.status === 200);
check('paid is what was handed over', near(part.data.paid, 30), String(part.data.paid));
check('the balance is the rest', near(part.data.balance, 70), String(part.data.balance));
check('one instalment so far', part.data.payments.length === 1);

console.log('\n[paying nothing now]');
const none = await sell(2, 0);
check('a sale on account is accepted', none.status === 200);
check('nothing is paid', near(none.data.paid, 0));
check('the whole total is owed', near(none.data.balance, 50), String(none.data.balance));
check('and it has no instalments', none.data.payments.length === 0);

console.log('\n[settling over time]');
let sale = (await call('POST', `/api/sales/${part.data.id}/payments`, { amount: 20, method: 'cash' })).data;
check('a second instalment reduces the balance', near(sale.balance, 50), String(sale.balance));
check('paid is the running total', near(sale.paid, 50), String(sale.paid));
check('both instalments are listed', sale.payments.length === 2);

sale = (await call('POST', `/api/sales/${part.data.id}/payments`, { amount: 50, method: 'transfer', note: 'final' })).data;
check('the last instalment clears it', near(sale.balance, 0), String(sale.balance));
check('three instalments recorded', sale.payments.length === 3);
check('the note is kept', sale.payments[2].note === 'final');
check('each instalment keeps its own method', sale.payments.map((p) => p.method).join(',') === 'cash,cash,transfer',
  sale.payments.map((p) => p.method).join(','));

console.log('\n[you cannot pay more than is owed]');
const tooMuch = await call('POST', `/api/sales/${part.data.id}/payments`, { amount: 10 });
check('a payment on a settled invoice is refused', tooMuch.status === 400, JSON.stringify(tooMuch.data));
check('it says how much was actually owed', tooMuch.data.code === 'PAYMENT_TOO_LARGE', tooMuch.data.code);
const over2 = await call('POST', `/api/sales/${none.data.id}/payments`, { amount: 999 });
check('overpaying a partly-owed invoice is refused', over2.status === 400);
check('zero is refused', (await call('POST', `/api/sales/${none.data.id}/payments`, { amount: 0 })).status === 400);
check('a negative amount is refused', (await call('POST', `/api/sales/${none.data.id}/payments`, { amount: -5 })).status === 400);
check('paying exactly the balance is allowed',
  (await call('POST', `/api/sales/${none.data.id}/payments`, { amount: 50 })).status === 200);

console.log('\n[removing a payment puts it back on the invoice]');
const partial2 = (await sell(4, 40)).data;
const paymentId = partial2.payments[0].id;
const afterDelete = (await call('DELETE', `/api/payments/${paymentId}`)).data;
check('the balance goes back up', near(afterDelete.balance, 100), String(afterDelete.balance));
check('paid drops to zero', near(afterDelete.paid, 0));
check('the sale itself is untouched', near(afterDelete.total, 100) && afterDelete.items.length === 1);
check('removing a payment twice is refused', (await call('DELETE', `/api/payments/${paymentId}`)).status === 404);

console.log('\n[finding what is owed]');
const unpaid = (await call('GET', '/api/sales?unpaid=1&from=2000-01-01&to=2100-01-01')).data;
check('the unpaid filter returns only invoices with a balance',
  unpaid.length > 0 && unpaid.every((s) => s.balance > 0.004), JSON.stringify(unpaid.map((s) => s.balance)));
check('fully paid invoices are excluded', !unpaid.some((s) => s.id === full.data.id));

const receivables = (await call('GET', '/api/reports/receivables')).data;
check('receivables totals the outstanding balances',
  near(receivables.total, unpaid.reduce((a, s) => a + s.balance, 0)),
  `${receivables.total} vs ${unpaid.reduce((a, s) => a + s.balance, 0)}`);
check('and groups it by customer', receivables.by_customer.length >= 1);
check('the dashboard reports the same figure',
  near((await call('GET', '/api/reports/dashboard')).data.receivable.balance, receivables.total));

console.log('\n[revenue is unaffected - this is accrual accounting]');
const pnl = (await call('GET', `/api/reports/pnl?from=${today}&to=${today}`)).data;
const allSales = (await call('GET', `/api/sales?from=${today}&to=${today}`)).data;
const grossSold = allSales.reduce((a, s) => a + s.total, 0);
check('a sale counts as revenue whether or not it has been paid',
  near(pnl.revenue, grossSold), `${pnl.revenue} vs ${grossSold}`);
check('profit is unchanged by payment timing',
  near(pnl.gross_profit, allSales.reduce((a, s) => a + s.profit, 0)));

console.log('\n[stock is unaffected too]');
const sold = allSales.reduce((a, s) => a + s.total_qty, 0);
check('stock moved on the sale, not the payment',
  near((await call('GET', `/api/products/${product.id}`)).data.stock, 500 - sold),
  String((await call('GET', `/api/products/${product.id}`)).data.stock));

console.log('\n[voiding a sale removes its payments]');
const toVoid = (await sell(2, 25)).data;
check('it has a payment', toVoid.payments.length === 1);
await call('DELETE', `/api/sales/${toVoid.id}`);
check('the sale is gone', (await call('GET', `/api/sales/${toVoid.id}`)).status === 404);
check('and its payment cannot be deleted separately',
  (await call('DELETE', `/api/payments/${toVoid.payments[0].id}`)).status === 404);

console.log('\n[permissions]');
await call('POST', '/api/users', { username: 'till9', password: 'test1234', role: 'cashier' });
const adminCookie = cookie;
const owing = (await sell(4, 10)).data;
cookie = '';
await call('POST', '/api/auth/login', { username: 'till9', password: 'test1234' });
check('a cashier can take a payment',
  (await call('POST', `/api/sales/${owing.id}/payments`, { amount: 15 })).status === 200);
check('but cannot remove one',
  (await call('DELETE', `/api/payments/${owing.payments[0].id}`)).status === 400);
cookie = adminCookie;

console.log('\n[the cached total always matches the ledger]');
const drift = await call('GET', '/api/sales?from=2000-01-01&to=2100-01-01&limit=500');
let mismatches = 0;
for (const s of drift.data) {
  const detail = (await call('GET', `/api/sales/${s.id}`)).data;
  const sum = detail.payments.reduce((a, p) => a + p.amount, 0);
  if (!near(sum, detail.paid) || !near(detail.total - sum, detail.balance)) mismatches++;
}
check('every invoice agrees with its own payment rows', mismatches === 0, `${mismatches} mismatched`);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
