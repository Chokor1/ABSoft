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
await page.fill('input[name=barcode]', 'PAGE-1');
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
check('the edit saved', (await page.textContent('.product-hero')).includes('9.00'));

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
await shot('74-pos-ar');
await page.click('.topbar [data-lang="en"]');
await page.waitForTimeout(600);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
