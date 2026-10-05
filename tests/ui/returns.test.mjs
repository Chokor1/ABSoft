/** Returns on screen: from the invoice page, from the till by invoice number, and as documents in Sell. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'returnsui');
const PORT = 4551;
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
const shot = (n) => page.screenshot({ path: `${SHOTS}\\${n}.png` });
const text = (sel) => page.textContent(sel);
const send = (method, path, body) => page.evaluate(async ([m, p, b]) =>
  (await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })).json(), [method, path, body]);
const toasts = () => page.$$eval('#toasts .toast', (t) => t.map((x) => x.textContent.trim()));

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

// 3 water at 1.00 and 1 muffin at 2.50, paid in cash.
const water = (await send('GET', '/api/products/lookup?code=5449000000996'));
const muffin = (await send('GET', '/api/products/lookup?code=7622210992796'));
const sale = await send('POST', '/api/sales', { items: [{ product_id: water.id, qty: 3, unit_price: 1 }, { product_id: muffin.id, qty: 1, unit_price: 2.5 }], tax: 0, method: 'cash', paid: 5.5, customer: 'Rita' });
check('an invoice of 5.50 to return from', sale.doc_no?.startsWith('INV-') && Math.abs(sale.total - 5.5) < 0.005, JSON.stringify(sale.total));

/* ---------------------------------------------------- from the invoice */
console.log('\n[from the invoice page]');
await page.goto(`${BASE}#/sales/${sale.id}`);
await page.waitForSelector('[data-return]');
check('the invoice page offers to return items', await page.isVisible('[data-return]'));
await page.click('[data-return]');
await page.waitForSelector('.modal .ret-table');
check('the dialog is named for the invoice', (await text('.modal h3')).includes(`Return from ${sale.doc_no}`), await text('.modal h3'));
check('it lists the invoice\'s lines with what was sold', (await page.$$('.modal .ret-table tbody tr')).length === 2 &&
  (await text('.modal .ret-table tbody tr:first-child')).includes('3 pcs'));
check('the button says there is nothing to refund yet', (await text('.modal [data-save]')).includes('$0.00'), await text('.modal [data-save]'));
await page.fill('.modal tr[data-i="0"] [data-qty]', '1');
await page.waitForTimeout(150);
check('one water back: the refund is $1.00', (await text('.modal [data-save]')).includes('Refund $1.00') && (await text('.modal tr[data-i="0"] [data-refund]')) === '$1.00', await text('.modal [data-save]'));
await page.fill('.modal tr[data-i="1"] [data-qty]', '1');
await page.click('.modal tr[data-i="1"] [data-shelf="0"]');
await page.waitForTimeout(150);
check('…and the damaged muffin too: $3.50', (await text('.modal [data-save]')).includes('Refund $3.50'), await text('.modal [data-save]'));
check('the refund goes out the way the invoice was paid, unless changed', await page.$eval('.modal #ret-method .active', (b) => b.dataset.method) === 'cash');
await page.fill('.modal tr[data-i="0"] [data-qty]', '9');
await page.waitForTimeout(150);
check('more than was sold is clamped to what is left', (await text('.modal [data-save]')).includes('Refund $5.50'));
await page.fill('.modal tr[data-i="0"] [data-qty]', '1');
await page.waitForTimeout(150);
await shot('200-return-dialog');
await page.click('.modal [data-save]');
await page.waitForTimeout(900);
check('the return is saved and announced', (await toasts()).some((s) => s.includes('RET-000001') && s.includes('$3.50')), JSON.stringify(await toasts()));
check('the invoice page now lists it', (await page.$$('[data-open-doc]')).length === 1 && (await text('[data-open-doc]')).includes('RET-000001') && (await text('[data-open-doc]')).includes('-$3.50'));
check('…and still offers to return the two water left', await page.isVisible('[data-return]'));
const stockNow = await send('GET', `/api/products/${water.id}`);
check('the water went back on the shelf, the muffin did not', stockNow.stock === water.stock - 2 && (await send('GET', `/api/products/${muffin.id}`)).stock === muffin.stock - 1,
  `${water.stock} → ${stockNow.stock}`);
await shot('201-invoice-with-return');

await page.click('[data-open-doc]');
await page.waitForSelector('.doc-head');
await page.waitForTimeout(400);
check('the return opens as a document of its own', (await text('.doc-head h2')).includes('Return RET-000001') && (await text('.doc-head .sub')).includes(`for ${sale.doc_no}`), await text('.doc-head h2'));
check('marked as a return, refunded', (await text('.doc-badges')).includes('Return') && (await text('.doc-badges')).includes('refunded'), await text('.doc-badges'));
check('its receipt says RETURN and what was refunded', (await text('#receipt-print')).includes('RETURN') && (await text('#receipt-print')).includes('Refund'));
check('it cannot be returned again', !(await page.isVisible('[data-return]')));
check('but leads back to its invoice', (await text('[data-open-doc]')).includes(sale.doc_no));
await shot('202-return-document');

