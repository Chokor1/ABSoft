/** Sizes on screen: made on the product, chosen at the till, kept on the sale. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'sizesui');
const PORT = 4615;
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
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ the product */
console.log('\n[a juice is given its sizes]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('.sizes-field');
check('a new product can have sizes, and starts with none', (await page.$$('.sizes-field [data-size-row]')).length === 0);
await page.fill('input[name=name]', 'Mango');
await page.fill('input[name=price]', '3');
await page.fill('input[name=cost]', '1');
for (const [name, price, cost] of [['S', '3', ''], ['M', '4', ''], ['L', '5', '1.11'], ['Bottle', '8', '']]) {
  await page.click('.sizes-field [data-add-size]');
  const row = '.sizes-field [data-size-row]:last-child';
  await page.fill(`${row} [data-size-name]`, name);
  await page.fill(`${row} [data-size-price]`, price);
  if (cost) await page.fill(`${row} [data-size-cost]`, cost);
}
await shot('190-product-sizes');
await page.click('form button[type=submit]');
await page.waitForURL(/#\/products\/\d+/, { timeout: 8000 });
const mango = (await api('/api/products?search=Mango&limit=5')).find((p) => p.name === 'Mango');
check('the product is saved with its four sizes, in order',
  mango && mango.sizes.map((z) => `${z.name}:${z.price}`).join() === 'S:3,M:4,L:5,Bottle:8', JSON.stringify(mango?.sizes));
check('and the cost given for one size', Math.abs(mango.sizes[2].cost - 1.11) < 0.01);
await page.waitForSelector('.sizes-field [data-size-row]');
check('opening it again shows the sizes to edit', (await page.$$('.sizes-field [data-size-row]')).length === 4);

/* ------------------------------------------------------------ the till */
console.log('\n[at the till]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Mango');
await page.waitForSelector(`#tiles .tile[data-add="${mango.id}"]:not([hidden])`, { timeout: 6000 });
const card = (await page.textContent(`#tiles .tile[data-add="${mango.id}"]`)).replace(/\s+/g, ' ');
check('its card says where the prices start, and how many sizes', card.includes('from') && card.includes('$3.00') && card.includes('4 sizes'), card);
await page.click(`#tiles .tile[data-add="${mango.id}"]`);
await page.waitForSelector('.size-pick .size-btn');
const buttons = await page.$$eval('.size-pick .size-btn', (bs) => bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
check('tapping it asks which size, with every price', buttons.length === 4 && buttons[2].includes('L') && buttons[2].includes('$5.00'), buttons.join(' | '));
check('and nothing is in the cart yet', (await page.$$('.cart-line')).length === 0);
await page.waitForTimeout(400); // let the dialog finish opening
await shot('191-size-pick');
await page.click('.size-pick .size-btn:nth-child(3)');
await page.waitForSelector('.cart-line');
const line = (await page.textContent('.cart-line')).replace(/\s+/g, ' ');
check('choosing L puts Mango L in the cart at the L price', line.includes('Mango') && line.includes('L') && line.includes('$5.00'), line);
check('with the size shown plainly on the line', (await page.textContent('.cart-line .cl-size')).trim() === 'L');

console.log('\n[the same product in another size]');
await page.click(`#tiles .tile[data-add="${mango.id}"]`);
await page.waitForSelector('.size-pick .size-btn');
await page.keyboard.press('1'); // the number keys pick a size too
await wait(async () => (await page.$$('.cart-line')).length === 2, 4000);
const sizesInCart = await page.$$eval('.cart-line .cl-size', (s) => s.map((x) => x.textContent.trim()));
check('Mango S is a second line, not more of the L', sizesInCart.join() === 'S,L', sizesInCart.join());
await page.click(`#tiles .tile[data-add="${mango.id}"]`);
await page.waitForSelector('.size-pick .size-btn');
await page.keyboard.press('3');
await page.waitForTimeout(400);
const qtys = await page.$$eval('.cart-line', (ls) => ls.map((l) => `${l.querySelector('.cl-size').textContent.trim()}×${l.querySelector('[data-field=qty]').value}`));
check('L again adds one to the L line', qtys.join() === 'L×2,S×1', qtys.join());
await page.click(`#tiles .tile[data-add="${mango.id}"]`);
await page.waitForSelector('.size-pick .size-btn');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('closing the picker adds nothing', (await page.$$('.cart-line')).length === 2);

console.log('\n[a product without sizes is as it was]');
const espresso = (await api('/api/products?search=Espresso&limit=5'))[0];
await page.fill('#scan', '');
await page.fill('#scan', espresso.barcode);
await page.keyboard.press('Enter');
await wait(async () => (await page.$$('.cart-line')).length === 3, 4000);
check('scanning it goes straight to the cart, with no question', !(await page.$('.size-pick')) && (await page.$$('.cart-line')).length === 3);
check('and its line has no size', (await page.$$('.cart-line .cl-size')).length === 2);
await shot('192-cart-sizes');

console.log('\n[held and resumed]');
await page.click('#hold-cart');
await page.waitForSelector('#held-chip:not([hidden])');
await page.click('#held-chip');
await page.waitForSelector('.held-table [data-resume]');
await page.click('.held-table [data-resume]');
await wait(async () => (await page.$$('.cart-line')).length === 3, 5000);
const resumed = await page.$$eval('.cart-line .cl-size', (s) => s.map((x) => x.textContent.trim()));
check('holding and resuming keeps every size', resumed.sort().join() === 'L,S', resumed.join());

console.log('\n[paid]');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
const receipt = (await page.textContent('.receipt')).replace(/\s+/g, ' ');
check('the receipt names each size', receipt.includes('Mango · L') && receipt.includes('Mango · S'), receipt.slice(0, 300));
await page.click('.modal-head [data-close]');
const sale = await api('/api/sales?limit=1');
const saved = await api(`/api/sales/${sale[0].id}`);
const L = saved.items.find((i) => i.size === 'L');
check('the sale keeps each size with its price and cost',
  L && L.qty === 2 && Math.abs(L.unit_price - 5) < 0.01 && Math.abs(L.unit_cost - 1.11) < 0.01 &&
  saved.items.some((i) => i.size === 'S' && Math.abs(i.unit_price - 3) < 0.01),
  JSON.stringify(saved.items.map((i) => [i.name, i.size, i.qty, i.unit_price, i.unit_cost])));

/* ------------------------------------------------------------ the Sell form */
console.log('\n[a sale entered by hand]');
await page.goto(`${BASE}#/sales/new`);
await page.waitForSelector('[data-product="0"]');
await page.fill('[data-product="0"]', 'Mango');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item', { timeout: 8000 });
await page.click('.combo-menu .combo-item');
await page.waitForSelector('[data-size="0"]');
check('a product with sizes gets a size choice, on its first size',
  (await page.$eval('[data-size="0"]', (s) => s.selectedOptions[0].textContent)).startsWith('S') &&
  Math.abs(Number(await page.inputValue('[data-price="0"]')) - 3) < 0.01);
await page.selectOption('[data-size="0"]', String(mango.sizes[3].id));
await wait(async () => Math.abs(Number(await page.inputValue('[data-price="0"]')) - 8) < 0.01, 3000);
check('choosing Bottle prices the line as a Bottle', Math.abs(Number(await page.inputValue('[data-price="0"]')) - 8) < 0.01);
await page.click('#save-sale');
await page.waitForTimeout(1200);
const typed = await api(`/api/sales/${(await api('/api/sales?limit=1'))[0].id}`);
check('and the sale keeps the size', typed.items[0].size === 'Bottle' && Math.abs(typed.items[0].unit_price - 8) < 0.01,
  JSON.stringify(typed.items[0]));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
