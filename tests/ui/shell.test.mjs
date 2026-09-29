/** Collapsible sidebar, POS auto-collapse, and forms as pages instead of modals. */
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
const DATA = resolve(WORK, 'shelldata');
const PORT = 4509;
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

const signIn = async () => {
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');
};
const sidebarWidth = () => page.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width));

await signIn();

/* ---------------------------------------------------- a fixed sidebar */
console.log('\n[the sidebar stays put]');
check('there is no collapse button', (await page.$$('#nav-collapse, .nav-toggle')).length === 0);
const navWidth = await sidebarWidth();
check('the sidebar is full width with its labels', navWidth > 200, String(navWidth));
check('labels are visible', await page.isVisible('.nav-item span'));

await page.click('#go-pos');
await page.waitForSelector('.tile');
await page.waitForTimeout(600);
check('the till takes the whole width: the sidebar slides away',
  await page.evaluate(() => Math.round(document.querySelector('.main').getBoundingClientRect().left) === 0));
check('and nothing marks it collapsed',
  await page.evaluate(() => !document.querySelector('.shell').classList.contains('nav-collapsed')));
await shot('71-pos-fixed-nav');

await page.goto(`${BASE}#/dashboard`);
await page.waitForSelector('.stat');
await page.reload();
await page.waitForSelector('.shell');
check('and it is still full width after a reload', (await sidebarWidth()) === navWidth);

/* ------------------------------------------------- forms are pages now */
console.log('\n[forms open as pages, not dialogs]');
const noDialog = async () => (await page.$$('.modal-backdrop')).length === 0;

console.log('\n[the version sits beside the name]');
{
  const pkg = JSON.parse((await import('node:fs')).readFileSync(resolve(APP, 'package.json'), 'utf8').replace(/^﻿/, ''));
  const brand = (await page.textContent('.sidebar .brand strong')).replace(/\s+/g, ' ').trim();
  check('the sidebar says ABSoft POS and its version', brand === `ABSoft POS v${pkg.version}`, brand);
}

for (const [route, label] of [
  ['products', 'product'],
  ['expenses', 'expense'],
  ['purchases', 'purchase'],
  ['users', 'user'],
]) {
  await page.goto(`${BASE}#/${route}`);
  await page.waitForTimeout(900);
  await page.click('#new');
  await page.waitForTimeout(1000);
  check(`the new ${label} form is a page, not a dialog`, await noDialog());
  check(`the sidebar stays visible on the new ${label} form`, await page.isVisible('.sidebar'));
  check(`the URL says so for ${label}`, page.url().includes(`${route}/new`), page.url());
  check(`the ${label} form has a Cancel that returns`, await page.isVisible('[data-cancel]'));
}
await shot('72-form-page');

