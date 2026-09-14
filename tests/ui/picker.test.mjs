/** The type-ahead item picker, in both transaction screens. */
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
const DATA = resolve(WORK, 'pickerdata');
const PORT = 4503;
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

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------- purchase lines */
console.log('\n[buying: search instead of a dropdown]');
await page.goto(`${BASE}#/purchases`);
await page.waitForTimeout(800);
await page.click('#new');
await page.waitForSelector('#purchase-form');
check('the line editor no longer uses a select', (await page.$$('#lines select')).length === 0);
check('it uses a searchable text box', await page.isVisible('[data-product="0"]'));
check('which starts empty rather than guessing a product', (await page.inputValue('[data-product="0"]')) === '');

await page.click('[data-product="0"]');
await page.waitForSelector('.combo-menu .combo-item', { timeout: 6000 });
const browseAll = await page.$$eval('.combo-menu .ci-name', (n) => n.length);
check('focusing the empty box lets you browse the catalogue', browseAll > 1, String(browseAll));

await page.fill('[data-product="0"]', 'cof');
// wait for the search to settle on the typed query rather than the browse list
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('.combo-menu .combo-item')].map((n) => n.textContent.toLowerCase());
  return rows.length > 0 && rows.every((r) => r.includes('cof'));
}, { timeout: 6000 }).catch(() => {});
const rows = await page.$$eval('.combo-menu .combo-item', (n) => n.map((x) => x.textContent.trim()));
const results = await page.$$eval('.combo-menu .combo-item .ci-name', (n) => n.map((x) => x.textContent.trim()));
check('typing shows matching products', results.length >= 1, results.join(' | '));
check('every result matches somewhere - name, barcode, category or description',
  rows.every((r) => r.toLowerCase().includes('cof')), results.join(' | '));
check('it narrowed the list down', results.length < browseAll, `${results.length} of ${browseAll}`);
check('results show the price', (await page.textContent('.combo-item .ci-price')).length > 1);
// The menu sits inside a scrolling table wrapper inside a modal; make sure
// nothing clips it and every result is actually reachable.
const clipping = await page.evaluate(() => {
  const menu = document.querySelector('.combo-menu');
  const m = menu.getBoundingClientRect();
  const last = menu.querySelector('.combo-item:last-child').getBoundingClientRect();
  return {
    onBody: menu.parentElement === document.body,
    fixed: getComputedStyle(menu).position === 'fixed',
    lastVisible: last.bottom <= m.bottom + 1 && last.bottom <= window.innerHeight,
    insideViewport: m.right <= window.innerWidth + 1 && m.left >= -1,
  };
});
check('the dropdown is not clipped by the table or modal', clipping.onBody && clipping.fixed,
  JSON.stringify(clipping));
check('every result is reachable, not cut off', clipping.lastVisible, JSON.stringify(clipping));
check('and it stays inside the window', clipping.insideViewport, JSON.stringify(clipping));
check('and the stock on hand', (await page.textContent('.combo-item .ci-stock')).length > 1);
await shot('60-purchase-picker');

await page.keyboard.press('ArrowDown');
await page.waitForTimeout(150);
const activeCount = await page.$$eval('.combo-item.active', (e) => e.length);
check('exactly one result is highlighted at a time', activeCount === 1, String(activeCount));
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const picked = await page.inputValue('[data-product="0"]');
check('Enter fills the line with the highlighted product', picked.length > 0, picked);
check('the dropdown closes after picking', !(await page.isVisible('.combo-menu')));
check('its last cost is filled in automatically',
  Number(await page.inputValue('[data-cost="0"]')) > 0, await page.inputValue('[data-cost="0"]'));

await page.fill('[data-qty="0"]', '5');
await page.waitForTimeout(300);
check('the line total is calculated', /\d/.test(await page.textContent('#lines tfoot')));

await page.click('#add-line');
await page.waitForTimeout(400);
await page.fill('[data-product="1"]', 'water');
await page.waitForSelector('.combo-menu .combo-item');
await page.click('.combo-menu .combo-item');
await page.waitForTimeout(500);
check('a result can also be clicked', (await page.inputValue('[data-product="1"]')).toLowerCase().includes('water'));

await page.fill('[data-qty="1"]', '3');
await page.waitForTimeout(300);
await page.click('#save-purchase');
await page.waitForTimeout(1500);
check('the purchase saves with both searched lines', (await page.textContent('.page')).includes('PO-'));

