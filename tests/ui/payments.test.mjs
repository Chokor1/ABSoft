/** Taking a partial payment at the till, then settling it from Sales History. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Anchored to this file, so the suite runs from any clone on any machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');


const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'payuidata');
const PORT = 4515;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

rmSync(DATA, { recursive: true, force: true });
const seed = spawn('node', ['--no-warnings', 'server/tools/seed.js'], { cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA } });
await new Promise((r) => seed.on('exit', r));
const server = spawn('node', ['--no-warnings', 'server/index.js'], {
  cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed'); process.exit(1); }

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: `${SHOTS}\\${n}.png` });

const signIn = async (u = 'admin', p = 'admin') => {
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');
};
await signIn();

/* -------------------------------------------------- a partial sale at the till */
console.log('\n[taking part of the money at the till]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await page.fill('#scan', '5901234123457');   // Espresso Beans, 18.00
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');

await page.click('#checkout');
await page.waitForSelector('#pay-amount');
await page.fill('#pay-customer', 'Part Payer');
check('the payment dialog shows what is due', (await page.textContent('#pay-due')).includes('$18.00'),
  await page.textContent('#pay-due'));
check('it offers the full amount by default', Number(await page.inputValue('#pay-amount')) === 18,
  await page.inputValue('#pay-amount'));
check('which reads as settled', (await page.textContent('#pay-result')).includes('Settled'),
  await page.textContent('#pay-result'));

await page.fill('#pay-amount', '20');
await page.waitForTimeout(200);
check('overpaying shows the change to hand back',
  (await page.textContent('#pay-result')).includes('Change') &&
  (await page.textContent('#pay-result')).includes('$2.00'), await page.textContent('#pay-result'));

await page.fill('#pay-amount', '5');
await page.waitForTimeout(200);
check('underpaying shows what remains, live',
  (await page.textContent('#pay-result')).includes('Remaining') &&
  (await page.textContent('#pay-result')).includes('$13.00'), await page.textContent('#pay-result'));
check('there are no quick-amount buttons', (await page.$$('[data-quick]')).length === 0);
await shot('79-payment-step');

await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
const receipt = await page.textContent('.receipt');
check('saving goes straight to the receipt', true);
check('the receipt shows what was paid', receipt.includes('$5.00'));
check('and what is still owed', receipt.includes('$13.00'), receipt.replace(/\s+/g, ' ').slice(0, 200));
check('right after the sale there is no Record payment button', (await page.$$('[data-pay]')).length === 0);
await shot('80-receipt-partial');
await page.click('.modal-foot [data-close]');

/* ------------------------------------------------------ sales history shows it */
console.log('\n[it shows up as owed]');
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
const row = await page.textContent('tr:has-text("Part Payer")');
check('the row shows the paid amount', row.includes('$5.00'), row.replace(/\s+/g, ' '));
check('the row shows the balance', row.includes('$13.00'), row.replace(/\s+/g, ' '));
check('and is marked part paid', row.includes('part paid'), row.replace(/\s+/g, ' '));
check('the header totals what is owed', (await page.textContent('.card-head')).includes('Owed'));
check('rows that owe offer to take payment directly',
  await page.isVisible('tr:has-text("Part Payer") [data-pay-row]'));
check('settled rows do not', (await page.$$('tr:has-text("Walk-in") [data-pay-row]')).length === 0);
await shot('81-sales-balances');

await page.check('#unpaid-only');
await page.waitForTimeout(900);
const filtered = await page.$$eval('table.data tbody tr', (r) => r.map((x) => x.textContent));
check('the unpaid filter narrows to invoices with a balance',
  filtered.length > 0 && filtered.every((r) => !r.includes('paid') || r.includes('part paid') || r.includes('unpaid')),
  String(filtered.length));
check('our partly paid invoice is among them', filtered.some((r) => r.includes('Part Payer')));
await page.uncheck('#unpaid-only');
await page.waitForTimeout(800);

/* ------------------------------------------------------------ settling it later */
console.log('\n[settling it later]');
await page.click('tr:has-text("Part Payer")');
await page.waitForSelector('.receipt');
await page.click('[data-pay]');
await page.waitForSelector('#modal-form');
check('the payment form knows the balance',
  (await page.textContent('.modal-head')).includes('$13.00'), await page.textContent('.modal-head'));
check('and pre-fills it', Number(await page.inputValue('input[name=amount]')) === 13,
  await page.inputValue('input[name=amount]'));

await page.fill('input[name=amount]', '8');
await page.selectOption('select[name=method]', 'card');
await page.click('.modal-foot button[type=submit]');
await page.waitForTimeout(1200);
check('the toast reports the new balance', (await page.textContent('.toasts')).includes('$5.00'));
const after = await page.textContent('.modal-body');
check('the reopened receipt shows both instalments',
  (after.match(/Cash|Card/g) || []).length >= 2, after.replace(/\s+/g, ' ').slice(0, 300));
await shot('82-payment-history');

await page.click('[data-pay]');
await page.waitForSelector('#modal-form');
await page.click('.modal-foot button[type=submit]');
await page.waitForTimeout(1200);
check('paying the rest settles it', (await page.textContent('.toasts')).includes('settled'));
check('the receipt no longer offers to take payment', !(await page.isVisible('[data-pay]')));
await page.click('.modal-foot [data-close]');
await page.waitForTimeout(800);

const settledRow = await page.textContent('tr:has-text("Part Payer")');
check('the list now marks it paid', settledRow.includes('paid') && !settledRow.includes('part paid'),
  settledRow.replace(/\s+/g, ' '));
check('with nothing owed', settledRow.includes('$0.00'), settledRow.replace(/\s+/g, ' '));

/* --------------------------------------------------------------- removing one */
console.log('\n[removing a payment]');
await page.click('tr:has-text("Part Payer")');
await page.waitForSelector('.receipt');
await page.click('[data-del-pay]');
await page.waitForSelector('[data-confirm]');
await page.click('[data-confirm]');
await page.waitForTimeout(1200);
check('the balance comes back', (await page.textContent('.modal-body')).includes('Balance due'),
  (await page.textContent('.modal-body')).replace(/\s+/g, ' ').slice(0, 200));
await page.click('.modal-foot [data-close]');

/* ----------------------------------------------------------------- dashboard */
console.log('\n[the dashboard flags it]');
await page.goto(`${BASE}#/dashboard`);
await page.waitForSelector('.stat');
check('the recent sales card shows what is owed', (await page.textContent('.page')).includes('Owed'));

/* -------------------------------------------------------------------- Arabic */
console.log('\n[Arabic]');
await page.click('.topbar [data-lang="ar"]');
await page.waitForTimeout(800);
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
check('the balance column is translated', (await page.textContent('thead')).includes('المتبقّي'));
check('the status is translated', (await page.textContent('tbody')).includes('مدفوعة'));
await page.click('tr:has-text("Part Payer")');
await page.waitForSelector('.receipt');
check('the payments section is translated', (await page.textContent('.modal-body')).includes('الدفعات'));
check('and the record-payment button', (await page.textContent('[data-pay]')).includes('تسجيل دفعة'));
await shot('83-payments-ar');
await page.click('.modal-foot [data-close]');
await page.click('.topbar [data-lang="en"]');
await page.waitForTimeout(600);

/* --------------------------------------------------------------- cashier */
console.log('\n[cashiers]');
await page.goto(`${BASE}#/users`);
await page.waitForTimeout(800);
await page.click('#new');
await page.waitForSelector('#page-form');
await page.fill('input[name=username]', 'till5');
await page.fill('input[name=password]', 'test1234');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(1000);
await page.click('#user-menu');
await page.waitForSelector('[data-pick="logout"]');
await page.click('[data-pick="logout"]');
await page.waitForSelector('#login-form');
await signIn('till5', 'test1234');

await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
await page.click('tr:has-text("Part Payer")');
await page.waitForSelector('.receipt');
check('a cashier can record a payment', await page.isVisible('[data-pay]'));
check('but cannot remove one', (await page.$$('[data-del-pay]')).length === 0);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
