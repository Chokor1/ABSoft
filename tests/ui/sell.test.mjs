/**
 * Sell: the invoice list (POS invoices included) and a sale entered by hand as a
 * document, the way a purchase is.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'sellui');
const PORT = 4561;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

console.log('\n[the menu]');
const menu = await page.$$eval('.nav [data-route]', (a) => a.map((x) => x.dataset.route));
check('Sell leads Selling and Buy leads Buying, POS is in the top bar', menu.indexOf('sales') === 1 && menu.indexOf('sales') < menu.indexOf('customers') &&
  menu.indexOf('customers') < menu.indexOf('purchases') && menu[menu.indexOf('purchases') + 1] === 'suppliers' &&
  !menu.includes('pos') && (await page.isVisible('#go-pos')), menu.join());
check('Sell is labelled Sell and Buy is labelled Buy',
  (await page.textContent('.nav [data-route="sales"]')).trim() === 'Sell' &&
  (await page.textContent('.nav [data-route="purchases"]')).replace(/F\d/, '').trim() === 'Buy');

console.log('\n[the POS takes the whole screen]');
await page.click('#go-pos');
await page.waitForSelector('.pos .tile');
await page.waitForTimeout(600);
const posLayout = () => page.evaluate(() => ({
  left: Math.round(document.querySelector('.main').getBoundingClientRect().left),
  mark: getComputedStyle(document.querySelector('.topbar-mark')).display !== 'none',
}));
let layout = await posLayout();
check('the sidebar slides away and the ABSoft mark sits in the top bar', layout.left === 0 && layout.mark && !(await page.isVisible('#go-pos')), JSON.stringify(layout));
await page.click('.topbar-mark');
await page.waitForFunction(() => location.hash === '#/dashboard');
await page.waitForTimeout(600);
layout = await posLayout();
check('the mark leads home, and the sidebar comes back', layout.left > 200 && !layout.mark, JSON.stringify(layout));

console.log('\n[the Sell list]');
await page.click('.nav [data-route="sales"]');
await page.waitForSelector('#new');
check('Sell lists the invoices from the POS', (await page.$$('tbody tr[data-open]')).length > 0);
check('with New sale, and POS in the top bar', await page.isVisible('#new') && await page.isVisible('#go-pos'));

console.log('\n[a sale entered by hand]');
await page.click('#new');
await page.waitForSelector('#sale-form [data-product="0"]');
check('New sale opens a document form with one line ready', page.url().endsWith('#/sales/new'));
const menuOpen = () => page.evaluate(() => [...document.querySelectorAll('.combo-menu')].some((m) => !m.hidden));
await page.waitForTimeout(600);
check('the first line has the cursor, but its product list stays closed', !(await menuOpen()) &&
  (await page.evaluate(() => document.activeElement?.dataset.product === '0')));
await page.goto(`${BASE}#/purchases/new`);
await page.waitForSelector('#purchase-form [data-product="0"]');
await page.waitForTimeout(600);
check('the same on a new purchase', !(await menuOpen()));
await page.goto(`${BASE}#/sales/new`);
await page.waitForSelector('#sale-form [data-product="0"]');
await page.fill('input[name=customer]', 'Hadi Bakery');
const products = await api('/api/products?limit=3');
const [p1, p2] = products;

// Type a product's name, wait for the list to offer it, pick it, and wait for the line to take it.
const pickProduct = async (line, name) => {
  await page.keyboard.type(name);
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.combo-menu:not([hidden]) .combo-item.active')].some((el) => el.textContent.includes(n)),
    name,
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction((i) => document.querySelector(`[data-stock="${i}"]`)?.textContent.includes('in stock'), line);
};
await page.click('[data-product="0"]');
await pickProduct(0, p1.name);
check('picking a product fills its price and shows its stock',
  near(await page.inputValue('[data-price="0"]'), p1.price) && (await page.textContent('[data-stock="0"]')).includes('in stock'));
await page.fill('[data-qty="0"]', '3');

await page.click('#add-line');
await pickProduct(1, p2.name);
await page.fill('[data-qty="1"]', '2');
await page.fill('[data-price="1"]', '10');
await page.fill('[data-discount="1"]', '1');
await page.fill('#invoice-discount', '2');
await page.waitForTimeout(150);

const expected = 3 * p1.price + (2 * 10 - 1) - 2;
check('the totals follow as you type', (await page.textContent('#sums')).includes(expected.toFixed(2)), await page.textContent('#sums'));
check('paid in full until told otherwise', near(await page.inputValue('input[name=paid]'), expected));
await page.fill('input[name=paid]', '5');
await page.waitForTimeout(150);
check('paying less leaves the rest owing', (await page.textContent('#sums')).includes((expected - 5).toFixed(2)));
await shot('180-sell-new-sale');

await page.click('#save-sale');
await page.waitForSelector('.doc-head', { timeout: 8000 });
check('saving opens the new invoice', /#\/sales\/\d+$/.test(page.url()));
const sale = await api(`/api/sales/${page.url().match(/(\d+)$/)[1]}`);
check('with its customer, lines, discounts and payment', sale.customer === 'Hadi Bakery' && sale.items.length === 2 &&
  near(sale.discount, 2) && near(sale.total, expected) && near(sale.paid, 5) && sale.items[1].discount === 1,
  JSON.stringify({ c: sale.customer, t: sale.total, p: sale.paid, d: sale.discount }));
const after = await api(`/api/products/${p1.id}`);
check('and the stock went out', near(after.stock, p1.stock - 3));

await page.goto(`${BASE}#/sales`);
await page.waitForSelector('tbody tr[data-open]');
check('it lists in Sell beside the POS invoices', (await page.textContent('tbody tr[data-open]:first-child')).includes('Hadi Bakery'));

await page.click('#new');
await page.waitForSelector('#save-sale');
await page.click('#save-sale');
await page.waitForTimeout(300);
check('an empty sale is refused', page.url().endsWith('#/sales/new') && (await page.textContent('#toasts')).includes('Add at least one product'));

console.log('\n[reports]');
await page.goto(`${BASE}#/reports`);
await page.waitForSelector('#report-tabs');
check('Reports has a Sales analysis tab', (await page.textContent('#report-tabs')).includes('Sales analysis'));
await page.click('#report-tabs [data-tab="stock"]');
await page.waitForTimeout(500);
check('a report tab is kept in the address', page.url().endsWith('#/reports/stock'));
await page.click('#report-tabs [data-tab="analysis"]');
await page.waitForSelector('.an-table');
await page.click('#report-tabs [data-tab="pnl"]');
await page.waitForSelector('.pnl');
check('and back from Sales analysis to another report', page.url().endsWith('#/reports/pnl'));

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
