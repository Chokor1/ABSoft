/**
 * In the browser: a product's other barcodes (typed, scanned, removed, rung up
 * at the till), the Sales Analysis screen, and the customer and supplier pages.
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
const DATA = resolve(WORK, 'analysisui');
const PORT = 4559;
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
const api = (path, method = 'GET', body) =>
  page.evaluate(async ([p, m, b]) => {
    const res = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return res.json();
  }, [path, method, body]);
const text = (sel) => page.textContent(sel).then((s) => (s || '').replace(/\s+/g, ' ').trim());

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ barcodes */
console.log('\n[a product with other barcodes]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('.tags-entry');
await page.fill('input[name=name]', 'Tagged Rice');
await page.fill('input[name=barcode]', 'RICE-1');
await page.fill('input[name=price]', '3');
await page.click('.tags-entry');
for (const code of ['RICE-2', 'RICE-3']) {
  await page.keyboard.type(code);
  await page.keyboard.press('Enter'); // what a scanner does after every code
}
check('each code scanned becomes a chip', (await page.$$('.tags-box .tag')).length === 2);
check('and Enter did not save the product', page.url().endsWith('#/products/new'));
await page.keyboard.type('RICE-2');
await page.keyboard.press('Enter');
check('the same code twice is not added again', (await page.$$('.tags-box .tag')).length === 2);
await page.click('.tag[data-tag="RICE-3"] [data-untag]');
check('× takes a code off', (await page.$$('.tags-box .tag')).length === 1);
await page.click('.tags-entry');
await page.keyboard.type('RICE-4'); // typed, not yet confirmed with Enter
await shot('170-product-other-barcodes');
await page.click('#page-form button[type=submit]');
await page.waitForSelector('.product-hero');
const rice = (await api('/api/products?search=Tagged Rice'))[0];
check('saved with the chips and the code still being typed', JSON.stringify(rice.barcodes) === '["RICE-2","RICE-4"]', JSON.stringify(rice.barcodes));
check('the product page shows them', (await page.$$('.tags-box .tag')).length === 2);
await page.click('.tags-entry');
await page.keyboard.type('RICE-5');
await page.keyboard.press('Enter');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(600);
check('and adds more from there', (await api(`/api/products/${rice.id}`)).barcodes.length === 3);

await page.goto(`${BASE}#/products`);
await page.waitForSelector('#search');
await page.fill('#search', 'RICE-5');
await page.waitForTimeout(700);
check('the list finds it by another barcode, with a +3 marker',
  (await page.$$('.product-list tbody tr')).length === 1 && (await text('.product-list tbody tr')).includes('+3'));

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#scan');
await page.fill('#scan', 'RICE-4');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check('the till rings it up from another barcode', (await text('#cart-lines')).includes('Tagged Rice'));

/* ------------------------------------------------------------ some customers */
const today = new Date().toISOString().slice(0, 10);
const products = await api('/api/products?limit=5');
for (const [customer, paid, n] of [['Karim Grocery', 0, 0], ['Karim Grocery', 10, 1], ['karim grocery', undefined, 2], ['Salma Cafe', undefined, 3]]) {
  await api('/api/sales', 'POST', {
    customer, date: today, tax: 0, ...(paid === undefined ? {} : { paid }),
    items: [{ product_id: products[n].id, qty: 2, unit_price: products[n].price }, { product_id: products[4].id, qty: 1, unit_price: products[4].price }],
  });
}

/* ------------------------------------------------------------ sales analysis */
console.log('\n[sales analysis]');
check('Sales analysis is a tab of Reports, not a menu item of its own',
  !(await page.$$eval('.nav [data-route]', (a) => a.map((x) => x.dataset.route))).includes('analysis'));
await page.evaluate(() => sessionStorage.removeItem('absoft-analysis'));
await page.goto(`${BASE}#/reports`);
await page.waitForSelector('#report-tabs [data-tab="analysis"]');
await page.click('#report-tabs [data-tab="analysis"]');
await page.waitForSelector('.an-table tbody tr');
check('the Reports tab opens it', page.url().endsWith('#/reports/analysis') &&
  (await page.$$('#report-tabs .active[data-tab="analysis"]')).length === 1);
const month = await api(`/api/reports/sales-analysis?from=${today.slice(0, 8)}01&to=${today}`);
check('it opens on this month\'s invoice lines', (await text('#an-table .card-head h3')) === 'Invoice lines' &&
  (await page.$$('#groups .active[data-group="lines"]')).length === 1 &&
  (await page.inputValue('.an-range [name=from]')) === `${today.slice(0, 8)}01`);
check('the tiles show the totals', (await text('#an-stats')).includes(
  (await page.evaluate((v) => new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v), month.totals.sales))));