/* ------------------------------------------------------------- in Sell */
console.log('\n[in the Sell list]');
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
await page.waitForTimeout(400);
check('the list shows the return with a badge', (await page.$$eval('table.data tbody tr', (rows) => rows.filter((r) => r.textContent.includes('RET-000001') && r.querySelector('.badge.danger')).length)) === 1);
await page.selectOption('.filter-select select >> nth=0', 'returns');
await page.waitForTimeout(700);
check('the Returns filter shows it alone', (await page.$$('table.data tbody tr')).length === 1 && (await text('table.data tbody')).includes('RET-000001'));
await page.selectOption('.filter-select select >> nth=0', 'sales');
await page.waitForTimeout(700);
check('the Invoices filter leaves it out', !(await text('table.data tbody')).includes('RET-000001') && (await page.$$('table.data tbody tr')).length > 0);

/* ------------------------------------------------------------ at the till */
console.log('\n[at the till: exchange]');
await page.keyboard.press('F2');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.fill('#scan', sale.doc_no.toLowerCase());
await page.keyboard.press('Enter');
await page.waitForSelector('.modal .ret-table');
check('typing the invoice number opens the return, whatever the case', (await text('.modal h3')).includes(sale.doc_no));
check('the line already returned says so', (await text('.modal tr[data-i="0"]')).includes('1 returned before'));
check('the till offers an exchange', await page.isVisible('.modal [data-exchange]'));
await page.fill('.modal tr[data-i="0"] [data-qty]', '1');
await page.click('.modal [data-exchange]');
await page.waitForTimeout(900);
check('the refund is saved as RET-000002', (await toasts()).some((s) => s.includes('RET-000002') && s.includes('$1.00')), JSON.stringify(await toasts()));
check('a chip says the next sale is an exchange', await page.isVisible('#exchange-chip') && (await text('#exchange-chip')).includes('RET-000002'), await text('#exchange-chip'));
check('the cursor is back in the search box', await page.evaluate(() => document.activeElement?.id === 'scan'));
await shot('203-till-exchange');
await page.fill('#scan', '7622210992796');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('F9');
await page.waitForSelector('#pay-amount');
await page.keyboard.press('Enter');
await page.waitForSelector('#receipt-print', { timeout: 8000 });
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('the new sale done, the chip is gone', !(await page.isVisible('#exchange-chip')));
await page.fill('#scan', 'INV-999999');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('an unknown invoice number says so', (await toasts()).some((s) => s.includes('No invoice INV-999999')), JSON.stringify(await toasts()));

/* ------------------------------------------------- the obvious ways in */
console.log('\n[a Return button at the till and on every Sell row]');
check('the till has a Return button beside the search', await page.isVisible('#take-return') && (await text('#take-return')).includes('Return'));
await page.click('#take-return');
await page.waitForSelector('#ret-list [data-pick]');
check('it lists the latest invoices to choose from, and no returns', (await text('.modal h3')).includes('Return from which invoice') &&
  (await page.$$('#ret-list [data-pick]')).length >= 2 && !(await text('#ret-list')).includes('RET-'), await text('#ret-list'));
await page.fill('#ret-search', sale.doc_no);
await page.waitForTimeout(700);
check('the box finds an invoice by its number', (await page.$$('#ret-list [data-pick]')).length === 1 && (await text('#ret-list')).includes(sale.doc_no));
await page.click('#ret-list [data-pick]');
await page.waitForSelector('.modal .ret-table');
check('choosing one opens its return', (await text('.modal h3')).includes(`Return from ${sale.doc_no}`));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
await page.waitForTimeout(400);
const rowOf = `table.data tbody tr:has-text("${sale.doc_no}")`;
check('every invoice row in Sell has a Return button', await page.isVisible(`${rowOf} [data-return-row]`));
check("…and a return's own row does not", (await page.$$('table.data tbody tr:has-text("RET-000001") [data-return-row]')).length === 0);
await page.click(`${rowOf} [data-return-row]`);
await page.waitForSelector('.modal .ret-table');
check('it opens the return for that row without leaving the list', (await text('.modal h3')).includes(sale.doc_no) && page.url().endsWith('#/sales'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* --------------------------------------------------------------- cashier */
console.log('\n[a cashier can, an administrator voids]');
await send('POST', '/api/users', { username: 'till6', password: 'test1234', role: 'cashier' });
const till = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await till.goto(BASE);
await till.waitForSelector('#login-form');
await till.fill('input[name=username]', 'till6');
await till.fill('input[name=password]', 'test1234');
await till.click('button[type=submit]');
await till.waitForSelector('.shell');
await till.goto(`${BASE}#/sales/${sale.id}`);
await till.waitForSelector('.doc-head');
await till.waitForTimeout(400);
check('a cashier sees Return items on an invoice', await till.isVisible('[data-return]'));
check('…but not Void', !(await till.isVisible('[data-void]')));
await till.close();

await page.goto(`${BASE}#/sales/${sale.id}`);
await page.waitForSelector('[data-open-doc]');
await page.click('[data-open-doc] >> nth=1');
await page.waitForSelector('.doc-head');
await page.waitForTimeout(400);
check('opened RET-000002', (await text('.doc-head h2')).includes('RET-000002'));
await page.click('[data-void]');
await page.waitForSelector('.modal [data-confirm]');
await page.click('.modal [data-confirm]');
await page.waitForTimeout(800);
check('an administrator voids a return like any sale', (await toasts()).some((s) => s.includes('voided')) && page.url().endsWith('#/sales'));
const back = await send('GET', `/api/sales/${sale.id}`);
check('the invoice keeps only the other return', back.returns.length === 1 && back.returns[0].doc_no === 'RET-000001');

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