/* ------------------------------------------------------ they still work */
console.log('\n[and they still save]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form');
await page.fill('input[name=name]', 'Page Form Product');
await page.fill('.barcodes-entry', 'PAGE-1');
await page.fill('input[name=cost]', '3');
await page.fill('input[name=price]', '7');
await page.fill('input[name=opening_stock]', '12');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(1200);
check('saving opens the new product page', /#\/products\/\d+$/.test(page.url()), page.url());
check('the product is there', (await page.textContent('.product-hero')).includes('Page Form Product'));

await page.goto(`${BASE}#/products`);
await page.waitForSelector('tr:has-text("Page Form Product")');
await page.click('tr:has-text("Page Form Product")');
await page.waitForSelector('#tabs [data-tab="details"]');
await page.click('#tabs [data-tab="details"]');
await page.waitForSelector('#page-form');
check('editing opens a page with the record loaded',
  (await page.inputValue('input[name=name]')) === 'Page Form Product');
check('the edit URL identifies the record', /products\/\d+\/details/.test(page.url()), page.url());
await page.fill('input[name=price]', '9');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(1200);
check('the edit saved', (await page.inputValue('input[name=price]')) === '9');

await page.goto(`${BASE}#/expenses/new`);
await page.waitForSelector('#page-form');
await page.fill('input[name=amount]', '42.50');
await page.fill('textarea[name=note]', 'Page form expense');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(1200);
check('an expense saves from its page', (await page.textContent('.page')).includes('Page form expense'));

await page.goto(`${BASE}#/purchases/new`);
await page.waitForSelector('#purchase-form');
check('the purchase builder is a page too', await noDialog());
check('with the sidebar still there', await page.isVisible('.sidebar'));
await page.fill('input[name=supplier]', 'Page Supplier');
await page.fill('[data-product="0"]', 'Croissant');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item', { timeout: 6000 });
await page.click('.combo-menu:not([hidden]) .combo-item');
await page.waitForTimeout(500);
await page.fill('[data-qty="0"]', '4');
await page.waitForTimeout(300);
await shot('73-purchase-page');
await page.click('#save-purchase');
await page.waitForTimeout(1500);
check('the purchase saves and returns to the list', page.url().endsWith('#/purchases'), page.url());
check('it is listed', (await page.textContent('.page')).includes('Page Supplier'));

await page.goto(`${BASE}#/lists/customer/new`);
await page.waitForSelector('#page-form');
await page.fill('input[name=name]', 'Page Customer');
await page.fill('input[name=phone]', '01 234 567');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(1200);
check('a list entry saves from its page', (await page.textContent('.page')).includes('Page Customer'));

/* -------------------------------------------------------------- cancel */
console.log('\n[cancelling]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form');
await page.fill('input[name=name]', 'Never Saved');
await page.click('.form-actions [data-cancel]');
await page.waitForTimeout(900);
check('cancel returns to the list', page.url().endsWith('#/products'));
check('and nothing was created', !(await page.textContent('.page')).includes('Never Saved'));

/* ------------------------------------------------------- validation */
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(700);
check('an empty required field blocks the save', page.url().includes('products/new'), page.url());

/* ------------------------------------------------------- forms fill the page */
console.log('');
console.log('[form pages use the width available]');
// #page is padded, so compare against its content box, not its border box.
const contentWidth = () =>
  page.evaluate(() => {
    const el = document.querySelector('#page');
    const cs = getComputedStyle(el);
    return Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  });
const widths = {
  form: await page.evaluate(() => Math.round(document.querySelector('#page-form').getBoundingClientRect().width)),
  page: await contentWidth(),
  cols: await page.evaluate(
    () => getComputedStyle(document.querySelector('#page-form .form-grid')).gridTemplateColumns.split(' ').length,
  ),
};
check('the product form fills the page width', widths.form >= widths.page - 2, JSON.stringify(widths));
check('and lays fields out in several columns', widths.cols >= 3, JSON.stringify(widths));
await shot('75-product-form-page');

await page.goto(`${BASE}#/purchases/new`);
await page.waitForSelector('#purchase-form');
await page.waitForTimeout(400);
const buyWidths = {
  form: await page.evaluate(() => Math.round(document.querySelector('#purchase-form').getBoundingClientRect().width)),
  page: await contentWidth(),
  table: await page.evaluate(() => Math.round(document.querySelector('#lines table')?.getBoundingClientRect().width || 0)),
};
check('the purchase builder fills the page width', buyWidths.form >= buyWidths.page - 2, JSON.stringify(buyWidths));
check('its line table uses that width too', buyWidths.table >= buyWidths.page - 60, JSON.stringify(buyWidths));
await shot('76-purchase-form-page');

/* ------------------------------------------------------ restock badge */
console.log('\n[Restock badge]');
const call = (path, method = 'GET', body) => page.evaluate(async ([p, m, b]) =>
  (await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })).json(),
  [path, method, body]);
// Three products well below a minimum nobody could reach, on top of whatever the seed left low.
const catalogue = await call('/api/products?page=1&per=50');
const raised = catalogue.rows.slice(0, 3);
for (const p of raised) await call(`/api/products/${p.id}`, 'PUT', { min_stock: 100000 });
const expected = (await call('/api/products?page=1&per=5&stock=restock')).total;
const badgeText = async () => (await page.$eval('nav [data-route="products"] .nav-badge', (b) => b.textContent).catch(() => null));

await page.goto(`${BASE}#/dashboard`);
await page.waitForSelector('nav [data-route="products"] .nav-badge');
await page.waitForTimeout(1200);
check('the dashboard no longer raises a restock toast', (await page.$$('#toasts .toast')).length === 0);
check('Products carries the count in the menu', (await badgeText()) === String(expected), `${await badgeText()} vs ${expected}`);
check('the badge says what it counts', (await page.getAttribute('nav [data-route="products"] .nav-badge', 'title')) ===
  `${expected} products need restocking`);
check('it sits before the F3 hint', await page.$eval('nav [data-route="products"] .nav-badge', (b) => b.nextElementSibling?.classList.contains('kbd')));

