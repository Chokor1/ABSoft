/**
 * The stock count sheet (جردة): the whole catalogue, one category or a few
 * picked items; the difference as you type; saving corrects the stock and
 * leaves an adjustment document behind.
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
const DATA = resolve(WORK, 'stockcount');
const PORT = 4539;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
const api = (method, path, body) =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  }, { method, path, body });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ the menu */
console.log('\n[a Stock section in the menu]');
const menu = await page.evaluate(() => {
  const fold = document.querySelector('.nav-fold[data-fold="stock"]');
  return {
    found: !!fold,
    label: fold?.querySelector('.nav-parent')?.textContent.trim(),
    items: [...(fold?.querySelectorAll('[data-route]') || [])].map((a) => a.dataset.route),
  };
});
check('a Stock item in the menu holds Products, Stock Count and Stock Adjustment',
  menu.found && menu.label === 'Stock' && menu.items.join() === 'products,stock-count,adjustments', JSON.stringify(menu));
check('the products screen no longer carries those buttons', (await page.$$('#page-actions #stock-count')).length === 0);

const childVisible = () => page.isVisible('.nav-fold[data-fold="stock"] [data-route="stock-count"]');
check('it starts open', (await page.getAttribute('[data-fold-toggle="stock"]', 'aria-expanded')) === 'true' && (await childVisible()));
await page.click('[data-fold-toggle="stock"]');
await page.waitForTimeout(350);
const folded = await page.evaluate(() => {
  const box = document.querySelector('.nav-fold[data-fold="stock"] .nav-children').getBoundingClientRect();
  return Math.round(box.height);
});
check('clicking Stock folds it away', (await page.getAttribute('[data-fold-toggle="stock"]', 'aria-expanded')) === 'false' && folded === 0, String(folded));
await page.reload();
await page.waitForSelector('.shell');
check('and it stays folded after a reload', (await page.getAttribute('[data-fold-toggle="stock"]', 'aria-expanded')) === 'false');
await page.goto(`${BASE}#/stock-count`);
await page.waitForTimeout(500);
check('opening a screen inside it unfolds it, with that screen marked',
  (await page.getAttribute('[data-fold-toggle="stock"]', 'aria-expanded')) === 'true' &&
    (await page.getAttribute('.nav-fold [data-route="stock-count"]', 'class')).includes('active'));

/* ---------------------------------------------------- nothing chosen yet */
console.log('\n[the sheet waits for a choice]');
await page.waitForSelector('#count-body .empty');
check('nothing is loaded until you choose', (await page.$$('.count-table tbody tr')).length === 0);
check('and no option is pre-selected', (await page.$$('#count-mode [data-mode].active')).length === 0);
check('it asks what you are counting', (await page.textContent('#count-body')).includes('What are you counting?'));

/* ------------------------------------------------------- the whole shelf */
console.log('\n[all items]');
await page.click('#count-mode [data-mode="all"]');
await page.waitForSelector('.count-table tbody tr');
const products = await api('GET', '/api/products');
const rows = await page.$$eval('.count-table tbody tr', (r) => r.length);
check('every product is on the sheet', rows === products.length, `${rows} of ${products.length}`);
check('each row shows what the system holds', (await page.textContent('.count-table tbody tr:first-child')).match(/\d/) !== null);

const first = products.find((p) => p.stock > 5);
const row = `tr[data-row="${first.id}"]`;
await page.fill(`${row} [data-counted]`, String(first.stock - 3));
await page.waitForTimeout(150);
check('typing a smaller count shows the difference at once',
  (await page.textContent(`${row} [data-diff]`)).trim() === '-3', await page.textContent(`${row} [data-diff]`));
check('and the new balance', (await page.textContent(`${row} [data-after]`)).includes(String(first.stock - 3)),
  await page.textContent(`${row} [data-after]`));
check('the row is marked as differing', (await page.getAttribute(row, 'class')).includes('differs'));
const second = products.find((p) => p.id !== first.id);
await page.fill(`tr[data-row="${second.id}"] [data-counted]`, String(second.stock));
await page.waitForTimeout(150);
check('a count that matches is marked counted, not differing',
  (await page.getAttribute(`tr[data-row="${second.id}"]`, 'class')).includes('counted') &&
    !(await page.getAttribute(`tr[data-row="${second.id}"]`, 'class')).includes('differs'));