/* --------------------------------------------------- unmatched searches */
console.log('\n[searching for something that is not there]');
await page.click('#new');
await page.waitForSelector('#purchase-form');
await page.fill('[data-product="0"]', 'zzzzzzz');
await page.waitForSelector('.combo-empty', { timeout: 6000 });
check('an honest "no match" is shown', (await page.textContent('.combo-empty')).includes('No product matches'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes the dropdown', !(await page.isVisible('.combo-menu')));
check('but leaves the purchase form open', await page.isVisible('#purchase-form'));
// The purchase builder is a page now, so Cancel is what leaves it.
await page.click('.form-actions [data-cancel]');
await page.waitForTimeout(700);
check('Cancel leaves the purchase form', !(await page.isVisible('#purchase-form')));

/* ------------------------------------------------------------- the till */
console.log('\n[selling: typing filters the product cards, no dropdown]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
const allCards = await page.$$eval('.tile', (t) => t.length);
const visibleNames = () => page.$$eval('.tile:not([hidden]) .t-name', (n) => n.map((x) => x.textContent.trim()));
await page.fill('#scan', 'muff');
await page.waitForTimeout(40);
const moving = await page.evaluate(() => document.getAnimations().length);
await page.waitForTimeout(400);
check('no dropdown opens at the till', (await page.$$('.combo-menu:not([hidden])')).length === 0);
const muffins = await visibleNames();
check('the cards filter to the matches', muffins.length >= 1 && muffins.length < allCards && muffins.every((n) => /muff/i.test(n)), muffins.join(' | '));
check('with an animation as they rearrange', moving > 0, String(moving));
await shot('61-pos-filter');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check('Enter adds the only match to the cart', (await page.$$('.cart-line')).length === 1);
check('the right one', (await page.textContent('.cl-name')).toLowerCase().includes('muffin'),
  await page.textContent('.cl-name'));
check('the search box clears itself for the next item', (await page.inputValue('#scan')) === '');
await page.waitForTimeout(400);
check('and every card comes back', (await visibleNames()).length === allCards);

/* ----------------------------------------- the dangerous old behaviour */
console.log('\n[a partial code no longer guesses]');
await page.fill('#scan', 'c');
await page.waitForTimeout(300);
const several = (await visibleNames()).length;
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
check('a one-letter fragment matching several cards does not ring anything up',
  several > 1 && (await page.$$('.cart-line')).length === 1, `${several} visible, ${(await page.$$('.cart-line')).length} lines`);
await page.fill('#scan', 'zzzz-nothing');
await page.waitForTimeout(300);
check('no match shows an empty state in the grid', await page.isVisible('#tiles-empty'));
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
check('and Enter says nothing matches', (await page.textContent('.toasts')).includes('No product matches'));

/* ---------------------------------------------------- barcode scanning */
console.log('\n[a real scanner still works]');
await page.fill('#scan', '');
await page.waitForTimeout(300);
await page.fill('#scan', '5449000000996');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('an exact barcode goes straight into the cart', (await page.$$('.cart-line')).length === 2);
check('and it is the scanned product', (await page.textContent('.cart-lines')).includes('Bottled Water'));

/* --------------------------------------------------------------- RTL */
console.log('\n[Arabic]');
await page.click('.topbar [data-lang="ar"]');
await page.waitForTimeout(700);
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await page.fill('#scan', 'tea');
await page.waitForTimeout(500);
const teas = await visibleNames();
check('filtering works in Arabic too', teas.length >= 1 && teas.every((n) => /tea/i.test(n)), teas.join(' | '));
check('no horizontal overflow',
  await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1));
await shot('62-pos-filter-ar');

await page.goto(`${BASE}#/purchases`);
await page.waitForTimeout(700);
await page.click('#new');
await page.waitForSelector('#purchase-form');
check('the buy screen search is translated',
  (await page.getAttribute('[data-product="0"]', 'placeholder')).includes('ابحث عن منتج'));
await page.keyboard.press('Escape');

/* --------------------------------------------------------- no leaks */
console.log('');
console.log('[the dropdown layer does not accumulate]');
await page.goto(`${BASE}#/purchases`);
await page.waitForTimeout(700);
for (let i = 0; i < 3; i++) {
  await page.click('#new');
  await page.waitForSelector('#purchase-form');
  await page.click('#add-line');
  await page.waitForTimeout(200);
  await page.click('#add-line');
  await page.waitForTimeout(200);
  // Cancel, not Escape: Escape would only close the open dropdown.
  await page.click('.form-actions [data-cancel]');
  await page.waitForTimeout(600);
}
const leaked = await page.$$eval('body > .combo-menu', (m) => m.length);
check('opening and closing the form leaves no stale menus behind', leaked === 0, String(leaked));

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await page.goto(`${BASE}#/dashboard`);
await page.waitForSelector('.stat');
const afterLeave = await page.$$eval('body > .combo-menu', (m) => m.length);
check('leaving the till disposes its dropdown', afterLeave === 0, String(afterLeave));

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