/* ------------------------------------------------- tiles with a trend */
console.log('\n[KPI tiles that show the trend]');
const dash = await call('/api/reports/dashboard');
const pairs = [
  [dash.today.gross_sales, dash.yesterday.gross_sales, 'vs yesterday'],
  [dash.today.net_profit, dash.yesterday.net_profit, 'vs yesterday'],
  [dash.month.revenue, dash.last_month.revenue, 'vs the same days last month'],
  [dash.month.net_profit, dash.last_month.net_profit, 'vs the same days last month'],
];
const pills = await page.$$eval('.grid.cols-4 .stat', (tiles) => tiles.map((s) => {
  const p = s.querySelector('.stat-trend');
  return p ? { text: p.textContent.trim().replace(/\s+/g, ' '), label: p.getAttribute('aria-label'), cls: p.className } : null;
}));
const trouble = [];
pairs.forEach(([now, before, vs], i) => {
  const pill = pills[i];
  if (!(before > 0)) { if (pill) trouble.push(`tile ${i}: a pill with nothing to compare with`); return; }
  if (!pill) return trouble.push(`tile ${i}: no pill`);
  const pct = ((now - before) / before) * 100;
  const dir = Math.abs(pct) < 0.5 ? 'same' : pct > 0 ? 'up' : 'down';
  const want = dir === 'same' ? '▬' : `${dir === 'up' ? '▲' : '▼'} ${Math.round(Math.abs(pct))}%`;
  if (pill.text !== want || !pill.label.includes(vs) || !pill.cls.includes(dir)) trouble.push(`tile ${i}: ${JSON.stringify(pill)} wanted ${want} ${vs}`);
});
check('each tile says how it compares, and only when there is an earlier figure', trouble.length === 0, trouble.join('; '));
check('the seed gives at least one tile something to compare with', pills.some(Boolean), JSON.stringify(pairs));
check('the decorative circles are gone', await page.$eval('.stat', (s) => getComputedStyle(s, '::after').content === 'none'));
await shot('153-dashboard-trends');
await shot('150-restock-badge');

await page.click('nav [data-route="products"] .nav-badge');
await page.waitForSelector('#stock-filter select');
await page.waitForTimeout(600);
check('clicking the badge opens the list that needs restocking', await page.evaluate(() => location.hash) === '#/products/restock');
check('…with the filter already set', (await page.$eval('#stock-filter select', (s) => s.value)) === 'restock');
check('…showing exactly the products it counted', (await page.$$('#page table.data tbody tr')).length === expected,
  String((await page.$$('#page table.data tbody tr')).length));
check('Products is the active screen', await page.$eval('nav [data-route="products"]', (a) => a.classList.contains('active')));
await page.selectOption('#stock-filter select', '');
check('changing the filter goes back to the plain list address', await page.evaluate(() => location.hash) === '#/products');

await page.click('[data-fold-toggle="stock"]');
await page.waitForTimeout(400);
check('with Stock folded away, its header carries the badge',
  await page.isVisible('[data-fold-toggle="stock"] .nav-badge') && !(await page.isVisible('nav [data-route="products"] .nav-badge')));
await shot('151-restock-badge-folded');
await page.click('[data-fold-toggle="stock"]');
await page.waitForTimeout(400);
check('unfolded, the badge is back on Products only',
  !(await page.isVisible('[data-fold-toggle="stock"] .nav-badge')) && await page.isVisible('nav [data-route="products"] .nav-badge'));

await call(`/api/products/${raised[0].id}`, 'PUT', { min_stock: 0 });
await page.goto(`${BASE}#/sales`);
await page.waitForTimeout(900);
check('the count follows stock on the next screen', (await badgeText()) === String(expected - 1), `${await badgeText()}`);

await call('/api/settings', 'PUT', { low_stock_alert: '0' });
await page.reload();
await page.waitForSelector('.shell');
await page.waitForTimeout(900);
check('switched off in Settings, there is no badge', (await badgeText()) === null);
await call('/api/settings', 'PUT', { low_stock_alert: '1' });
for (const p of raised) await call(`/api/products/${p.id}`, 'PUT', { min_stock: p.min_stock });

