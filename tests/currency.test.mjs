/** The second currency: settings, the rate and its history, and paying in either currency or both. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'currencydata');
const PORT = 4535;
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
const admin = cookie;
const item = (await call('POST', '/api/products', { name: 'Ten Dollar Item', barcode: 'FX-10', cost: 4, price: 10, opening_stock: 500 })).data;
const sell = (body) => call('POST', '/api/sales', { items: [{ product_id: item.id, qty: 1, unit_price: 10 }], ...body });

console.log('\n[off by default]');
const defaults = (await call('GET', '/api/settings')).data;
check('the second currency starts switched off', defaults.currency2_enabled === '0' && defaults.currency2_symbol === 'L.L', JSON.stringify(defaults));
check('paying in it is refused while it is off',
  (await sell({ tenders: [{ currency: 'second', amount: 1000000 }] })).data.code === 'SECOND_CURRENCY_OFF');

console.log('\n[switching it on]');
const on = await call('PUT', '/api/settings', { currency2_enabled: '1', currency2_symbol: 'L.L', currency2_decimals: '0', currency2_rate: '100000' });
check('an administrator switches it on with a rate', on.data.currency2_enabled === '1' && on.data.currency2_rate === '100000', JSON.stringify(on.data));
const rate = await call('PUT', '/api/exchange-rate', { rate: 90000 });
check('the sidebar rate box updates the rate', rate.data.currency2_rate === '90000');
check('a rate of zero is refused', (await call('PUT', '/api/exchange-rate', { rate: 0 })).data.code === 'RATE_POSITIVE');
const history = (await call('GET', '/api/exchange-rates')).data;
check('every rate change is kept, newest first', history.length === 2 && history[0].rate === 90000 && history[1].rate === 100000 && history[0].username === 'admin',
  JSON.stringify(history));
await call('PUT', '/api/exchange-rate', { rate: 100000 });

console.log('\n[paying in both currencies]');
const mixed = (await sell({ tenders: [{ currency: 'base', amount: 4 }, { currency: 'second', amount: 600000 }] })).data;
check('$4 and 600,000 L.L settle a $10 invoice', near(mixed.paid, 10) && near(mixed.balance, 0), JSON.stringify({ paid: mixed.paid, balance: mixed.balance }));
check('the invoice remembers the rate of its day', mixed.rate2 === 100000);
const [p1, p2] = mixed.payments;
check('one payment row per currency', mixed.payments.length === 2);
check('the dollar part is a plain payment', p1.currency === '' && near(p1.amount, 4) && p1.amount2 === null, JSON.stringify(p1));
check('the L.L part keeps what was handed over and the rate', p2.currency === 'second' && near(p2.amount, 6) && p2.amount2 === 600000 && p2.rate === 100000, JSON.stringify(p2));
check('no change is due', mixed.change === 0 && mixed.change2 === 0, JSON.stringify({ c: mixed.change, c2: mixed.change2 }));

console.log('\n[change]');
const over = (await sell({ tenders: [{ currency: 'second', amount: 1500000 }] })).data;
check('1,500,000 L.L for $10 leaves $5 change', near(over.change, 5) && over.change2 === 500000, JSON.stringify({ c: over.change, c2: over.change2 }));
check('only what paid the invoice is recorded', over.payments.length === 1 && near(over.payments[0].amount, 10) && over.payments[0].amount2 === 1000000,
  JSON.stringify(over.payments));
const dollars = (await sell({ tenders: [{ currency: 'base', amount: 20 }, { currency: 'second', amount: 100000 }] })).data;
check('dollars are counted first, so L.L on top of enough dollars is all change',
  dollars.payments.length === 1 && dollars.payments[0].currency === '' && near(dollars.change, 11) && dollars.change2 === 1100000,
  JSON.stringify({ payments: dollars.payments, c: dollars.change, c2: dollars.change2 }));

console.log('\n[owing, then settling in L.L]');
const part = (await sell({ tenders: [{ currency: 'second', amount: 300000 }] })).data;
check('300,000 L.L leaves $7 owing', near(part.paid, 3) && near(part.balance, 7), JSON.stringify({ paid: part.paid, balance: part.balance }));
check('too much in L.L is refused', (await call('POST', `/api/sales/${part.id}/payments`, { currency: 'second', amount: 900000 })).data.code === 'PAYMENT_TOO_LARGE');
await call('PUT', '/api/exchange-rate', { rate: 89500 });
const settled = (await call('POST', `/api/sales/${part.id}/payments`, { currency: 'second', amount: 626500 })).data;
check('the rest in L.L at today\'s rate settles it', near(settled.balance, 0), JSON.stringify({ balance: settled.balance, paid: settled.paid }));
const last = settled.payments.at(-1);
check('and that payment keeps today\'s rate', last.currency === 'second' && last.rate === 89500 && last.amount2 === 626500, JSON.stringify(last));
check('the invoice still shows its own day\'s rate', settled.rate2 === 100000);

console.log('\n[unchanged for dollars only]');
const plain = (await sell({ paid: 10 })).data;
check('paying with plain "paid" still works', near(plain.paid, 10) && plain.payments.length === 1 && plain.payments[0].currency === '');
const untold = (await sell({})).data;
check('and no amount at all still means paid in full', near(untold.balance, 0));

console.log('\n[a cashier]');
await call('POST', '/api/users', { username: 'fx-till', password: 'test1234', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'fx-till', password: 'test1234' });
check('sees the rate', (await call('GET', '/api/settings')).data.currency2_rate === '89500');
check('can take L.L at the till', (await sell({ tenders: [{ currency: 'second', amount: 895000 }] })).status === 200);
check('cannot change the rate', (await call('PUT', '/api/exchange-rate', { rate: 1 })).status === 403);
cookie = admin;

console.log('\n[switching it off]');
await call('PUT', '/api/settings', { currency2_enabled: '0' });
check('L.L is refused again once off', (await sell({ tenders: [{ currency: 'second', amount: 895000 }] })).data.code === 'SECOND_CURRENCY_OFF');
check('the rate is kept for next time', (await call('GET', '/api/settings')).data.currency2_rate === '89500');
const noRate = (await sell({ paid: 10 })).data;
check('new invoices carry no rate while it is off', noRate.rate2 === null);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
