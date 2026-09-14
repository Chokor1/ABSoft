/**
 * The till: newest line first, lines edited where they sit, payment in a dialog
 * that goes straight to the receipt, and a layout that still works on a phone.
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
const DATA = resolve(WORK, 'till');
const PORT = 4521;
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
// Count the tones the chime schedules, without needing speakers.
await page.addInitScript(() => {
  window.__tones = 0;
  const Real = window.AudioContext;
  if (!Real) return;
  window.AudioContext = class extends Real {
    createOscillator() {
      window.__tones++;
      return super.createOscillator();
    }
  };
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

const scan = async (code) => {
  await page.fill('#scan', code);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
};
const names = () => page.$$eval('.cart-line .cl-name', (n) => n.map((x) => x.textContent.trim()));
const text = (sel) => page.textContent(sel);

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');

/* ----------------------------------------------------- the cart is simple */
console.log('\n[the cart is only what is being sold]');
check('no customer field in the cart', (await page.$$('.cart #customer')).length === 0);
check('no payment method in the cart', (await page.$$('.cart #method')).length === 0);
check('no paying-now field in the cart', (await page.$$('.cart #paid-now')).length === 0);
check('the button says Make payment', (await text('#checkout')).includes('Make payment'));
check('and is disabled with nothing to sell', await page.isDisabled('#checkout'));

/* ------------------------------------------------------- newest line first */
console.log('\n[a new item goes on top]');
await scan('5449000000996');   // Bottled Water 500ml, 1.00
await scan('7622210992796');   // Chocolate Muffin, 2.50
await scan('5901234123457');   // Espresso Beans 1kg, 18.00
let order = await names();
check('the last scanned item is first', order[0].includes('Espresso'), order.join(' | '));
check('the first scanned item is last', order[2].includes('Bottled Water'), order.join(' | '));

await scan('5449000000996');   // water again
order = await names();
check('scanning an item already in the cart does not add a second line', order.length === 3, order.join(' | '));
check('its line comes back to the top', order[0].includes('Bottled Water'), order.join(' | '));
check('with its quantity increased',
  (await page.inputValue('.cart-line:first-child [data-field="qty"]')) === '2',
  await page.inputValue('.cart-line:first-child [data-field="qty"]'));
check('the total is 2×1.00 + 2.50 + 18.00 = 22.50', (await text('#totals')).includes('$22.50'), await text('#totals'));
await shot('90-till-cart');

/* ------------------------------------------------------ edit where it sits */
console.log('\n[lines are edited in place]');
check('there is no edit button to open', (await page.$$('.cart-line [data-edit]')).length === 0);
check('each line has quantity, unit price and discount fields',
  (await page.$$('.cart-line:first-child [data-field]')).length === 3);

const espresso = '.cart-line:has-text("Espresso")';
await page.fill(`${espresso} [data-field="qty"]`, '3');
await page.waitForTimeout(150);
check('changing the quantity updates the line total at once',
  (await text(`${espresso} [data-total]`)).includes('$54.00'), await text(`${espresso} [data-total]`));
check('and the cart total', (await text('#totals')).includes('$58.50'), await text('#totals'));
check('without a dialog', (await page.$$('.modal-backdrop')).length === 0);

await page.fill(`${espresso} [data-field="unit_price"]`, '16');
await page.waitForTimeout(150);
check('changing the unit price updates the line (3 × 16 = 48)',
  (await text(`${espresso} [data-total]`)).includes('$48.00'), await text(`${espresso} [data-total]`));

await page.fill(`${espresso} [data-field="discount"]`, '8');
await page.waitForTimeout(150);
check('a line discount comes off that line (48 − 8 = 40)',
  (await text(`${espresso} [data-total]`)).includes('$40.00'), await text(`${espresso} [data-total]`));
check('the cart total follows (2 + 2.50 + 40 = 44.50)', (await text('#totals')).includes('$44.50'), await text('#totals'));
check('and shows the discount given', (await text('#totals')).includes('$8.00'), await text('#totals'));
check('typing never threw focus out of the field',
  await page.evaluate(() => document.activeElement?.dataset?.field === 'discount'));

const muffin = '.cart-line:has-text("Muffin")';
await page.click(`${muffin} [data-step="1"]`);
await page.waitForTimeout(150);
check('the + button adds one', (await page.inputValue(`${muffin} [data-field="qty"]`)) === '2');
await page.click(`${muffin} [data-step="-1"]`);
await page.click(`${muffin} [data-step="-1"]`);
await page.waitForTimeout(250);
check('− down to zero removes the line', (await names()).length === 2, (await names()).join(' | '));