/* ------------------------------------------------- a menu that fits 720 */
console.log('\n[A sidebar that fits 1366×720]');
// The worst case: the rate box (second currency) and Shifts (an extra row) both showing.
await call('/api/settings', 'PUT', { currency2_enabled: '1', currency2_symbol: 'L.L', currency2_decimals: '0', pos_shifts: '1' });
await call('/api/exchange-rate', 'PUT', { rate: 89500 });
await page.setViewportSize({ width: 1366, height: 720 });
const fits = async () => page.evaluate(() => {
  const nav = document.querySelector('.nav');
  const all = [...document.querySelectorAll('.sidebar .nav-item, .sidebar .nav-gear, .sidebar .user-chip, #rate-box')];
  const out = all.filter((el) => el.offsetParent !== null).filter((el) => {
    const r = el.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    return r.bottom > innerHeight + 0.5 || (nav.contains(el) && r.bottom > n.bottom + 0.5);
  }).map((el) => el.dataset.route || el.id);
  return { scrolls: nav.scrollHeight > nav.clientHeight + 1, out, rate: !document.getElementById('rate-box').hidden };
});
for (const lang of ['en', 'ar']) {
  await page.evaluate((l) => localStorage.setItem('absoft-lang', l), lang);
  await page.goto(`${BASE}#/reports`);
  await page.reload();
  await page.waitForSelector('.nav-item');
  await page.waitForTimeout(700);
  const f = await fits();
  check(`${lang}: every item, the rate and the user fit without scrolling`, f.rate && !f.scrolls && f.out.length === 0, JSON.stringify(f));
  await shot(`152-sidebar-1366x720-${lang}`);
}
await page.evaluate(() => localStorage.setItem('absoft-lang', 'en'));
await page.reload();
await page.waitForSelector('.nav-item');
const menuRoutes = await page.$$eval('.nav [data-route]', (a) => a.map((x) => x.dataset.route));
check('the menu: Dashboard, then Money, then Stock', menuRoutes.join() ===
  'dashboard,sales,shifts,purchases,expenses,reports,products,stock-count,adjustments,lists', menuRoutes.join());
check('Users and Settings have left the menu', !menuRoutes.includes('users') && !menuRoutes.includes('settings'));
check('one heading for Money, and Stock as its folding group', (await page.$$eval('.nav-label', (l) => l.map((x) => x.textContent.trim()))).join() === 'Money');

await page.click('.sidebar .nav-gear');
await page.waitForTimeout(600);
check('the gear beside the user opens Settings, and shows it is the screen', await page.evaluate(() => location.hash) === '#/settings' &&
  await page.$eval('.sidebar .nav-gear', (a) => a.classList.contains('active')));
await page.click('#user-menu');
await page.waitForSelector('.modal [data-pick="users"]');
const adminPicks = await page.$$eval('.modal [data-pick]', (b) => b.map((x) => x.dataset.pick));
check('an administrator\'s user menu offers Settings and Users', adminPicks.includes('settings') && adminPicks.includes('users'), adminPicks.join());
await page.click('.modal [data-pick="users"]');
await page.waitForTimeout(600);
check('Users opens from there, with the user chip marked', await page.evaluate(() => location.hash) === '#/users' &&
  await page.$eval('#user-menu', (b) => b.classList.contains('active')));

await call('/api/settings', 'PUT', { currency2_enabled: '0', pos_shifts: '0' });
await page.setViewportSize({ width: 1500, height: 980 });
await page.reload();
await page.waitForSelector('.nav-item');

/* ------------------------------------------------------------- Arabic */
console.log('\n[Arabic]');
await page.click('.topbar [data-lang="ar"]');
await page.waitForTimeout(800);
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form');
check('the form page is translated', (await page.textContent('#page-form')).includes('اسم المنتج'));
check('no horizontal overflow in RTL', await page.evaluate(
  () => document.body.scrollWidth <= document.documentElement.clientWidth + 1));
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await page.waitForTimeout(500);
const side = await page.evaluate(() => {
  const r = document.querySelector('.sidebar').getBoundingClientRect();
  return { right: Math.round(r.right), width: Math.round(r.width), vw: document.documentElement.clientWidth };
});
check('the sidebar sits on the right in RTL, at full width',
  side.right >= side.vw - 1 && side.width > 200, JSON.stringify(side));
// Mirrored: in the Arabic till every name starts at the card's right edge, English ones included.
await call('/api/products', 'POST', { name: 'جبنة عكاوي', price: 5, cost: 3 });
await page.reload();
await page.waitForSelector('.tile');
await page.waitForTimeout(500);
const rtlEdges = await page.evaluate(() => {
  const out = { arabic: [], latin: [] };
  for (const tile of document.querySelectorAll('.tile:not([hidden])')) {
    const name = tile.querySelector('.t-name');
    const range = document.createRange();
    range.selectNodeContents(name);
    const inset = Math.round(tile.getBoundingClientRect().right - range.getBoundingClientRect().right);
    out[/[؀-ۿ]/.test(name.textContent) ? 'arabic' : 'latin'].push(inset);
  }
  return out;
});
const rtlInsets = [...rtlEdges.arabic, ...rtlEdges.latin];
check('in Arabic, names in both scripts start at the same right edge',
  rtlEdges.arabic.length > 0 && rtlEdges.latin.length > 0 && Math.max(...rtlInsets) - Math.min(...rtlInsets) <= 1, JSON.stringify(rtlEdges));
await shot('74-pos-ar');
await page.click('.topbar [data-lang="en"]');
await page.waitForTimeout(600);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