const heads = (await text('.an-table thead')).toLowerCase();
check('with sales, cost, profit and margin columns and a totals row',
  ['sales', 'cost', 'profit', 'margin'].every((h) => heads.includes(h)) && (await page.$$('.an-table tfoot tr')).length === 1, heads);
await shot('171-analysis-lines');

await page.click('#groups [data-group="item"]');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By item'));
check('grouping by item', (await page.$$('.an-table tbody tr')).length > 1);
await page.click('.an-table th[data-sort="profit"]');
await page.waitForFunction(() => document.querySelector('.an-table th[data-sort="profit"]')?.textContent.includes('↓'));
const profits = await page.$$eval('.an-table tbody tr', (rows) =>
  rows.map((r) => Number(r.children[7].textContent.replace(/[^0-9.-]/g, ''))));
check('sorting by profit, biggest first', profits.every((p, i) => i === 0 || p <= profits[i - 1]), JSON.stringify(profits));
await shot('172-analysis-items');
const firstItem = await text('.an-table tbody tr:first-child .cell-title');
await page.click('.an-table tbody tr:first-child');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By invoice'));
check('clicking an item shows its invoices, filtered to it', (await page.inputValue('#f-product')) === firstItem && await page.isVisible('#f-clear'));
await page.click('#f-clear');
await page.waitForFunction(() => document.querySelector('#f-clear')?.hidden);
check('Clear filters lifts it', (await page.inputValue('#f-product')) === '');

await page.click('#groups [data-group="customer"]');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By customer'));
check('by customer: two spellings are one customer, walk-ins their own row',
  (await page.$$('.an-table tbody tr')).length === 3 && (await text('.an-table tbody')).includes('Walk-in'));
await page.click('.an-table tbody tr:has-text("Karim Grocery")');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By item'));
const karim = await api(`/api/reports/sales-analysis?from=${today.slice(0, 8)}01&to=${today}&customer=Karim Grocery`);
check('a customer opens into what they bought', (await page.inputValue('#f-customer')) === 'Karim Grocery' &&
  (await page.$$('.an-table tbody tr')).length === karim.totals.items);

await page.click('#groups [data-group="month"]');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By month'));
await page.click('.an-table tbody tr:first-child');
await page.waitForFunction(() => document.querySelector('.card-head h3')?.textContent.includes('By day'));
check('a month opens into its days', (await page.inputValue('.an-range [name=from]')).endsWith('-01'));
await shot('173-analysis-drill');

await page.goto(`${BASE}#/sales`);
await page.goto(`${BASE}#/analysis`); // an old link still lands on it
await page.waitForSelector('.an-table');
check('an old #/analysis link lands on the Reports tab', page.url().includes('#/reports/analysis'));
check('coming back keeps the filters and grouping', (await page.inputValue('#f-customer')) === 'Karim Grocery' &&
  (await page.$$('#groups .active[data-group="day"]')).length === 1);
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
check('Export downloads the whole result', download.suggestedFilename().startsWith('absoft-sales-analysis-day-'));

