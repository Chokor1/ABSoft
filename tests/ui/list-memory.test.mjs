/** A list remembers where you were: open a row, come back, same page, same filters. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'listmemory');
const PORT = 4595;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

rmSync(DATA, { recursive: true, force: true });
for (const tool of ['seed.js', 'demo-products.js']) {
  const run = spawn('node', ['--no-warnings', `server/tools/${tool}`], { cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA } });
  await new Promise((r) => run.on('exit', r));
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

const pageLabel = () => page.textContent('.pager-page');
const firstRow = () => page.$eval('table.data tbody tr .cell-title', (el) => el.textContent.trim());

/* ------------------------------------------------------------- products */
console.log('\n[a product opened from page 2]');
await page.goto(`${BASE}#/products`);
await page.waitForSelector('table.data tbody tr');
check('the catalogue runs to more than one page', (await pageLabel()).includes('of') && !(await pageLabel()).includes('of 1'), await pageLabel());
await page.click('.pager-nav [data-go="2"]');
await wait(async () => (await pageLabel()).includes('2'), 5000);
const onPageTwo = await firstRow();
check('the second page is showing', (await pageLabel()).includes('2'), await pageLabel());
await page.click('table.data tbody tr');
await page.waitForSelector('.doc-head, #page-form, .product-hero', { timeout: 8000 });
check('a product opens', page.url().includes('#/products/'), page.url());
await page.click('[data-back], .doc-head [data-back]').catch(() => page.goBack());
await page.waitForSelector('table.data tbody tr', { timeout: 8000 });
check('coming back lands on the page you left, not the first',
  (await pageLabel()).includes('2') && (await firstRow()) === onPageTwo, `${await pageLabel()} · ${await firstRow()}`);
await shot('170-list-memory');

console.log('\n[and the filters you set]');
await page.fill('#search', 'a');
await page.waitForTimeout(700);
const searched = await pageLabel();
await page.click('table.data tbody tr');
await page.waitForSelector('.product-hero, #page-form', { timeout: 8000 });
await page.click('[data-back]').catch(() => page.goBack());
await page.waitForSelector('#search', { timeout: 8000 });
check('the search box still holds what was typed', (await page.inputValue('#search')) === 'a', await page.inputValue('#search'));
check('and the same rows are listed', (await pageLabel()) === searched, `${searched} → ${await pageLabel()}`);

/* ---------------------------------------------------------------- sales */
console.log('\n[an invoice opened from a filtered list]');
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data tbody tr');
await page.selectOption('.filter-select select', { index: 1 }).catch(() => {});
await page.waitForTimeout(600);
const salesPage = await page.textContent('#page');
await page.click('table.data tbody tr');
await page.waitForSelector('.doc-head', { timeout: 8000 });
await page.click('.doc-head [data-back]');
await page.waitForSelector('table.data tbody tr', { timeout: 8000 });
check('the Sell list comes back as it was', (await page.textContent('#page')).length > 0 &&
  (await page.$eval('.filter-select select', (s) => s.selectedIndex)) === 1, String(await page.$eval('.filter-select select', (s) => s.selectedIndex)));

/* ---------------------------------------------- a fresh session starts clean */
console.log('\n[a fresh session starts clean]');
// The memory lasts as long as the tab does: open the shop tomorrow and every
// list is back at its first page.
await page.evaluate(() => sessionStorage.clear());
await page.goto(`${BASE}#/products`);
await page.reload();
await page.waitForSelector('table.data tbody tr');
check('a new session opens the list at the first page, unfiltered',
  (await page.inputValue('#search')) === '' && (await pageLabel()).includes('1'),
  `"${await page.inputValue('#search')}" · ${await pageLabel()}`);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
