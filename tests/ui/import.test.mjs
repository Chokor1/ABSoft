/** Import products from the Products screen, and opening stock as a type of stock adjustment. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'importui');
const PORT = 4553;
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
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

/* ------------------------------------------------------------ the menu */
console.log('\n[no separate opening stock screen]');
const stockItems = await page.$$eval('.nav-fold[data-fold="stock"] [data-route]', (a) => a.map((x) => x.dataset.route));
check('Stock holds Products, Stock Count, Stock Adjustment and Lists — opening stock lives in adjustments',
  stockItems.join() === 'products,stock-count,adjustments,lists', stockItems.join());

/* --------------------------------------------------- a new product's opening */
console.log('\n[opening stock on a new product]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form input[name=opening_stock]');
check('the new product form has opening stock, 0 by default', (await page.inputValue('input[name=opening_stock]')) === '0');
await page.fill('input[name=name]', 'Form Opened Tea');
await page.fill('.barcodes-entry', 'FORM-OPN-1');
await page.fill('input[name=cost]', '2');
await page.fill('input[name=price]', '4');
await page.fill('input[name=opening_stock]', '1');
await page.click('#page-form button[type=submit]');
await page.waitForSelector('.product-hero');
check('after saving, the product page has no opening stock field', (await page.$$('input[name=opening_stock]')).length === 0);
check('and the product holds 1', (await page.textContent('#page-form')).includes('1 pcs'), await page.textContent('#page-form'));
const opened = await api('/api/adjustments?page=1&per=10&type=opening');
check('an opening stock adjustment was written', opened.total === 1 && opened.rows[0].line_count === 1, JSON.stringify(opened.total));

/* ------------------------------------------------------------ importing */
console.log('\n[importing products]');
await page.goto(`${BASE}#/products`);
await page.waitForSelector('#import');
check('Products has an Import button', await page.isVisible('#import'));
await page.click('#import');
await page.waitForSelector('#imp-drop');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#template2')]);
const template = readFileSync(await download.path(), 'utf8');
check('the template downloads', download.suggestedFilename() === 'absoft-products-template.csv');
check('with the columns to fill and an example', template.replace(/^﻿/, '').startsWith('name,description,barcode,category,unit,cost,price,min_stock,opening_stock') &&
  template.split(/\r?\n/).length >= 3, template.slice(0, 120));
await shot('160-import-start');

// Semicolons, quoted cells and an Arabic name: what Excel really saves.
const csv = [
  'name;barcode;category;unit;cost;price;opening_stock',
  'UI Import Flour;UI-1;Grocery;pcs;1,20;2;25',
  '"UI Import ""Best"" Oil";UI-2;Grocery;pcs;3.5;5;10',
  'زيت زيتون مستورد;UI-3;Grocery;pcs;6;9;',
  ';UI-4;Grocery;pcs;1;2;3',
  'UI Existing Water;5449000000996;Drinks;pcs;1;1;4',
].join('\r\n');
await page.setInputFiles('#imp-file', { name: 'shop-items.csv', mimeType: 'text/csv', buffer: Buffer.from(`﻿${csv}`, 'utf8') });
await page.waitForSelector('#imp-go', { timeout: 8000 });
const head = await page.textContent('#imp-result .card-head');
check('the preview counts what is ready, skipped and wrong', head.includes('3 ready') && head.includes('1 skipped') && head.includes('1 with errors'), head.replace(/\s+/g, ' '));
check('semicolons, quotes and Arabic are read', (await page.textContent('.imp-table')).includes('UI Import "Best" Oil') &&
  (await page.textContent('.imp-table')).includes('زيت زيتون مستورد'));
check('the wrong row says why', (await page.textContent('.imp-table tr.imp-error')).includes('The name is missing'));
check('the existing barcode is skipped, and says so', (await page.textContent('.imp-table tr.imp-skip')).includes('already exists'));
check('it explains the opening stock will be one adjustment', (await page.textContent('.imp-options')).includes('one opening stock adjustment'));
check('nothing is saved yet', (await api('/api/products?search=UI Import')).length === 0);
await shot('161-import-preview');

await page.click('#imp-go');
await page.waitForSelector('.imp-done', { timeout: 8000 });
check('importing creates the products', (await api('/api/products?search=UI Import')).length === 2 &&
  (await api('/api/products?search=زيت زيتون مستورد')).length === 1);
const afterImport = await api('/api/adjustments?page=1&per=10&type=opening');
check('and ONE opening stock adjustment for the file', afterImport.total === 2, String(afterImport.total));
const importDoc = await api(`/api/adjustments/${afterImport.rows[0].id}`);
check('holding the two products that had a quantity', importDoc.type === 'opening' && importDoc.items.length === 2 && Math.abs(importDoc.qty_in - 35) < 0.001,
  JSON.stringify(importDoc.items.map((i) => i.qty)));
check('noted with the file name', importDoc.note.includes('shop-items.csv'), importDoc.note);
await shot('162-import-done');

console.log('\n[the opening stock adjustment]');
await page.click('#imp-open-doc');
await page.waitForSelector('.doc-head');
check('the result opens the adjustment', /#\/adjustments\/\d+$/.test(page.url()) && (await page.textContent('.doc-body')).includes('UI Import Flour'));
check('marked as opening stock, with the unit cost', (await page.textContent('.doc-head')).includes('Opening stock') &&
  (await page.textContent('.doc-body thead')).includes('Unit cost'));
await page.goto(`${BASE}#/adjustments`);
await page.waitForSelector('.toolbar .filter-select');
await page.selectOption('.toolbar .filter-select:has(option[value="opening"]) select', 'opening');
await page.waitForTimeout(800);
check('Stock Adjustment filters to opening stock', (await page.$$('.table-scroll tbody tr')).length === 2 &&
  (await page.$$('.table-scroll tbody .badge.accent')).length === 2);
await shot('163-adjustments-opening-filter');

console.log('\n[opening stock by hand]');
await page.click('#new-opening');
await page.waitForSelector('#opn-find');
const [product] = await api('/api/products?search=Unopened&limit=1').then(() => api('/api/products?limit=1'));
await page.fill('#opn-find', product.barcode);
await page.keyboard.press('Enter');
await page.waitForSelector('[data-qty="0"]');
check('scanning adds a line with the product\'s cost filled in', Number(await page.inputValue('[data-cost="0"]')) === product.cost);
await page.fill('[data-qty="0"]', '7');
await page.waitForTimeout(150);
check('the value follows', (await page.textContent('[data-value="0"]')).includes(String((7 * product.cost).toFixed(2))));
const stockBefore = (await api(`/api/products/${product.id}`)).stock;
await page.click('#opn-save');
await page.waitForSelector('.doc-head', { timeout: 8000 });
check('saving adds the stock', Math.abs((await api(`/api/products/${product.id}`)).stock - (stockBefore + 7)) < 0.001);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