await page.click('.cart-line:has-text("Bottled Water") [data-remove]');
await page.waitForTimeout(250);
check('the bin removes a line', (await names()).length === 1, (await names()).join(' | '));
await shot('91-till-inline-edits');

/* ----------------------------------------------------------- the payment */
console.log('\n[paying]');
await scan('7622210992796');   // muffin back, 2.50 -> cart total 42.50
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
check('Make payment opens the payment dialog', await page.isVisible('.modal-backdrop'));
check('customer is chosen here', await page.isVisible('#pay-customer'));
check('and the payment method', await page.isVisible('#pay-method'));
check('and an invoice discount, separate from line discounts', await page.isVisible('#pay-discount'));
check('what is due matches the cart', (await text('#pay-due')).includes('$42.50'), await text('#pay-due'));

await page.fill('#pay-customer', 'Till Customer');
await page.fill('#pay-discount', '2.50');
await page.waitForTimeout(200);
check('an invoice discount reduces what is due (42.50 − 2.50)', (await text('#pay-due')).includes('$40.00'),
  await text('#pay-due'));
check('and the amount received follows it until typed into',
  Number(await page.inputValue('#pay-amount')) === 40, await page.inputValue('#pay-amount'));

await page.click('.modal-foot [data-close]');
await page.waitForTimeout(300);
check('cancelling keeps the cart', (await names()).length === 2);
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
check('and reopening keeps what was typed',
  (await page.inputValue('#pay-customer')) === 'Till Customer' && (await page.inputValue('#pay-discount')) === '2.5',
  `${await page.inputValue('#pay-customer')} / ${await page.inputValue('#pay-discount')}`);

await page.fill('#pay-amount', '25');
await page.waitForTimeout(200);
check('paying part shows the remainder', (await text('#pay-result')).includes('$15.00'), await text('#pay-result'));
await shot('92-till-payment');

await page.click('#pay-confirm');
await page.waitForSelector('.sale-done', { timeout: 8000 });
check('confirming shows the sale-complete moment', await page.isVisible('.sale-done'));
check('with the amount', (await text('.sale-done')).includes('$40.00'), await text('.sale-done'));
check('and the document number', /INV-\d+/.test(await text('.sale-done')), await text('.sale-done'));
check('the check mark draws itself', await page.evaluate(() =>
  getComputedStyle(document.querySelector('.sale-done-check .tick')).animationName.includes('sale-tick')));
check('and a chime plays', (await page.evaluate(() => window.__tones)) > 0, String(await page.evaluate(() => window.__tones)));
await page.waitForTimeout(850); // let the ring and tick finish drawing
await shot('92b-till-sale-done');

await page.waitForSelector('.receipt', { timeout: 8000 });
check('then the document opens by itself', await page.isVisible('.receipt'));
check('the moment has cleared away', (await page.$$('.sale-done')).length === 0);
check('the receipt right after a sale has no Record payment button', (await page.$$('[data-pay]')).length === 0);
check('nor the payment history section', !(await text('.modal-body')).includes('Payments'));
const doc = await text('.receipt');
check('with the customer', (await text('.modal-head')).includes('Till Customer'), await text('.modal-head'));
check('the total after both discounts', doc.includes('$40.00'), doc.replace(/\s+/g, ' ').slice(0, 300));
check('what was paid', doc.includes('$25.00'));
check('and what remains', doc.includes('$15.00'));
check('a Print button', await page.isVisible('.modal-foot [data-print]'));
check('and a close button', await page.isVisible('.modal-head [data-close]'));
await shot('93-till-receipt');

await page.click('.modal-head [data-close]');
await page.waitForTimeout(400);
check('closing the document returns to an empty cart', (await names()).length === 0);
check('ready for the next sale', await page.isDisabled('#checkout'));

const saved = (await page.evaluate(async () => (await fetch('/api/sales?limit=1')).json()))[0];
check('the sale was stored with both line and invoice discounts',
  saved.customer === 'Till Customer' && Math.abs(saved.total - 40) < 0.005 && Math.abs(saved.discount - 2.5) < 0.005,
  JSON.stringify({ customer: saved.customer, total: saved.total, discount: saved.discount }));

