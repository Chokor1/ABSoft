/**
 * List pages keep their table inside a fixed, scrolling section, and a saved
 * purchase can be edited from the browser with its history on show.
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
const DATA = resolve(WORK, 'lists');
const PORT = 4525;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------- the name */
console.log('\n[the till is called Sell — POS]');
check('the menu says Sell — POS', (await page.textContent('.nav [href="#/pos"]'))?.includes('Sell — POS'),
  await page.textContent('.nav [href="#/pos"]'));

/* ------------------------------------------------------ scrolling tables */
const measure = () =>
  page.evaluate(() => {
    const wrap = document.querySelector('.table-scroll');
    const th = wrap?.querySelector('thead th');
    return {
      hasTable: !!wrap,
      pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 1,
      tableOverflows: wrap ? wrap.scrollHeight > wrap.clientHeight + 1 : false,
      bottom: wrap ? Math.round(wrap.getBoundingClientRect().bottom) : 0,
      thTop: th ? Math.round(th.getBoundingClientRect().top) : 0,
      toolbarTop: Math.round((document.querySelector('.page > :first-child')?.getBoundingClientRect().top) ?? 0),
    };
  });

async function listPage(route, label, { mustOverflow = false, before: prepare } = {}) {
  console.log(`\n[${label}: the table scrolls inside its section]`);
  await page.goto(`${BASE}#/${route}`);
  if (prepare) await prepare();
  await page.waitForSelector('.table-scroll tbody tr, .card .empty:not(:has(p:only-child))', { timeout: 8000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const before = await measure();
  check(`${label}: the list renders its table`, before.hasTable, JSON.stringify(before));
  check(`${label}: the page itself does not scroll`, !before.pageScrolls, JSON.stringify(before));
  check(`${label}: the table ends inside the window`, before.bottom <= 860, JSON.stringify(before));
  if (mustOverflow) check(`${label}: the rows overflow the section`, before.tableOverflows, JSON.stringify(before));
  if (!before.tableOverflows) return;

  await page.hover('.table-scroll tbody tr');
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(400);
  const after = await measure();
  const scrolled = await page.evaluate(() => document.querySelector('.table-scroll').scrollTop);
  check(`${label}: wheel scrolls the rows`, scrolled > 0, String(scrolled));
  check(`${label}: the header row stays put`, after.thTop === before.thTop, JSON.stringify({ before, after }));
  check(`${label}: and so does the toolbar above`, after.toolbarTop === before.toolbarTop, JSON.stringify({ before, after }));
  check(`${label}: the window did not move`, (await page.evaluate(() => window.scrollY)) === 0);
  await shot(`65-list-${route.replace(/\W/g, '-')}`);
}

await listPage('products', 'Products', { mustOverflow: true });
// The demo catalogue fills the categories tab; customers may be empty on a fresh seed.
await listPage('lists', 'Lists', {
  before: async () => {
    await page.waitForSelector('[data-kind="category"]');
    await page.click('[data-kind="category"]');
    await page.waitForTimeout(600);
  },
});
await listPage('sales', 'Sales history');
await listPage('purchases', 'Purchases');
await listPage('expenses', 'Expenses');
await listPage('users', 'Users');

console.log('\n[on a phone the page scrolls as before]');
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${BASE}#/products`);
await page.waitForSelector('.table-scroll tbody tr');
await page.waitForTimeout(300);
const phone = await measure();
check('the page scrolls normally on a phone', phone.pageScrolls, JSON.stringify(phone));
check('the body never scrolls sideways',
  await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1));
await page.setViewportSize({ width: 1440, height: 860 });

/* -------------------------------------------------------- purchase edit */
console.log('\n[a purchase can be edited, and the edit is logged]');
const today = await page.evaluate(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
const made = await page.evaluate(async (date) => {
  const products = await (await fetch('/api/products?limit=2')).json();
  const res = await fetch('/api/purchases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supplier: 'Edit Supplier', date, note: 'ZZ-EDIT',
      items: [{ product_id: products[0].id, qty: 12, unit_cost: 3 }],
    }),
  });
  return { purchase: await res.json(), product: products[0] };
}, today);
const stockBefore = await page.evaluate(async (id) => (await (await fetch(`/api/products/${id}`)).json()).stock, made.product.id);

await page.goto(`${BASE}#/purchases`);
await page.fill('[data-search]', 'Edit Supplier');
await page.waitForTimeout(800);
await page.click(`[data-open="${made.purchase.id}"] td:first-child`);
await page.waitForSelector('.purchase-log');
check('the purchase shows its history', (await page.textContent('.purchase-log')).includes('Created'));
check('with who created it', (await page.textContent('.purchase-log')).includes('Administrator'));
await page.click('.modal [data-edit]');

await page.waitForSelector('#purchase-form');
check('the edit page is titled with the document', (await page.textContent('#purchase-form h3')).includes(made.purchase.doc_no));
check('it is filled in with the saved supplier', (await page.inputValue('input[name=supplier]')) === 'Edit Supplier');
check('and the saved line', (await page.inputValue('[data-qty="0"]')) === '12');
check('there is a reason field', await page.isVisible('input[name=reason]'));
await shot('66-purchase-edit');

await page.fill('[data-qty="0"]', '5');
await page.fill('input[name=reason]', 'Supplier short-shipped');
await page.click('#save-purchase');
await page.waitForSelector('.table-scroll, .empty', { timeout: 8000 });
await page.waitForTimeout(500);

const stockAfter = await page.evaluate(async (id) => (await (await fetch(`/api/products/${id}`)).json()).stock, made.product.id);
check('stock follows the corrected quantity', Math.abs(stockAfter - (stockBefore - 7)) < 0.001, `${stockBefore} → ${stockAfter}`);

await page.fill('[data-search]', 'Edit Supplier');
await page.waitForTimeout(800);
check('the list marks it as edited', (await page.textContent(`[data-open="${made.purchase.id}"]`)).includes('Edited'));
await page.click(`[data-open="${made.purchase.id}"] td:first-child`);
await page.waitForSelector('.purchase-log');
const logText = await page.textContent('.purchase-log');
check('the history shows the edit on top', (await page.textContent('.log-entry:first-child .badge')).includes('Edited'), logText);
check('with the quantity change', logText.includes('12') && logText.includes('5'), logText);
check('and the reason', logText.includes('Supplier short-shipped'), logText);
await page.waitForTimeout(400);
await shot('67-purchase-history');
await page.click('.modal-head [data-close]');

console.log('\n[a cashier cannot open the edit page]');
await page.evaluate(() =>
  fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'clerk7', password: 'test1234', role: 'cashier' }),
  }));
const clerk = await browser.newPage({ viewport: { width: 1440, height: 860 } });
await clerk.goto(BASE);
await clerk.waitForSelector('#login-form');
await clerk.fill('input[name=username]', 'clerk7');
await clerk.fill('input[name=password]', 'test1234');
await clerk.click('button[type=submit]');
await clerk.waitForSelector('.shell');
await clerk.goto(`${BASE}#/purchases/${made.purchase.id}/edit`);
await clerk.waitForTimeout(800);
check('the edit link sends a cashier to the till instead', (await clerk.$$('#purchase-form')).length === 0 && clerk.url().endsWith('#/pos'),
  clerk.url());
await clerk.close();

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
