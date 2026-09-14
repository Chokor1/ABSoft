/** The second currency in the browser: switching it on, the sidebar rate, live prices, and paying in L.L. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'currency');
const PORT = 4537;
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
const errors = [];
async function signIn(username, password) {
  // Each person gets their own browser profile, so sessions do not mix.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${username}: ${e.message}`));
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');
  return page;
}
const api = (page, method, path, body) =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  }, { method, path, body });
const digits = (s) => Number(String(s).replace(/[^\d.]/g, ''));

const page = await signIn('admin', 'admin');
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

console.log('\n[switching the second currency on]');
check('no rate box while it is off', await page.$eval('#rate-box', (el) => el.hidden));
await page.goto(`${BASE}#/settings`);
await page.waitForSelector('#currency2-form');
await page.check('#currency2-form input[name=currency2_enabled]');
await page.fill('#currency2-form input[name=currency2_rate]', '89500');
check('the form shows an example while typing', (await page.textContent('#currency2-example')).includes('895,000'), await page.textContent('#currency2-example'));
await page.click('#currency2-form button[type=submit]');
await page.waitForSelector('#rate-box:not([hidden])', { timeout: 5000 });
const boxText = (await page.textContent('#rate-box')).replace(/\s+/g, ' ');
check('the sidebar now shows the rate', boxText.includes('1 $ = 89,500 L.L'), boxText);
await shot('100-currency-settings');

console.log('\n[prices at the till follow the rate]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
const firstPrice = digits(await page.textContent('.tile .t-price'));
const firstSecond = await page.textContent('.tile .money2');
check('each card shows the price in L.L too', digits(firstSecond) === Math.round(firstPrice * 89500) && firstSecond.includes('L.L'), `${firstPrice} → ${firstSecond}`);

await page.click('#rate-edit');
await page.fill('#rate-input', '90000');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const afterRate = await page.textContent('.tile .money2');
check('changing the rate in the sidebar reprices every card at once', digits(afterRate) === Math.round(firstPrice * 90000), afterRate);
check('without reloading the page', (await page.$$('.tile')).length > 0 && page.url().endsWith('#/pos'));
check('the box shows the new rate', (await page.textContent('#rate-box')).includes('90,000'));

await page.click('.tile');
await page.waitForTimeout(200);
check('the cart total shows L.L', (await page.textContent('#totals')).includes('L.L'));
await shot('101-currency-pos');

console.log('\n[paying in L.L]');
await page.click('#checkout');
await page.waitForSelector('#pay-amount2');
check('the payment dialog has a box for each currency', await page.isVisible('#pay-amount') && (await page.isVisible('#pay-amount2')));
check('the amount due is shown in both', (await page.textContent('.pay-due')).includes('L.L'));
await page.click('#pay-all2');
await page.waitForTimeout(200);
check('"All in L.L" fills in the whole invoice in L.L', digits(await page.inputValue('#pay-amount2')) === Math.round(firstPrice * 90000) && Number(await page.inputValue('#pay-amount')) === 0);
check('which settles it', (await page.getAttribute('#pay-result', 'class')).includes('settled'));
await shot('102-currency-payment');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
const receipt = await page.textContent('.receipt');
check('the receipt shows the L.L paid', receipt.includes('Paid in L.L'), receipt.replace(/\s+/g, ' '));
await shot('103-currency-receipt');
await page.click('.modal-head [data-close]');

console.log('\n[paying in both]');
await page.click('.tile');
await page.click('#checkout');
await page.waitForSelector('#pay-amount2');
const due = digits(await page.textContent('#pay-due'));
await page.fill('#pay-amount2', String(Math.round((due / 2) * 90000)));
await page.waitForTimeout(200);
check('typing L.L leaves the rest to pay in $', Math.abs(Number(await page.inputValue('#pay-amount')) - due / 2) < 0.02, await page.inputValue('#pay-amount'));
await page.fill('#pay-amount', String(due));
await page.waitForTimeout(200);
const change = await page.textContent('#pay-result');
check('overpaying shows the change in both currencies', change.includes('Change') && change.includes('L.L'), change);
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
await page.click('.modal-head [data-close]');

console.log('\n[the product pages]');
await page.goto(`${BASE}#/products`);
await page.waitForSelector('.table-scroll thead');
check('the product list has a price-in-L.L column', (await page.textContent('.table-scroll thead')).includes('Price in L.L'));
await page.click('.table-scroll tbody tr:first-child');
await page.waitForSelector('#price2');
await page.fill('input[name=price]', '2');
await page.waitForTimeout(100);
check('the details show the price in L.L, following the price as it is typed', digits(await page.textContent('#price2')) === 180000, await page.textContent('#price2'));

console.log('\n[settling a debt in L.L later]');
const [p] = await api(page, 'GET', '/api/products?limit=1');
const owed = await api(page, 'POST', '/api/sales', { customer: 'Later Payer', paid: 0, items: [{ product_id: p.id, qty: 1, unit_price: 10 }] });
await page.goto(`${BASE}#/sales/${owed.id}`);
await page.waitForSelector('[data-pay]');
check('the invoice page shows the balance in L.L', (await page.textContent('.sale-summary')).includes('900,000'), await page.textContent('.sale-summary'));
await page.click('[data-pay]');
await page.waitForSelector('#modal-form select[name=currency]');
await page.selectOption('#modal-form select[name=currency]', 'second');
check('choosing L.L converts the balance', digits(await page.inputValue('#modal-form input[name=amount]')) === 900000, await page.inputValue('#modal-form input[name=amount]'));
await page.click('.modal-foot button[type=submit]');
await page.waitForTimeout(1000);
check('paying it in L.L settles the invoice', (await page.textContent('.doc-head')).includes('paid'));
check('the payment shows the L.L handed over and the rate', (await page.textContent('.doc-body')).includes('900,000 L.L'));
await shot('104-currency-invoice');

console.log('\n[a cashier]');
await api(page, 'POST', '/api/users', { username: 'fx-ui', password: 'test1234', role: 'cashier' });
const till = await signIn('fx-ui', 'test1234');
await till.waitForSelector('#rate-box:not([hidden])', { timeout: 4000 });
check('sees the rate in the sidebar', (await till.textContent('#rate-box')).includes('90,000'));
check('but cannot edit it', (await till.$$('#rate-edit')).length === 0);
await till.close();

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