/* ------------------------------------------------------------ a customer's page */
console.log('\n[a customer\'s page]');
await page.goto(`${BASE}#/lists/customer`);
await page.waitForSelector('[data-edit]');
await page.click('tr[data-edit]:has-text("Karim Grocery")');
await page.waitForSelector('.party-hero');
check('clicking a customer opens their page', /#\/lists\/customer\/\d+$/.test(page.url()) && (await text('.party-hero h2')) === 'Karim Grocery');
const karimId = Number(page.url().match(/(\d+)$/)[1]);
const summary = (await api(`/api/entities/customer/${karimId}/summary`)).summary;
check('five tiles: balance, sales, paid, profit, last sale', (await page.$$('#party-stats .stat')).length === 5);
check('the balance owed is on show', summary.balance > 0 && (await text('#party-stats .stat:first-child')).includes('2 invoices still open'),
  await text('#party-stats .stat:first-child'));
await page.waitForSelector('.party-statement tbody tr');
const statement = await api(`/api/entities/customer/${karimId}/statement`);
check('the statement lists invoices and payments with a running balance',
  (await page.$$('.party-statement tbody tr')).length === statement.entries.length + 1 &&
  (await text('.party-statement tbody')).includes('Payment'));
check('ending on what is owed', (await text('.party-statement tfoot')).includes((await text('#party-stats .stat:first-child .value'))));
await shot('174-customer-statement');

await page.click('#tabs [data-tab="invoices"]');
await page.waitForSelector('.card-head h3:has-text("Invoices")');
check('the invoices tab lists theirs', (await page.$$('#tab-body tbody tr')).length === 3 && page.url().endsWith('/invoices'));
await page.selectOption('#tab-body .filter-select select', 'unpaid');
await page.waitForTimeout(600);
check('and filters to the unpaid ones', (await page.$$('#tab-body tbody tr')).length === 1);
await page.click('#tabs [data-tab="items"]');
await page.waitForSelector('.card-head h3:has-text("Items bought")');
check('the items tab shows what they bought', (await page.$$('#tab-body tbody tr')).length === karim.totals.items);
await shot('175-customer-items');

await page.click('#edit');
await page.waitForSelector('#page-form input[name=phone]');
await page.fill('input[name=phone]', '+961 70 123 456');
await page.click('#page-form button[type=submit]');
await page.waitForSelector('.party-hero');
check('editing returns to the page, with the new phone', (await text('.party-contact')).includes('+961 70 123 456'));

await page.click('#to-analysis');
await page.waitForSelector('.an-table');
check('Sales analysis opens filtered to the customer', (await page.inputValue('#f-customer')) === 'Karim Grocery' &&
  (await page.$$('#groups .active[data-group="item"]')).length === 1);

const sale = (await api('/api/sales?customer=Karim Grocery'))[0];
await page.goto(`${BASE}#/sales/${sale.id}`);
await page.waitForSelector('[data-customer]');
await page.click('[data-customer]');
await page.waitForSelector('.party-hero');
check('an invoice opens its customer\'s page', page.url().endsWith(`#/lists/customer/${karimId}`));

/* ------------------------------------------------------------ a supplier's page */
console.log('\n[a supplier\'s page]');
await page.goto(`${BASE}#/lists/supplier`);
await page.waitForSelector('[data-edit]');
await page.click('tr[data-edit]:has-text("Wholesale Depot")');
await page.waitForSelector('.party-statement tbody tr');
check('a supplier\'s page: four tiles and the purchases statement', (await page.$$('#party-stats .stat')).length === 4 &&
  (await page.$$('.party-statement tbody tr')).length === 4 && (await text('.party-note')).includes('payments'));
await page.click('#tabs [data-tab="items"]');
await page.waitForSelector('.card-head h3:has-text("Items supplied")');
check('with the items they supplied', (await page.$$('#tab-body tbody tr')).length === 10);
await shot('176-supplier-items');
await page.click('#tabs [data-tab="purchases"]');
await page.waitForSelector('#tab-body tbody tr[data-purchase]');
await page.click('#tab-body tbody tr[data-purchase]');
await page.waitForSelector('[data-supplier]');
await page.click('[data-supplier]');
await page.waitForSelector('.party-hero');
check('a purchase opens its supplier\'s page', /#\/lists\/supplier\/\d+$/.test(page.url()));

await page.evaluate(() => localStorage.setItem('absoft-theme', 'dark'));
await page.goto(`${BASE}#/lists/customer/${karimId}`);
await page.reload();
await page.waitForSelector('.party-statement tbody tr');
await shot('177-customer-dark');

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
