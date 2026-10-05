/**
 * The cashier's narrower app, the stock adjustment document, and the name
 * dropdown that replaced the browser's own suggestions.
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
const DATA = resolve(WORK, 'roles');
const PORT = 4529;
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`${username}: ${e.message}`));
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');
  await page.waitForTimeout(500);
  return page;
}
const api = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
const shot = (page, n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

const admin = await signIn('admin', 'admin');
await api(admin, 'POST', '/api/entities/customer', { name: 'Nadia Haddad', phone: '03 555 111' });
await api(admin, 'POST', '/api/entities/customer', { name: 'Nabil Karam' });
await api(admin, 'POST', '/api/users', { username: 'till8', password: 'test1234', role: 'cashier' });

/* ------------------------------------------------------------ name picker */
console.log('\n[names come from a real dropdown, not browser suggestions]');
await admin.goto(`${BASE}#/products/new`);
await admin.waitForSelector('#page-form input[name=category]');
check('no datalist is left on the product form', (await admin.$$('datalist')).length === 0);
check('the category field is a picker', await admin.$eval('input[name=category]', (el) => !!el.closest('.combo-names')));
await admin.click('input[name=category]');
await admin.waitForSelector('.combo-menu:not([hidden]) .combo-item');
const cats = await admin.$$eval('.combo-menu:not([hidden]) .combo-item .ci-name', (n) => n.map((x) => x.textContent.trim()));
check('clicking it lists the saved categories', cats.length >= 2, cats.join(' | '));
await shot(admin, '80-name-picker-category');
await admin.fill('input[name=category]', 'Brand New Shelf');
await admin.waitForTimeout(250);
const first = await admin.textContent('.combo-menu:not([hidden]) .combo-item:first-child');
check('typing a new name offers to use it, first', first.includes('Brand New Shelf'), first);
await admin.keyboard.press('Enter');
check('Enter keeps exactly what was typed', (await admin.inputValue('input[name=category]')) === 'Brand New Shelf');
check('and does not submit the form', (await admin.$$('#page-form')).length === 1);
await admin.fill('input[name=category]', '');
await admin.keyboard.press('Escape'); // clearing reopens the full list; close it before moving on
await admin.click('input[name=unit]');
await admin.fill('input[name=unit]', 'p');
await admin.waitForTimeout(250);
const units = await admin.$$eval('.combo-menu:not([hidden]) .combo-item .ci-name', (n) => n.map((x) => x.textContent.trim()));
check('the unit field searches its saved units', units.some((u) => /pcs|pack/i.test(u)), units.join(' | '));

