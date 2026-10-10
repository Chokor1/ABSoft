/** Price lists on screen: made in Settings, typed on a product, used on a sale. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'pricelistui');
const PORT = 4577;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------- nothing changes yet */
console.log('\n[a shop with one list notices nothing]');
await page.goto(`${BASE}#/sales/new`);
await page.waitForSelector('#sale-form');
check('the sale form has no price list field', !(await page.$('#sale-form [name=price_list_id]')));
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('form');
check('and a new product form stays as it was', !(await page.$('.prices-field')));

/* -------------------------------------------------------------- making a list */
console.log('\n[making a wholesale list]');
await page.goto(`${BASE}#/settings/prices`);
await page.waitForSelector('#price-list-table');
const firstRows = await page.$$eval('#price-list-table tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')));
check('the main list is there from the start', firstRows.length === 1 && firstRows[0].includes('Retail'), firstRows.join(' | '));
check('and it cannot be removed', !(await page.$('#price-list-table tbody tr [data-del]')));
await page.click('#list-new');
await page.waitForSelector('.modal input[name=name]');
await page.fill('.modal input[name=name]', 'جملة');
await page.selectOption('.modal select[name=use_for]', 'sell');
await page.click('.modal button[type=submit]');
await wait(async () => (await page.$$('#price-list-table tbody tr')).length === 2, 5000);
const rows = await page.$$eval('#price-list-table tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')));
check('the new list joins the main one', rows.length === 2 && rows[1].includes('جملة') && rows[1].includes('Selling'), rows.join(' | '));
await shot('150-price-lists');

/* --------------------------------------------------------- pricing a product */
console.log('\n[a product priced on it]');
const beans = (await page.evaluate(async () => (await fetch('/api/products?search=Espresso')).json()))[0];
await page.goto(`${BASE}#/products/${beans.id}/pricing`);
await page.waitForSelector('#pricing-table');
const priceRows = await page.$$eval('#pricing-table tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')));
check('the product has a Pricing tab listing every list', priceRows.length === 2 &&
  priceRows[0].includes('Retail') && priceRows[1].includes('جملة'), priceRows.join(' | '));
check('the main list shows the product\'s own price', (await page.inputValue(`[data-price-list="1"]`)) === '18');
const otherId = await page.evaluate(async () => (await (await fetch('/api/price-lists')).json()).find((l) => !l.is_default).id);
check('and the other list is empty, falling back to it',
  (await page.inputValue(`[data-price-list="${otherId}"]`)) === '' &&
  priceRows[1].includes('Sold at the main price'), priceRows[1]);
check('no price change is recorded yet', (await page.textContent('#page')).includes('No price change yet'));
await page.fill(`[data-price-list="${otherId}"]`, '14');
await page.click('#save-prices');
await wait(async () => {
  const p = await page.evaluate(async (id) => (await fetch(`/api/products/${id}`)).json(), beans.id);
  return p.prices?.length === 1;
}, 5000);
const saved = await page.evaluate(async (id) => (await fetch(`/api/products/${id}`)).json(), beans.id);
check('the list price is saved beside the product price', Math.abs(saved.prices[0].price - 14) < 0.01 && Math.abs(saved.price - 18) < 0.01,
  JSON.stringify({ list: saved.prices, own: saved.price }));
await page.waitForSelector('#price-history', { timeout: 6000 });
const hist = (await page.textContent('#price-history')).replace(/\s+/g, ' ');
check('and the change is written into the price history', hist.includes('جملة') && hist.includes('$14.00') && hist.includes('admin'), hist);
await shot('151-product-prices');

/* --------------------------------------------------------- a customer's list */
console.log('\n[a customer served at that list]');
await page.goto(`${BASE}#/customers/new`);
await page.waitForSelector('form [name=name]');
await page.fill('form [name=name]', 'Wholesale Walid');
check('the customer form offers a price list', !!(await page.$('form [name=price_list_id]')));
const listId = await page.evaluate(async () => (await (await fetch('/api/price-lists')).json()).find((l) => !l.is_default).id);
await page.selectOption('form [name=price_list_id]', String(listId));
await page.click('form button[type=submit]');
await page.waitForTimeout(800);
const walid = await page.evaluate(async () => (await (await fetch('/api/entities/customer?all=1')).json())
  .find((e) => e.name === 'Wholesale Walid'));
check('and keeps it', walid?.price_list_id === listId, JSON.stringify(walid?.price_list_id));

/* ------------------------------------------------------------ selling on it */
console.log('\n[selling on the list]');
await page.goto(`${BASE}#/sales/new`);
await page.waitForSelector('#sale-form [name=price_list_id]');
check('the sale form now asks which prices to use', true);
await page.fill('#sale-form [name=customer]', 'Wholesale Walid');
await page.dispatchEvent('#sale-form [name=customer]', 'change');
await page.keyboard.press('Escape'); // the name suggestions are done with
await wait(async () => (await page.inputValue('#sale-form [name=price_list_id]')) === String(listId), 5000);
check('choosing the customer picks their list', (await page.inputValue('#sale-form [name=price_list_id]')) === String(listId));
await page.fill('[data-product="0"]', 'Espresso');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item', { timeout: 8000 });
await page.click('.combo-menu .combo-item');
await wait(async () => Math.abs(Number(await page.inputValue('[data-price="0"]')) - 14) < 0.01, 5000);
check('the line is priced at the list price, not the shelf price',
  Math.abs(Number(await page.inputValue('[data-price="0"]')) - 14) < 0.01, await page.inputValue('[data-price="0"]'));
await shot('152-sale-on-list');
await page.click('#save-sale');
await page.waitForSelector('.doc-head, .receipt', { timeout: 8000 });
const sale = await page.evaluate(async () => (await (await fetch('/api/sales?limit=1')).json())[0]);
check('the sale is kept with the list it was priced at', sale.price_list_id === listId, JSON.stringify(sale.price_list_id));
check('and it sold at 14, not 18', Math.abs(sale.total - 14) < 0.01, String(sale.total));

/* ------------------------------------------------- back to the shelf price */
console.log('\n[the main list is still the shelf price]');
await page.goto(`${BASE}#/sales/new`);
await page.waitForSelector('#sale-form [name=price_list_id]');
await page.fill('[data-product="0"]', 'Espresso');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item', { timeout: 8000 });
await page.click('.combo-menu .combo-item');
await wait(async () => Number(await page.inputValue('[data-price="0"]')) > 0, 5000);
check('a sale on the main list uses the product price', Math.abs(Number(await page.inputValue('[data-price="0"]')) - 18) < 0.01,
  await page.inputValue('[data-price="0"]'));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