/* ---------------------------------------------------------- sound setting */
console.log('\n[the sound can be turned off]');
await page.goto(`${BASE}#/settings`);
await page.waitForSelector('#sound-toggle');
check('Settings has a till sound switch, on by default', await page.isChecked('#sound-toggle'));
await page.uncheck('#sound-toggle');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await scan('5449000000996');
await page.evaluate(() => { window.__tones = 0; });
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
check('with it off, a sale completes silently', (await page.evaluate(() => window.__tones)) === 0,
  String(await page.evaluate(() => window.__tones)));
await page.click('.modal-head [data-close]');
await page.goto(`${BASE}#/settings`);
await page.waitForSelector('#sound-toggle');
await page.check('#sound-toggle');

/* ------------------------------------------------------------ small screens */
for (const [w, h, label] of [[1024, 800, 'tablet'], [390, 844, 'phone']]) {
  console.log(`\n[${label} ${w}px]`);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${BASE}#/pos`);
  await page.waitForSelector('.tile');
  await scan('5449000000996');
  await scan('5901234123457');

  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const cart = box('.cart');
    const tiles = box('#tiles');
    const scanBar = box('.scan-bar');
    const fields = [...document.querySelectorAll('.cart-line:first-child .cl-field')].map((f) => f.getBoundingClientRect());
    return {
      overflow: document.body.scrollWidth > document.documentElement.clientWidth + 1,
      cartBelowScan: cart.top >= scanBar.bottom - 1,
      tilesBelowCart: tiles.top >= cart.bottom - 1,
      cartFits: cart.right <= document.documentElement.clientWidth + 1 && cart.left >= -1,
      fieldsFit: fields.every((f) => f.right <= cart.right + 1 && f.left >= cart.left - 1),
    };
  });
  check(`${label}: no sideways scrolling`, !layout.overflow, JSON.stringify(layout));
  check(`${label}: the cart comes straight after the search`, layout.cartBelowScan, JSON.stringify(layout));
  check(`${label}: products follow the cart`, layout.tilesBelowCart, JSON.stringify(layout));
  check(`${label}: the cart fits the screen`, layout.cartFits, JSON.stringify(layout));
  check(`${label}: line fields fit inside the cart`, layout.fieldsFit, JSON.stringify(layout));

  if (label === 'phone') {
    const topbar = await page.evaluate(() => Math.round(document.querySelector('.topbar').getBoundingClientRect().height));
    check('phone: the top bar stays on one row', topbar <= 80, String(topbar));
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('95a-till-phone-top');
    check('phone: a fixed bar keeps the total and Make payment in reach', await page.isVisible('#pos-bar'));
    check('phone: the bar shows the total', (await text('#bar-total')).includes('$19.00'), await text('#bar-total'));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const bar = await page.evaluate(() => {
      const r = document.querySelector('#pos-bar').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), vh: window.innerHeight };
    });
    check('phone: the bar stays at the bottom while scrolling products', Math.abs(bar.bottom - bar.vh) <= 1, JSON.stringify(bar));
    await shot('95-till-phone');
    await page.click('#bar-checkout');
    await page.waitForSelector('#pay-amount');
    const dialog = await page.evaluate(() => {
      const r = document.querySelector('.modal').getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), vw: document.documentElement.clientWidth };
    });
    check('phone: the payment dialog fits the screen', dialog.left >= 0 && dialog.right <= dialog.vw, JSON.stringify(dialog));
    await shot('96-till-phone-payment');
    await page.click('.modal-foot [data-close]');
  } else {
    check(`${label}: no phone bar on a larger screen`, !(await page.isVisible('#pos-bar')));
    await shot('94-till-tablet');
  }
  await page.click('#clear-cart');
}
await page.setViewportSize({ width: 1500, height: 980 });

/* ------------------------------------------------------------------ Arabic */
console.log('\n[Arabic]');
await page.click('.topbar [data-lang="ar"]');
await page.waitForTimeout(700);
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await scan('5449000000996');
check('Make payment is translated', (await text('#checkout')).includes('الدفع'));
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
check('the invoice discount label is translated', (await text('.modal-body')).includes('خصم على الفاتورة'));
check('no sideways scrolling in RTL',
  await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1));
await page.click('.modal-foot [data-close]');
await page.click('.topbar [data-lang="en"]');
await page.waitForTimeout(500);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