console.log('\n[the customer at the till]');
await admin.goto(`${BASE}#/pos`);
await admin.waitForSelector('.tile');
await admin.click('.tile');
await admin.click('#checkout');
await admin.waitForSelector('#pay-customer');
await admin.waitForTimeout(300);
check('the payment dialog does not open the customer menu by itself', (await admin.$$('.combo-menu:not([hidden])')).length === 0);
await admin.click('#pay-customer');
await admin.fill('#pay-customer', 'na');
await admin.waitForSelector('.combo-menu:not([hidden]) .combo-item');
const people = await admin.$$eval('.combo-menu:not([hidden]) .combo-item', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('typing finds saved customers', people.some((p) => p.includes('Nadia Haddad')) && people.some((p) => p.includes('Nabil Karam')), people.join(' | '));
check('with their phone number', people.some((p) => p.includes('03 555 111')));
await shot(admin, '81-name-picker-customer');
await admin.click('.combo-menu:not([hidden]) .combo-item:has-text("Nadia Haddad")');
check('clicking one fills the field', (await admin.inputValue('#pay-customer')) === 'Nadia Haddad');
check('and the dialog is still open', await admin.isVisible('#pay-confirm'));
await admin.keyboard.press('Escape');
await admin.waitForTimeout(200);

/* ---------------------------------------------------------- adjustments */
console.log('\n[a stock adjustment covers many products at once]');
check('Stock Adjustment sits in the folding Stock item, after the stock count', await admin.evaluate(() => {
  const routes = [...document.querySelectorAll('.nav-fold[data-fold="stock"] [data-route]')].map((a) => a.dataset.route);
  return routes.indexOf('adjustments') === routes.indexOf('stock-count') + 1 && routes.includes('products');
}));
const [p1, p2] = (await api(admin, 'GET', '/api/products?limit=2')).data;
await admin.goto(`${BASE}#/adjustments`);
await admin.waitForSelector('#new');
await admin.click('#new');
await admin.waitForSelector('#adj-find');

// A scanned barcode (exact lookup on Enter) and a typed search.
await admin.fill('#adj-find', p1.barcode);
await admin.keyboard.press('Enter');
await admin.waitForSelector('[data-counted="0"]');
check('scanning a barcode adds its line', (await admin.textContent('#adj-lines')).includes(p1.name));
check('and puts the cursor on its count', await admin.evaluate(() => document.activeElement?.dataset.counted === '0'));
await admin.keyboard.type(String(p1.stock - 2));
await admin.waitForTimeout(100);
check('the change follows the count', (await admin.inputValue('[data-change="0"]')) === '-2', await admin.inputValue('[data-change="0"]'));

await admin.click('#adj-find');
await admin.fill('#adj-find', p2.name.slice(0, 5));
await admin.waitForSelector('.combo-menu:not([hidden]) .combo-item');
await admin.click(`.combo-menu:not([hidden]) .combo-item:has-text("${p2.name}")`);
await admin.waitForTimeout(150);
check('picking a search result adds it on top', (await admin.textContent('tr[data-line="0"]')).includes(p2.name));
await admin.fill('[data-change="0"]', '5');
await admin.waitForTimeout(100);
check('typing a change fills in the count', Number(await admin.inputValue('[data-counted="0"]')) === p2.stock + 5);

await admin.fill('#adj-find', p1.barcode);
await admin.keyboard.press('Enter');
await admin.waitForTimeout(400);
check('scanning a product again does not add a second line', (await admin.$$('tr[data-line]')).length === 2);
await admin.click('input[name=reason]');
await admin.waitForSelector('.combo-menu:not([hidden]) .combo-item');
const reasons = await admin.$$eval('.combo-menu:not([hidden]) .combo-item .ci-name', (n) => n.map((x) => x.textContent.trim()));
check('the reason offers the usual ones', reasons.includes('Damaged') && reasons.includes('Stock count'), reasons.join(' | '));
await admin.click('.combo-menu:not([hidden]) .combo-item:has-text("Damaged")');
check('and takes the one picked', (await admin.inputValue('input[name=reason]')) === 'Damaged');
check('the summary counts both changing lines', (await admin.textContent('#adj-summary')).includes('2 changing'), await admin.textContent('#adj-summary'));
await shot(admin, '82-adjustment-form');

await admin.click('#save-adj');
await admin.waitForSelector('.table-scroll tbody tr', { timeout: 8000 });
check('saving lists the new document', (await admin.textContent('.table-scroll tbody')).includes('ADJ-'));
const after1 = (await api(admin, 'GET', `/api/products/${p1.id}`)).data.stock;
const after2 = (await api(admin, 'GET', `/api/products/${p2.id}`)).data.stock;
check('the counted product is two down', Math.abs(after1 - (p1.stock - 2)) < 0.001, `${p1.stock} → ${after1}`);
check('the other is five up', Math.abs(after2 - (p2.stock + 5)) < 0.001, `${p2.stock} → ${after2}`);
await admin.click('.table-scroll tbody tr td:first-child');
await admin.waitForSelector('.doc-head');
check('opening it is a page, not a dialog', /#\/adjustments\/\d+$/.test(admin.url()) && (await admin.$$('.modal-backdrop')).length === 0, admin.url());
check('it shows before, change and after', (await admin.textContent('.doc-body')).includes('New balance'));
await admin.waitForTimeout(300);
await shot(admin, '83-adjustment-view');

/* -------------------------------------------------------------- cashier */
console.log('\n[a cashier only has the till]');
const till = await signIn('till8', 'test1234');
check('a cashier lands on the till', till.url().endsWith('#/pos'), till.url());
const routes = await till.$$eval('.nav-item', (n) => n.map((a) => a.dataset.route));
check('the menu has only Sell, with POS in the top bar', routes.join() === 'sales', routes.join());
// The till slides the sidebar away; on Sell it is there.
await till.goto(`${BASE}#/sales`);
await till.waitForTimeout(600);
check('Settings is the gear beside their name', await till.isVisible('.sidebar .nav-gear[href="#/settings"]'));
await till.click('#user-menu');
await till.waitForSelector('.modal [data-pick]');
const picks = await till.$$eval('.modal [data-pick]', (b) => b.map((x) => x.dataset.pick));
check('their user menu offers Settings but not Users', picks.includes('settings') && !picks.includes('users'), picks.join());
await till.keyboard.press('Escape');
await till.goto(`${BASE}#/pos`);
await till.waitForSelector('.tile');
await till.goto(`${BASE}#/reports`);
await till.waitForTimeout(600);
check('typing another address goes back to the till', till.url().endsWith('#/pos') && (await till.$$('.tile')).length > 0, till.url());
await till.keyboard.press('F4');
await till.waitForTimeout(400);
check('the Buy shortcut does nothing', till.url().endsWith('#/pos'), till.url());
check('the till shows no cost anywhere', !(await till.textContent('.pos')).match(/cost/i));
// A cashier puts a sale aside and takes it back.
await till.click('.tile');
await till.waitForTimeout(300);
await till.click('#hold-cart');
await till.waitForTimeout(700);
check('a cashier can hold a sale', (await till.$$('.cart-line')).length === 0 && (await till.textContent('#held-chip')) === '1 held');
await till.click('#held-chip');
await till.waitForSelector('.held-table [data-resume]');
check('…may discard what they held themselves', (await till.$$('.held-table [data-discard]')).length === 1);
await till.click('.held-table [data-resume]');
await till.waitForTimeout(900);
check('…and take it back', (await till.$$('.cart-line')).length === 1 && !(await till.isVisible('#held-chip')));
await till.click('#clear-cart');

await till.click('.tile');
await till.click('#checkout');
await till.waitForSelector('#pay-customer');
await till.click('#pay-customer');
await till.fill('#pay-customer', 'Nadia');
await till.waitForSelector('.combo-menu:not([hidden]) .combo-item');
check('a cashier can pick a saved customer', (await till.textContent('.combo-menu:not([hidden])')).includes('Nadia Haddad'));
await till.click('.combo-menu:not([hidden]) .combo-item:has-text("Nadia Haddad")');
await till.click('#pay-confirm');
await till.waitForSelector('.receipt', { timeout: 8000 });
await till.waitForTimeout(400); await shot(till, '85-cashier-receipt');
check('and complete the sale', (await till.textContent('.modal')).includes('Nadia Haddad'), await till.textContent('.modal'));
await till.click('.modal-head [data-close]');

await till.goto(`${BASE}#/sales`);
await till.waitForSelector('.table-scroll thead');
const heads = await till.$$eval('.table-scroll thead th', (n) => n.map((x) => x.textContent.trim().toLowerCase()));
check('sales history has no cost or profit columns', !heads.includes('cost') && !heads.includes('profit'), heads.join(' | '));
check('and no profit column', !(await till.textContent('.table-scroll thead')).toLowerCase().includes('profit'));
await shot(till, '84-cashier-sales');
await till.close();

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
