/**
 * Rows open pages, not dialogs: the product page (edit, reports, picture), the
 * invoice page; totals rows that stay in view; the report menu that stays put;
 * and the notice shown when the server is older than the screens.
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
const DATA = resolve(WORK, 'pages');
const PORT = 4533;
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
const page = await browser.newPage({ viewport: { width: 1366, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
const noDialog = async () => (await page.$$('.modal-backdrop')).length === 0;

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ product page */
console.log('\n[a product opens as a page]');
await page.goto(`${BASE}#/products`);
await page.waitForSelector('.table-scroll tbody tr');
const name = (await page.textContent('.table-scroll tbody tr:first-child .cell-title')).trim();
await page.click('.table-scroll tbody tr:first-child td:nth-child(2)');
await page.waitForSelector('.product-hero');
check('clicking a row opens the product page', /#\/products\/\d+$/.test(page.url()) && (await noDialog()), page.url());
check('with the product name', (await page.textContent('.product-hero h2')).includes(name), name);
const tabs = await page.$$eval('#tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
check('and its tabs: overview, details, movements, sales, purchases', tabs.join() === 'overview,details,movements,sales,purchases', tabs.join());
check('the overview charts the last 30 days', !!(await page.$('#tab-body svg')));
await shot('90-product-overview');
const productId = Number(page.url().match(/products\/(\d+)/)[1]);

console.log('\n[editing it in place]');
await page.click('#tabs [data-tab="details"]');
await page.waitForSelector('#page-form input[name=name]');
check('the details tab is the edit form', (await page.inputValue('input[name=name]')) === name);
check('and the address remembers the tab', page.url().endsWith(`/products/${productId}/details`), page.url());
await page.fill('input[name=price]', '4.25');
await page.click('#page-form button[type=submit]');
await page.waitForTimeout(900);
check('saving updates the header straight away', (await page.textContent('.product-hero')).includes('$4.25'));
check('and stays on the page', page.url().endsWith(`/products/${productId}/details`));

console.log('\n[a picture]');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
await page.setInputFiles('#image-file', { name: 'tea.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('.product-hero img.pthumb', { timeout: 8000 });
const loaded = await page.$eval('.product-hero img.pthumb', (img) =>
  new Promise((r) => (img.complete ? r(img.naturalWidth) : (img.onload = () => r(img.naturalWidth)))));
check('uploading shows the picture', loaded > 0, String(loaded));
check('offers to remove it', !!(await page.$('#image-remove')));
await shot('91-product-picture');
await page.goto(`${BASE}#/products`);
await page.waitForSelector('.table-scroll tbody tr');
check('the list stays compact: no picture in the row', !(await page.$(`tr[data-open="${productId}"] img`)));
check('and no action buttons', (await page.$$('.table-scroll tbody button')).length === 0);
const rowHeight = await page.$eval(`tr[data-open="${productId}"]`, (tr) => tr.getBoundingClientRect().height);
check('rows are slim', rowHeight <= 42, String(rowHeight));
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
check('so does the till', !!(await page.$(`.tile[data-add="${productId}"] img.pthumb`)));
await page.goto(`${BASE}#/products/${productId}`);
await page.waitForSelector('#image-remove');
await page.click('#image-remove');
await page.waitForTimeout(600);
check('removing it goes back to initials', !(await page.$('.product-hero img.pthumb')) && !!(await page.$('.product-hero .pthumb.empty')));

console.log('\n[its reports]');
await page.click('#tabs [data-tab="movements"]');
await page.waitForSelector('#tab-body table.data tbody tr');
check('movements list every stock change with the balance', (await page.$$('#tab-body tbody tr')).length > 1);
await page.click('#tabs [data-tab="sales"]');
await page.waitForSelector('#tab-body .stat');
const salesText = await page.textContent('#tab-body');
check('the sales report shows quantity, revenue and profit', /Quantity sold/.test(salesText) && /Revenue/.test(salesText) && /Profit/.test(salesText));
const saleRow = await page.$('#tab-body tr[data-sale]');
check('with the invoices that sold it', !!saleRow);
await shot('92-product-sales');
const bought = await page.evaluate(async () => {
  const [first] = await (await fetch('/api/purchases?from=2000-01-01&to=2100-01-01')).json();
  return (await (await fetch(`/api/purchases/${first.id}`)).json()).items[0].product_id;
});
await page.goto(`${BASE}#/products/${bought}/purchases`);
await page.waitForSelector('#tab-body .card');
check('the purchases tab lists what it was bought at', (await page.$$('#tab-body tr[data-purchase]')).length > 0);

console.log('\n[the tabs stay in reach]');
await page.click('#tabs [data-tab="movements"]');
await page.waitForTimeout(600);
const tabsTop = async () => Math.round((await page.$eval('.tabs-bar', (el) => el.getBoundingClientRect().top)));
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(300);
const topbarBottom = await page.$eval('.topbar', (el) => Math.round(el.getBoundingClientRect().bottom));
check('scrolling down keeps the tabs under the top bar', Math.abs((await tabsTop()) - topbarBottom) <= 2,
  `${await tabsTop()} vs ${topbarBottom}`);
const tableBottom = await page.$eval('#tab-body .table-scroll', (el) => Math.round(el.getBoundingClientRect().bottom));
check('and the movements table fits the window below them', tableBottom <= 720, String(tableBottom));
await page.evaluate(() => window.scrollTo(0, 0));

/* ---------------------------------------------------------- invoice page */
console.log('\n[an invoice opens as a page]');
await page.goto(`${BASE}#/sales`);
await page.click('.seg [data-preset="2"]'); // 30 days: plenty of rows
await page.waitForTimeout(900);
await page.waitForSelector('.table-scroll tbody tr');

const foot = async () =>
  page.evaluate(() => {
    const wrap = document.querySelector('.table-scroll');
    // The cells are what stick; the tfoot box itself stays at the end of the table.
    const f = wrap.querySelector('tfoot td').getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return { overflow: wrap.scrollHeight > wrap.clientHeight + 1, footBottom: Math.round(f.bottom), wrapBottom: Math.round(w.bottom) };
  });
const f1 = await foot();
check('the sales list overflows its section', f1.overflow, JSON.stringify(f1));
check('the totals row sits at the bottom of the section', Math.abs(f1.footBottom - f1.wrapBottom) <= 2, JSON.stringify(f1));
await page.hover('.table-scroll tbody tr');
await page.mouse.wheel(0, 800);
await page.waitForTimeout(300);
const f2 = await foot();
check('and stays there while the rows scroll', Math.abs(f2.footBottom - f2.wrapBottom) <= 2, JSON.stringify(f2));
await shot('93-sales-fixed-totals');

await page.click('.table-scroll tbody tr:first-child td:nth-child(3)');
await page.waitForSelector('.doc-head');
check('clicking a sale opens its page', /#\/sales\/\d+$/.test(page.url()) && (await noDialog()), page.url());
check('with the receipt', !!(await page.$('.doc-body .receipt')));
check('and the summary with cost and profit for an administrator', /Profit/.test(await page.textContent('.sale-summary')));
await shot('94-sale-page');
await page.click('.doc-head [data-back]');
await page.waitForSelector('.table-scroll');
check('Back returns to the list', page.url().endsWith('#/sales'), page.url());

console.log('\n[a short list ends at its totals]');
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('.table-scroll tbody tr');
await page.fill('[data-search]', (await page.textContent('.table-scroll tbody tr:first-child td:first-child')).trim());
await page.waitForTimeout(900);
const short = await page.evaluate(() => {
  const card = document.querySelector('.table-scroll').closest('.card').getBoundingClientRect();
  const td = document.querySelector('.table-scroll tfoot td').getBoundingClientRect();
  return { cardBottom: Math.round(card.bottom), footBottom: Math.round(td.bottom), rows: document.querySelectorAll('.table-scroll tbody tr').length };
});
check('with one row, the card ends right under the totals', short.rows === 1 && short.cardBottom - short.footBottom <= 2, JSON.stringify(short));

console.log('\n[on a small window the totals still stay in view]');
await page.setViewportSize({ width: 820, height: 640 });
await page.fill('[data-search]', '');
await page.waitForTimeout(900);
await page.hover('.table-scroll tbody tr');
await page.mouse.wheel(0, 600);
await page.waitForTimeout(300);
const narrow = await page.evaluate(() => {
  const wrap = document.querySelector('.table-scroll');
  const td = wrap.querySelector('tfoot td').getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  return { inner: wrap.scrollTop, footBottom: Math.round(td.bottom), wrapBottom: Math.round(w.bottom), vh: innerHeight };
});
check('the rows scroll in a section no taller than the window', narrow.inner > 0 && narrow.wrapBottom - narrow.footBottom <= 2, JSON.stringify(narrow));
await page.setViewportSize({ width: 1366, height: 720 });

console.log('\n[purchases and adjustments keep their totals in view too]');
await page.goto(`${BASE}#/purchases`);
await page.waitForSelector('.table-scroll tfoot');
check('purchases have a sticky totals row', (await page.$eval('.table-scroll tfoot td', (td) => getComputedStyle(td).position)) === 'sticky');

/* ---------------------------------------------------------------- reports */
console.log('\n[the report menu stays fixed]');
await page.goto(`${BASE}#/reports`);
await page.waitForSelector('.sticky-bar [data-tab]');
// Profit & Loss is a long page of cards: it scrolls, and the menu sticks.
await page.waitForTimeout(900);
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(300);
const bar = await page.$eval('.sticky-bar', (el) => Math.round(el.getBoundingClientRect().top));
const tb = await page.$eval('.topbar', (el) => Math.round(el.getBoundingClientRect().bottom));
const scrolled = await page.evaluate(() => window.scrollY);
check('after scrolling Profit & Loss, the menu is right under the top bar', scrolled > 0 && Math.abs(bar - tb) <= 2, `bar ${bar} topbar ${tb} scrollY ${scrolled}`);
await page.evaluate(() => window.scrollTo(0, 0));

// The table reports keep the page still and scroll their rows inside.
for (const tab of ['products', 'stock', 'history', 'staff']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const wrap = document.querySelector('.table-scroll');
    if (!wrap) return { table: false };
    const th = wrap.querySelector('thead th').getBoundingClientRect();
    const foot = wrap.querySelector('tfoot td')?.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return {
      table: true,
      pageScrolls: document.scrollingElement.scrollHeight > innerHeight + 1,
      inside: wrap.scrollHeight > wrap.clientHeight + 1,
      headTop: Math.round(th.top - w.top),
      footGap: foot ? Math.round(w.bottom - foot.bottom) : null,
      bottom: Math.round(w.bottom),
    };
  });
  check(`${tab}: the report table is a fixed section`, r.table && !r.pageScrolls && r.bottom <= 720, JSON.stringify(r));
  if (r.inside) {
    await page.hover('.table-scroll tbody tr');
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const wrap = document.querySelector('.table-scroll');
      const th = wrap.querySelector('thead th').getBoundingClientRect();
      const foot = wrap.querySelector('tfoot td')?.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return { scrolled: wrap.scrollTop, headTop: Math.round(th.top - w.top), footGap: foot ? Math.round(w.bottom - foot.bottom) : null };
    });
    check(`${tab}: rows scroll inside while the header${after.footGap === null ? '' : ' and totals'} stay`,
      after.scrolled > 0 && after.headTop === 0 && (after.footGap === null || Math.abs(after.footGap) <= 2), JSON.stringify(after));
  }
}
await page.click('[data-tab="history"]');
await page.waitForTimeout(900);
await shot('95-reports-sticky');

/* ---------------------------------------------------------------- icon */
console.log('\n[the stock adjustment icon]');
check('the menu uses the clipboard icon, not sliders',
  (await page.$eval('.nav-item[data-route="adjustments"] svg', (s) => s.innerHTML)).includes('rect x="8" y="2"'));

/* ------------------------------------------------------ restart notice */
console.log('\n[a server older than the screens]');
await page.route('**/api/adjustments*', (route) =>
  route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No API route', code: 'NO_ROUTE' }) }));
await page.goto(`${BASE}#/adjustments`);
await page.waitForSelector('.restart-notice', { timeout: 8000 });
check('the page explains a restart is needed', (await page.textContent('.page')).includes('restart'), await page.textContent('.page'));
check('instead of "not available"', !(await page.textContent('.page')).includes('not available'));
await shot('96-restart-notice');
await page.unroute('**/api/adjustments*');

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
