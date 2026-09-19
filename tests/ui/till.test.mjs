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
// Enough products that the card section has to scroll.
const demo = spawn('node', ['--no-warnings', 'server/tools/demo-products.js'], { cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA } });
await new Promise((r) => demo.on('exit', r));
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

/* ------------------------------------------------- pictures on the cards */
console.log('\n[product pictures as card backgrounds]');
check('pictures are off by default', (await page.$$('.tile-pic')).length === 0 && (await page.getAttribute('#toggle-images', 'aria-pressed')) === 'false');
await page.click('#toggle-images');
await page.waitForTimeout(300);
const cards = await page.$$eval('.tile', (t) => t.length);
check('the picture button turns every card into a picture card', (await page.$$('.tile-pic')).length === cards, String(cards));
const pictured = await page.$$eval('.tp-media:not(.no-img)', (t) => t.length);
check('demo products come with pictures', pictured >= 20, String(pictured));
const media = await page.evaluate(() => {
  const img = document.querySelector('.tp-img');
  const box = img.closest('.tp-media').getBoundingClientRect();
  const r = img.getBoundingClientRect();
  const card = img.closest('.tile');
  const name = card.querySelector('.tp-name').getBoundingClientRect();
  const price = card.querySelector('.tp-body .t-price').getBoundingClientRect();
  return {
    fit: getComputedStyle(img).objectFit,
    covers: Math.abs(r.width - box.width) < 1 && Math.abs(r.height - box.height) < 1,
    nameInside: name.bottom <= box.bottom + 1 && name.top >= box.top,
    priceBelow: price.top >= box.bottom,
    ratio: Math.round((box.width / box.height) * 100) / 100,
  };
});
check('the picture covers its whole area, centred', media.fit === 'cover' && media.covers, JSON.stringify(media));
check('with the name over its lower edge and the price underneath', media.nameInside && media.priceBelow, JSON.stringify(media));
check('products without a picture get a placeholder', (await page.$$('.tp-media.no-img svg')).length >= 1);
const headers = await page.evaluate(async () => {
  const el = document.querySelector('.tp-media:not(.no-img)').closest('.tile');
  const res = await fetch(`/api/products/${el.dataset.add}/image`);
  return { type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy') || '' };
});
check('pictures are served so nothing inside them can run', headers.type === 'image/svg+xml' && headers.csp.includes('sandbox'), JSON.stringify(headers));
await page.waitForTimeout(600);
await shot('88-till-picture-cards');
await page.reload();
await page.waitForSelector('.tile');
check('the choice is remembered on this device', (await page.$$('.tile-pic')).length === cards);
await page.click('#toggle-images');
await page.waitForTimeout(200);
check('and the button turns them off again', (await page.$$('.tile-pic')).length === 0);

/* ------------------------------------------ a big catalogue stays light */
console.log('\n[the till never loads the whole catalogue]');
const catalogue = await page.evaluate(async () => (await (await fetch('/api/products?page=1&per=5')).json()).total);
const opened = await page.$$eval('.tile', (t) => t.map((x) => Number(x.dataset.add)));
check('it opens on the 40 best sellers, not every product', catalogue > 100 && opened.length === 40, `${opened.length} of ${catalogue}`);
// Most units sold over the last 30 days first; products that have not sold fill the rest.
const sold = await page.evaluate(async () => {
  const d = new Date(Date.now() - 29 * 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const rows = await (await fetch(`/api/reports/products?from=${d}`)).json();
  return Object.fromEntries(rows.map((p) => [p.id, p.qty]));
});
const soldIds = Object.keys(sold).map(Number);
// Products that sold come first, most sold at the top; ties may fall either way.
const qtyOrder = opened.slice(0, soldIds.length).map((id) => sold[id] ?? -1);
check('best sellers first, most sold at the top', soldIds.length > 0 &&
  soldIds.every((id) => opened.slice(0, soldIds.length).includes(id)) &&
  qtyOrder.every((q, i) => i === 0 || q <= qtyOrder[i - 1]), `${JSON.stringify(sold)} / ${qtyOrder}`);

// A product far down the alphabet with no sales is not on screen until searched.
const hidden = await page.evaluate(async (ids) => {
  const rows = (await (await fetch('/api/products?page=2&per=200')).json()).rows;
  const all = rows.length ? rows : (await (await fetch('/api/products?page=1&per=200')).json()).rows;
  return all.reverse().find((p) => !ids.includes(p.id) && p.name.split(' ')[0].length >= 5);
}, opened);
const requests = [];
page.on('request', (r) => r.url().includes('/api/products?') && requests.push(r.url()));
const word = hidden.name.split(' ')[0].toLowerCase();
// By default a search of every product starts from the first letter.
await page.fill('#scan', word.slice(0, 1));
await wait(async () => requests.some((u) => u.includes('search=')), 5000);
check('one letter already searches every product', requests.some((u) => u.includes('search=')), requests.join(' '));
await page.fill('#scan', word);
await page.waitForFunction((id) => !!document.querySelector(`.tile[data-add="${id}"]:not([hidden])`), hidden.id, { timeout: 5000 });
await wait(async () => requests.some((u) => u.includes(`search=${encodeURIComponent(word)}`)), 5000);
check('and finds a product that was not on screen', requests.some((u) => u.includes(`search=${encodeURIComponent(word)}`)), requests.join(' '));
await page.keyboard.press('Escape');
await page.waitForFunction((n) => {
  const shown = document.querySelectorAll('.tile').length;
  return shown >= 40 && shown < n;
}, catalogue);
check('clearing the search brings the best sellers back', true);

const scrollCards = () =>
  page.evaluate(() => {
    const grid = document.querySelector('#tiles');
    grid.scrollTop = grid.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
await scrollCards();
await page.waitForFunction(() => document.querySelectorAll('.tile').length > 40, null, { timeout: 5000 });
const afterOneScroll = (await page.$$('.tile')).length;
check('scrolling to the end of the cards loads the next batch', afterOneScroll > 40 && afterOneScroll % 40 === 0 &&
  afterOneScroll < catalogue, String(afterOneScroll));
for (let i = 0; i < 4; i++) {
  await scrollCards();
  await page.waitForTimeout(700);
}
const everything = (await page.$$('.tile')).length;
check('and keeps going until every product is there, once each', everything === catalogue &&
  new Set(await page.$$eval('.tile', (t) => t.map((x) => x.dataset.add))).size === catalogue, `${everything} of ${catalogue}`);
await page.goto(`${BASE}#/dashboard`);
await page.goto(`${BASE}#/pos`);
// Reopened, it starts from the best sellers again (a taller window may pull in a second batch).
await page.waitForFunction((n) => {
  const shown = document.querySelectorAll('.tile').length;
  return shown >= 40 && shown < n;
}, catalogue);
await page.fill('#scan', hidden.barcode);
await page.keyboard.press('Enter');
await page.waitForFunction((name) => document.querySelector('#cart-lines')?.textContent.includes(name), hidden.name, { timeout: 5000 });
check('scanning a product that is not on screen still rings it up', true);
await page.click('#clear-cart');
await page.waitForTimeout(300);
const confirmBtn = await page.$('.modal [data-confirm]');
if (confirmBtn) await confirmBtn.click();
await page.waitForTimeout(300);

/* ------------------------------------------------------- ways to pay */
console.log('\n[the ways to pay the shop keeps]');
await page.goto(`${BASE}#/lists/payment_method`);
await page.waitForSelector('tbody tr');
const listed = await page.$$eval('tbody tr .cell-title', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('the list starts with Cash and On account, marked built in',
  listed[0].startsWith('Cash') && listed[0].includes('built in') && listed[1].startsWith('On account'), listed.join(' | '));
check('Whish and OMT come ready to use', listed.some((x) => x.startsWith('Whish')) && listed.some((x) => x.startsWith('OMT')));
check('each one shows its icon', (await page.$$('.method-icon svg')).length === listed.length);
check('a built-in one has no delete button, the others do',
  (await page.$$('tbody tr:nth-child(1) [data-del]')).length === 0 && (await page.$$('tbody tr [data-del]')).length > 0);
await shot('90-payment-methods');

await page.click('#new');
await page.waitForSelector('#page-form input[name=name]');
await page.fill('input[name=name]', 'Bank cheque');
await page.selectOption('#icon-choice', 'bank');
check('the form previews the icon as it is chosen', (await page.innerHTML('#icon-preview')).includes('<svg'));
await page.click('#page-form button[type=submit]');
await page.waitForSelector('tbody tr');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await scan('5449000000996');
await page.click('#checkout');
await page.waitForSelector('.pay-methods');
const buttons = await page.$$eval('.pay-methods button', (b) => b.map((x) => x.textContent.trim()));
check('a method added in Lists is offered at the till', buttons.includes('Bank cheque'), buttons.join(' | '));
check('with an icon on every button', (await page.$$('.pay-methods button svg')).length === buttons.length);
await page.click('.pay-methods button:has-text("Whish")');
await page.waitForTimeout(200);
await page.click('.modal-foot .btn-primary');
await page.waitForSelector('.receipt', { timeout: 8000 });
const paid = await page.evaluate(async () => (await (await fetch('/api/sales?page=1&per=1')).json()).rows[0].method);
check('and a sale taken that way records it', paid === 'Whish', paid);
await page.click('.modal-head [data-close]');
await page.waitForTimeout(500);

/* ----------------------------------------------------- the cart is simple */
console.log('\n[the cart is only what is being sold]');
check('no customer field in the cart', (await page.$$('.cart #customer')).length === 0);
check('no payment method in the cart', (await page.$$('.cart #method')).length === 0);
check('no paying-now field in the cart', (await page.$$('.cart #paid-now')).length === 0);
check('the button says Make payment', (await text('#checkout')).includes('Make payment'));
check('and is disabled with nothing to sell', await page.isDisabled('#checkout'));

/* ------------------------------------------------ full height, compact lines */
console.log('\n[the cart takes the full height]');
const emptyCart = await page.evaluate(() => ({
  cart: Math.round(document.querySelector('.cart').getBoundingClientRect().height),
  vh: window.innerHeight,
}));
check('an empty cart already fills the height of the screen', emptyCart.cart >= emptyCart.vh - 140,
  JSON.stringify(emptyCart));

/* ------------------------------------------------- cards scroll, search stays */
console.log('\n[the product cards scroll inside their own section]');
// Let fonts and the top bar settle before measuring positions.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
const scroll = await page.evaluate(() => {
  const grid = document.querySelector('#tiles');
  return {
    pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 1,
    gridScrolls: grid.scrollHeight > grid.clientHeight + 1,
    overflow: getComputedStyle(grid).overflowY,
  };
});
check('the page itself does not scroll', !scroll.pageScrolls, JSON.stringify(scroll));
check('the card section scrolls instead', scroll.gridScrolls && scroll.overflow === 'auto', JSON.stringify(scroll));

const before = await page.evaluate(() => ({
  scan: Math.round(document.querySelector('.scan-bar').getBoundingClientRect().top),
  cart: Math.round(document.querySelector('.cart').getBoundingClientRect().top),
}));
await page.hover('#tiles .tile');
await page.mouse.wheel(0, 1500);
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  scan: Math.round(document.querySelector('.scan-bar').getBoundingClientRect().top),
  cart: Math.round(document.querySelector('.cart').getBoundingClientRect().top),
  gridTop: document.querySelector('#tiles').scrollTop,
  windowY: window.scrollY,
}));
check('scrolling the cards moves the cards', after.gridTop > 0, JSON.stringify(after));
check('the barcode search stays exactly where it was', after.scan === before.scan, JSON.stringify({ before, after }));
check('so does the cart', after.cart === before.cart, JSON.stringify({ before, after }));
check('and the window has not moved', after.windowY === 0, JSON.stringify(after));
await shot('89-till-scrolled-cards');
await page.evaluate(() => { document.querySelector('#tiles').scrollTop = 0; });

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
  (await page.inputValue('.cl-head + .cart-line [data-field="qty"]')) === '2',
  await page.inputValue('.cl-head + .cart-line [data-field="qty"]'));
check('the total is 2×1.00 + 2.50 + 18.00 = 22.50', (await text('#totals')).includes('$22.50'), await text('#totals'));
await shot('90-till-cart');
const sizes = await page.evaluate(() => ({
  line: Math.round(document.querySelector('.cart-line').getBoundingClientRect().height),
  cart: Math.round(document.querySelector('.cart').getBoundingClientRect().height),
  foot: Math.round(document.querySelector('.cart-foot').getBoundingClientRect().bottom),
  cartBottom: Math.round(document.querySelector('.cart').getBoundingClientRect().bottom),
}));
check('each line is compact', sizes.line <= 64, JSON.stringify(sizes));
check('the height does not change as items are added', Math.abs(sizes.cart - emptyCart.cart) <= 1, JSON.stringify(sizes));
check('the total stays pinned to the bottom of the cart', Math.abs(sizes.foot - sizes.cartBottom) <= 2, JSON.stringify(sizes));
check('column names appear once, above the lines', (await page.$$('.cl-head')).length === 1);

/* ------------------------------------------------------ edit where it sits */
console.log('\n[lines are edited in place]');
check('there is no edit button to open', (await page.$$('.cart-line [data-edit]')).length === 0);
check('each line has quantity, unit price, discount and (once opened) its total',
  (await page.$$('.cl-head + .cart-line [data-field]')).length === 4);

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

check('the line discount is a percentage, and says so',
  (await page.getAttribute(`${espresso} [data-field="discount"]`, 'placeholder')) === 'Discount %' &&
    (await text('.cl-head')).includes('Discount %'), await page.getAttribute(`${espresso} [data-field="discount"]`, 'placeholder'));
await page.fill(`${espresso} [data-field="discount"]`, '25');
await page.waitForTimeout(150);
check('25% comes off that line (48 − 12 = 36)',
  (await text(`${espresso} [data-total]`)).includes('$36.00'), await text(`${espresso} [data-total]`));
check('the cart total follows (2 + 2.50 + 36 = 40.50)', (await text('#totals')).includes('$40.50'), await text('#totals'));
check('and shows the discount given in money', (await text('#totals')).includes('$12.00'), await text('#totals'));
check('typing never threw focus out of the field',
  await page.evaluate(() => document.activeElement?.dataset?.field === 'discount'));

/* --------------------------------------------- selling a line at a price */
console.log('\n[a line opens, and takes the total you want]');
// :has-text() is Playwright's own; inside the browser the line is found by its text.
const detailShown = () =>
  page.evaluate(() => {
    const line = [...document.querySelectorAll('.cart-line')].find((el) => el.textContent.includes('Espresso'));
    return getComputedStyle(line.querySelector('.cl-detail')).display !== 'none';
  });
check('the extra fields are closed until the line is opened', !(await detailShown()));
await page.click(`${espresso} [data-toggle]`);
await page.waitForTimeout(250);
check('the chevron opens the line, on the total',
  (await detailShown()) && (await page.evaluate(() => document.activeElement?.dataset?.field === 'total')));
check('it opens on what the line comes to, with the discount in money',
  (await page.inputValue(`${espresso} [data-field="total"]`)) === '36' &&
  (await text(`${espresso} [data-discount]`)) === '$12.00', await text(`${espresso} [data-discount]`));

// 3 × 16 = 48 asked to come to 30: the discount is worked out, not typed.
await page.fill(`${espresso} [data-field="total"]`, '30');
await page.waitForTimeout(200);
check('typing the total works out the discount', (await text(`${espresso} [data-discount]`)) === '$18.00' &&
  (await page.inputValue(`${espresso} [data-field="discount"]`)) === '37.5', await page.inputValue(`${espresso} [data-field="discount"]`));
check('and the line and cart totals follow', (await text(`${espresso} [data-total]`)).includes('$30.00') &&
  (await text('#totals')).includes('$34.50'), await text('#totals'));

// Above the full price there is nothing to discount, so the unit price moves instead.
await page.fill(`${espresso} [data-field="total"]`, '60');
await page.waitForTimeout(200);
check('a total above the full price raises the unit price instead',
  (await page.inputValue(`${espresso} [data-field="unit_price"]`)) === '20' &&
  (await text(`${espresso} [data-discount]`)) === '$0.00', await page.inputValue(`${espresso} [data-field="unit_price"]`));
await page.fill(`${espresso} [data-field="discount"]`, '25');
await page.waitForTimeout(200);
check('a discount typed as a percentage still updates the total field',
  (await page.inputValue(`${espresso} [data-field="total"]`)) === '45', await page.inputValue(`${espresso} [data-field="total"]`));
await shot('89-till-line-open');
await page.click(`${espresso} [data-toggle]`);
await page.waitForTimeout(250);
check('the chevron closes it again', !(await detailShown()));
// Back to where the rest of the test expects it: 3 × 16 with 25% off.
await page.fill(`${espresso} [data-field="unit_price"]`, '16');
await page.waitForTimeout(200);
check('the line is 3 × 16 less 25% again', (await text(`${espresso} [data-total]`)).includes('$36.00'), await text(`${espresso} [data-total]`));

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
await scan('7622210992796');   // muffin back, 2.50 -> cart total 38.50
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
check('Make payment opens the payment dialog', await page.isVisible('.modal-backdrop'));
const dialogOrder = await page.evaluate(() => {
  const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
  return { received: top('#pay-amount'), discount: top('#pay-discount') };
});
check('amount received comes before the invoice discount', dialogOrder.received < dialogOrder.discount, JSON.stringify(dialogOrder));
check('there are no Full amount / Half / Pay later buttons', (await page.$$('[data-quick]')).length === 0);
check('customer is chosen here', await page.isVisible('#pay-customer'));
check('and the payment method', await page.isVisible('#pay-method'));
check('and an invoice discount, separate from line discounts', await page.isVisible('#pay-discount'));
check('what is due matches the cart', (await text('#pay-due')).includes('$38.50'), await text('#pay-due'));

await page.fill('#pay-customer', 'Till Customer');
await page.fill('#pay-discount', '2.50');
await page.waitForTimeout(200);
check('an invoice discount reduces what is due (38.50 − 2.50)', (await text('#pay-due')).includes('$36.00'),
  await text('#pay-due'));
check('and the amount received follows it until typed into',
  Number(await page.inputValue('#pay-amount')) === 36, await page.inputValue('#pay-amount'));

await page.click('.modal-foot [data-close]');
await page.waitForTimeout(300);
check('cancelling keeps the cart', (await names()).length === 2);
await page.click('#checkout');
await page.waitForSelector('#pay-amount');
check('and reopening keeps what was typed',
  (await page.inputValue('#pay-customer')) === 'Till Customer' && (await page.inputValue('#pay-discount')) === '2.5',
  `${await page.inputValue('#pay-customer')} / ${await page.inputValue('#pay-discount')}`);

console.log('\n[the payment dialog, improved]');
check('the payment method is a row of buttons, cash chosen', (await page.getAttribute('#pay-method [data-method="cash"]', 'aria-checked')) === 'true');
await page.click('#pay-method [data-method="card"]');
check('clicking Card chooses it', (await page.getAttribute('#pay-method [data-method="card"]', 'aria-checked')) === 'true' &&
  (await page.getAttribute('#pay-method [data-method="cash"]', 'aria-checked')) === 'false');
await page.click('#pay-method [data-method="cash"]');
await page.click('#pay-discount-mode [data-mode="percent"]');
await page.fill('#pay-discount', '10');
await page.waitForTimeout(200);
check('the invoice discount can be a percentage (38.50 − 10% = 34.65)', (await text('#pay-due')).includes('$34.65'), await text('#pay-due'));
await page.click('#pay-discount-mode [data-mode="amount"]');
await page.fill('#pay-discount', '2.50');
await page.waitForTimeout(200);
check('and back to an amount', (await text('#pay-due')).includes('$36.00'), await text('#pay-due'));
const layout = await page.evaluate(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  return { dueLeft: r('.pay-due').left, sideLeft: r('.pay-side').left, dueTop: r('.pay-due').top, sideTop: r('.pay-side').top };
});
check('what is due and the details sit side by side on a wide screen', layout.sideLeft > layout.dueLeft + 100 && Math.abs(layout.sideTop - layout.dueTop) < 30, JSON.stringify(layout));

