/** Lists come a page at a time, with filters that narrow before anything loads. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'paging');
const PORT = 4547;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

rmSync(DATA, { recursive: true, force: true });
for (const tool of ['seed.js', 'demo-products.js']) {
  const child = spawn('node', ['--no-warnings', `server/tools/${tool}`], { cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA } });
  await new Promise((r) => child.on('exit', r));
}
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
const rowCount = () => page.$$eval('.table-scroll tbody tr', (r) => r.length);
const firstRow = () => page.textContent('.table-scroll tbody tr:first-child');

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ---------------------------------------------------------------- products */
console.log('\n[the product list comes a page at a time]');
const total = (await page.evaluate(async () => (await (await fetch('/api/products')).json()).length));
await page.goto(`${BASE}#/products`);
await page.waitForSelector('.pager');
check('only the first page is on screen', (await rowCount()) === 50, `${await rowCount()} of ${total}`);
check('and it says how much there is', (await page.textContent('.pager-count')).includes(String(total)), await page.textContent('.pager-count'));
check('the heading counts everything that matches, not the page',
  (await page.textContent('#summary')).includes(String(total)), await page.textContent('#summary'));
const firstOfPage1 = await firstRow();
await shot('140-products-paged');

await page.click('.pager [data-go="2"]');
await page.waitForTimeout(700);
check('Next brings the second page', (await page.textContent('.pager-page')).includes('2'), await page.textContent('.pager-page'));
check('with different products on it', (await firstRow()) !== firstOfPage1);
await page.click('.pager [data-go="1"]');
await page.waitForTimeout(700);
check('and back again', (await firstRow()) === firstOfPage1);

await page.selectOption('.pager-per select', '100');
await page.waitForTimeout(700);
check('the page size can be changed', (await rowCount()) === 100, String(await rowCount()));
check('which starts again at page one', (await page.textContent('.pager-page')).includes('1'));

console.log('\n[filters narrow it before anything is drawn]');
await page.click('#filter-category');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item');
const category = (await page.textContent('.combo-menu:not([hidden]) .combo-item .ci-name')).trim();
await page.click('.combo-menu:not([hidden]) .combo-item');
await page.waitForTimeout(800);
const inCategory = await page.evaluate(
  async (c) => (await (await fetch(`/api/products?page=1&per=200&category=${encodeURIComponent(c)}`)).json()).total,
  category,
);
check(`by category (${category})`, (await rowCount()) === Math.min(100, inCategory), `${await rowCount()} of ${inCategory}`);
await page.fill('#filter-category', '');
await page.keyboard.press('Escape');
await page.dispatchEvent('#filter-category', 'change');
await page.waitForTimeout(800);
check('clearing the category brings the rest back', (await rowCount()) === 100);

const stockFilter = '#stock-filter select';
await page.selectOption(stockFilter, 'out');
await page.waitForTimeout(800);
const outRows = await page.$$eval('.table-scroll tbody tr .badge.danger', (b) => b.length);
check('out of stock only', (await rowCount()) === outRows, `${await rowCount()} rows, ${outRows} marked out`);
await page.selectOption(stockFilter, '');
await page.waitForTimeout(700);

await page.fill('#search', 'zzz-no-such-product');
await page.waitForTimeout(800);
check('a search with no match says so instead of an empty table', await page.isVisible('.empty'));
await page.fill('#search', '');
await page.waitForTimeout(800);

/* ------------------------------------------------------------------ sales */
console.log('\n[invoices]');
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('.table-scroll tbody tr');
check('the sales list pages too', await page.isVisible('.pager'));
const statusFilter = '.toolbar .filter-select:has(option[value="partial"]) select';
await page.selectOption(statusFilter, 'unpaid');
await page.waitForTimeout(900);
const statuses = await page.$$eval('.table-scroll tbody tr', (rows) => rows.map((r) => r.textContent));
check('filtering by unpaid shows only those', statuses.every((r) => r.includes('unpaid')) || statuses.length === 0,
  statuses.length ? statuses[0].replace(/\s+/g, ' ').slice(0, 80) : 'no rows');
await page.selectOption(statusFilter, '');
await page.waitForTimeout(900);
check('the row under the table is labelled as this page', (await page.textContent('.table-scroll tfoot')).includes('This page'),
  await page.textContent('.table-scroll tfoot'));
await shot('141-sales-filters');

/* ------------------------------------------------- customers and suppliers */
console.log('\n[customers and suppliers]');
await page.goto(`${BASE}#/lists`);
// Categories are the tab with rows in demo data; customers arrive with sales.
await page.waitForSelector('[data-kind="category"]');
await page.click('[data-kind="category"]');
await page.waitForSelector('.table-scroll tbody tr');
check('the names list pages as well', await page.isVisible('.pager'));
const heads = await page.evaluate(() => {
  const th = [...document.querySelectorAll('.table-scroll thead th')];
  const rows = [...document.querySelectorAll('.table-scroll tbody tr:first-child td')];
  // Every right-aligned heading should sit over its own column of numbers.
  return th.map((h, i) => ({
    text: h.textContent.trim(),
    right: Math.round(h.getBoundingClientRect().right),
    cellRight: Math.round(rows[i]?.getBoundingClientRect().right ?? 0),
    aligned: getComputedStyle(h).textAlign,
  }));
});
check('headings line up over their values', heads.every((h) => Math.abs(h.right - h.cellRight) <= 1), JSON.stringify(heads));
check('and a right-aligned column has a right-aligned heading',
  heads.filter((h) => h.aligned === 'right' || h.aligned === 'end').length >= 1, JSON.stringify(heads.map((h) => h.aligned)));
await shot('142-lists-paged');

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