check('the summary counts both', (await page.textContent('#count-summary')).includes('2 counted'), await page.textContent('#count-summary'));
check('and the totals row says how many differ', (await page.textContent('[data-foot]')).includes('1 differ'), await page.textContent('[data-foot]'));
await shot('120-stock-count');

/* --------------------------------------------------------- saving it */
console.log('\n[saving corrects the stock]');
await page.fill('#count-note', 'Aisle 1, evening count');
await page.click('#count-save');
await page.waitForSelector('.doc-head', { timeout: 8000 });
check('it lands on the adjustment document it created', /#\/adjustments\/\d+$/.test(page.url()), page.url());
const doc = await page.textContent('.doc-body');
check('with only the product that differed', (await page.$$('.doc-body tbody tr')).length === 1, doc.replace(/\s+/g, ' ').slice(0, 160));
check('and the note', (await page.textContent('.doc-head, .doc-body')).includes('Aisle 1') || doc.includes('Aisle 1'));
check('the reason says it was a stock count', (await page.textContent('.doc-head')).includes('Stock count'));
const after = (await api('GET', `/api/products/${first.id}`)).stock;
check('the stock is corrected to what was counted', Math.abs(after - (first.stock - 3)) < 0.001, `${first.stock} → ${after}`);
const untouched = (await api('GET', `/api/products/${second.id}`)).stock;
check('a matching count changes nothing', Math.abs(untouched - second.stock) < 0.001);
await shot('121-stock-count-doc');

/* ------------------------------------------------- by category, and picking */
console.log('\n[counting one category, or a few items]');
await page.goto(`${BASE}#/stock-count`);
await page.waitForSelector('#count-body .empty');
await page.click('#count-mode [data-mode="category"]');
await page.waitForTimeout(300);
check('choosing By category empties the sheet first', (await page.$$('.count-table tbody tr')).length === 0);
await page.click('#count-category');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item');
const category = (await page.textContent('.combo-menu:not([hidden]) .combo-item .ci-name')).trim();
await page.click('.combo-menu:not([hidden]) .combo-item');
await page.waitForSelector('.count-table tbody tr');
const inCategory = products.filter((p) => p.category === category).length;
check(`the sheet holds just that category (${category})`, (await page.$$('.count-table tbody tr')).length === inCategory,
  `${(await page.$$('.count-table tbody tr')).length} of ${inCategory}`);

await page.click('#count-mode [data-mode="pick"]');
await page.waitForTimeout(300);
// Not one the count above already corrected, and read fresh: its stock has moved.
const scanned = (await api('GET', '/api/products')).find((p) => p.barcode && p.id !== first.id && p.id !== second.id);
await page.fill('#count-find', scanned.barcode);
await page.keyboard.press('Enter');
await page.waitForSelector('.count-table tbody tr');
check('scanning a barcode puts that one item on the sheet',
  (await page.$$('.count-table tbody tr')).length === 1 && (await page.textContent('.count-table tbody')).includes(scanned.name));
check('with the cursor in its counted box', await page.evaluate(() => document.activeElement?.dataset?.counted !== undefined));
await page.keyboard.type(String(scanned.stock + 2));
await page.waitForTimeout(150);
check('counting more than the system shows a positive difference',
  (await page.textContent('[data-diff]')).trim() === '+2', await page.textContent('[data-diff]'));
await shot('122-stock-count-pick');
await page.click('#count-save');
await page.waitForSelector('.doc-head', { timeout: 8000 });
const found = (await api('GET', `/api/products/${scanned.id}`)).stock;
check('saving a picked sheet corrects that item too', Math.abs(found - (scanned.stock + 2)) < 0.001, `${scanned.stock} → ${found}`);

console.log('\n[a cashier has no stock count]');
await api('POST', '/api/users', { username: 'count-till', password: 'test1234', role: 'cashier' });
const till = await browser.newContext({ viewport: { width: 1200, height: 800 } }).then((c) => c.newPage());
await till.goto(BASE);
await till.waitForSelector('#login-form');
await till.fill('input[name=username]', 'count-till');
await till.fill('input[name=password]', 'test1234');
await till.click('button[type=submit]');
await till.waitForSelector('.shell');
check('no Stock section for a cashier', (await till.$$('[data-route="stock-count"]')).length === 0);
await till.goto(`${BASE}#/stock-count`);
await till.waitForTimeout(700);
check('and the address sends them back to the till', till.url().endsWith('#/pos'), till.url());
await till.close();

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
