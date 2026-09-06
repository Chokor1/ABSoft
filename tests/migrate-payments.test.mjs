/**
 * A shop already running v1.2 (schema v2) updates to the payment ledger.
 * Its settled invoices must come through as settled, not as debt.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Anchored to this file, so the suite runs from any clone on any machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const WORK = resolve(APP, '.test-run');


const DATA = resolve(WORK, 'paymigdata');
const PORT = 4513;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const start = () => {
  const s = spawn('node', ['--no-warnings', 'server/index.js'], {
    cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.log = '';
  s.stdout.on('data', (d) => (s.log += d));
  s.stderr.on('data', (d) => (s.log += d));
  return s;
};
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
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

/* 1. Build a shop on the current build, then wind it back to schema v2. ----- */
console.log('\n[a shop trading on the previous version]');
rmSync(DATA, { recursive: true, force: true });
let server = start();
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + server.log); process.exit(1); }
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const prod = (await call('POST', '/api/products', {
  name: 'Legacy Widget', barcode: 'LEG-1', cost: 6, price: 20, opening_stock: 200,
})).data;
const paidSale = (await call('POST', '/api/sales', {
  customer: 'Old Customer', paid: 60, items: [{ product_id: prod.id, qty: 3, unit_price: 20 }],
})).data;
const creditSale = (await call('POST', '/api/sales', {
  customer: 'Slow Payer', paid: 0, items: [{ product_id: prod.id, qty: 2, unit_price: 20 }],
})).data;
server.kill();
await new Promise((r) => setTimeout(r, 800));

{
  const db = new DatabaseSync(join(DATA, 'absoft.db'));
  db.exec('DROP TABLE IF EXISTS payments');
  db.exec('PRAGMA user_version = 2');
  const rows = db.prepare('SELECT id, paid, total FROM sales ORDER BY id').all();
  check('wound back to schema v2', Number(db.prepare('PRAGMA user_version').get().user_version) === 2);
  check('the payments table is gone',
    !db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='payments'`).get());
  check('the old paid figures are still on the sales',
    near(rows[0].paid, 60) && near(rows[1].paid, 0), JSON.stringify(rows));
  db.close();
}

/* 2. Update. ---------------------------------------------------------------- */
console.log('\n[installing the update]');
server = start();
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + server.log); process.exit(1); }
check('it starts on the old database', true);
check('the log shows the payment migration', /migrated\s+v3/.test(server.log), server.log.slice(0, 300));

cookie = '';
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

const paidAfter = (await call('GET', `/api/sales/${paidSale.id}`)).data;
check('a settled invoice is still settled', near(paidAfter.balance, 0), String(paidAfter.balance));
check('its paid amount survived', near(paidAfter.paid, 60), String(paidAfter.paid));
check('it now has one instalment, back-filled', paidAfter.payments.length === 1);
check('dated as the original sale', paidAfter.payments[0].date === paidSale.date,
  `${paidAfter.payments[0].date} vs ${paidSale.date}`);
check('and carrying the original method', paidAfter.payments[0].method === paidSale.method);

const creditAfter = (await call('GET', `/api/sales/${creditSale.id}`)).data;
check('an unpaid invoice is still unpaid', near(creditAfter.balance, 40), String(creditAfter.balance));
check('with no instalment invented for it', creditAfter.payments.length === 0);

check('receivables finds only the real debt',
  near((await call('GET', '/api/reports/receivables')).data.total, 40),
  String((await call('GET', '/api/reports/receivables')).data.total));

console.log('\n[and it carries on working]');
const settled = (await call('POST', `/api/sales/${creditSale.id}/payments`, { amount: 40 })).data;
check('the old invoice can now be settled', near(settled.balance, 0));
check('stock was never touched by any of this',
  near((await call('GET', `/api/products/${prod.id}`)).data.stock, 195),
  String((await call('GET', `/api/products/${prod.id}`)).data.stock));

server.kill();
await new Promise((r) => setTimeout(r, 700));

/* 3. Re-running the migration must not duplicate the back-fill. ------------- */
console.log('\n[the migration does not run twice]');
server = start();
await wait(async () => (await fetch(BASE + '/')).ok);
check('a second start applies nothing', !/migrated/.test(server.log), server.log.slice(0, 200));
cookie = '';
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const recheck = (await call('GET', `/api/sales/${paidSale.id}`)).data;
check('the settled invoice still has exactly one instalment', recheck.payments.length === 1,
  String(recheck.payments.length));
check('and is not double-counted as paid', near(recheck.paid, 60), String(recheck.paid));
server.kill();

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