await page.fill('#pay-amount', '25');
await page.waitForTimeout(200);
check('paying part shows the remainder', (await text('#pay-result')).includes('$11.00'), await text('#pay-result'));
await shot('92-till-payment');

await page.click('#pay-confirm');
await page.waitForSelector('.sale-done', { timeout: 8000 });
check('confirming shows the sale-complete moment', await page.isVisible('.sale-done'));
check('with the amount', (await text('.sale-done')).includes('$36.00'), await text('.sale-done'));
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
check('the total after both discounts', doc.includes('$36.00'), doc.replace(/\s+/g, ' ').slice(0, 300));
check('what was paid', doc.includes('$25.00'));
check('and what remains', doc.includes('$11.00'));
check('a Print button', await page.isVisible('.modal-foot [data-print]'));
check('and a close button', await page.isVisible('.modal-head [data-close]'));
await shot('93-till-receipt');

await page.click('.modal-head [data-close]');
await page.waitForTimeout(400);
check('closing the document returns to an empty cart', (await names()).length === 0);
check('ready for the next sale', await page.isDisabled('#checkout'));

const saved = (await page.evaluate(async () => (await fetch('/api/sales?limit=1')).json()))[0];
check('the sale was stored with both line and invoice discounts',
  saved.customer === 'Till Customer' && Math.abs(saved.total - 36) < 0.005 && Math.abs(saved.discount - 2.5) < 0.005,
  JSON.stringify({ customer: saved.customer, total: saved.total, discount: saved.discount }));

/* ---------------------------------------------------------- sound setting */
console.log('\n[the sound can be turned off]');
await page.goto(`${BASE}#/settings/pos`);
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
await page.goto(`${BASE}#/settings/pos`);
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
    // Only the fields on show: a closed line's extra fields have no box at all.
    const fields = [...document.querySelectorAll('.cl-head + .cart-line .cl-field')]
      .map((f) => f.getBoundingClientRect())
      .filter((f) => f.width > 0);
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

  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(300);
  const stuck = await page.evaluate(() => {
    const bar = document.querySelector('.scan-bar').getBoundingClientRect();
    const top = document.querySelector('.topbar').getBoundingClientRect();
    return { scanTop: Math.round(bar.top), topbarBottom: Math.round(top.bottom), y: Math.round(window.scrollY) };
  });
  check(`${label}: after scrolling down, the search bar is still on screen under the top bar`,
    stuck.y > 0 && Math.abs(stuck.scanTop - stuck.topbarBottom) <= 12, JSON.stringify(stuck));
  await page.evaluate(() => window.scrollTo(0, 0));

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
