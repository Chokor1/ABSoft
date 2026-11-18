/** Add-ons and notes on screen: a list in Settings, a crêpe's toppings at the till. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'addonsui');
const PORT = 4621;
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
const api = (path, method = 'GET', body) =>
  page.evaluate(async ({ path, method, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  }, { path, method, body });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

const nutella = await api('/api/products', 'POST', { name: 'Nutella Crêpe', category: 'Crêpes', cost: 1.5, price: 5 });
const lotusCrepe = await api('/api/products', 'POST', { name: 'Lotus Crêpe', category: 'Crêpes', cost: 1.5, price: 5 });
const waffle = await api('/api/products', 'POST', { name: 'Belgian Waffle L', category: 'Waffles', cost: 2, price: 10 });

/* ------------------------------------------------------------ before any list */
console.log('\n[before any list, nothing changes]');
await page.goto(`${BASE}#/products/${nutella.id}/details`);
await page.waitForSelector('#page-form');
check('a product is not asked about add-ons', !(await page.$('#page-form [name=addon_group_id]')));
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Nutella');
await page.waitForSelector(`#tiles .tile[data-add="${nutella.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
await page.waitForSelector('.cart-line');
check('and goes straight into the cart', !(await page.$('.build')) && (await page.$$('.cart-line')).length === 1);
await page.click('#clear-cart');
await page.waitForTimeout(300);

/* ------------------------------------------------------------ Settings → Add-ons */
console.log('\n[a list of toppings]');
await page.goto(`${BASE}#/settings/addons`);
await page.waitForSelector('#addon-new');
check('the section starts empty', (await page.textContent('#addon-groups')).includes('No add-on lists yet'));
await page.click('#addon-new');
await page.waitForSelector('.modal input[name=name]');
await page.fill('.modal input[name=name]', 'Crêpe toppings');
for (const [name, price, cost] of [['Lotus Biscuit', '1', '0.25'], ['Banana', '1', ''], ['Kiwi', '1', '']]) {
  await page.click('.modal [data-add-size]');
  const row = '.modal [data-size-row]:last-child';
  await page.fill(`${row} [data-size-name]`, name);
  await page.fill(`${row} [data-size-price]`, price);
  if (cost) await page.fill(`${row} [data-size-cost]`, cost);
}
await shot('200-addon-list-form');
await page.click('.modal button[type=submit]');
await page.waitForSelector('.addon-list');
const groups = await api('/api/addon-groups');
check('the list is saved with its toppings', groups.length === 1 && groups[0].items.map((a) => a.name).join() === 'Lotus Biscuit,Banana,Kiwi',
  JSON.stringify(groups));

await page.selectOption('.addon-list [data-category]', 'Crêpes');
await page.click('.addon-list [data-apply]');
await wait(async () => (await api('/api/addon-groups'))[0].products === 2, 5000);
check('offered on the whole Crêpes category in one go', (await api(`/api/products/${lotusCrepe.id}`)).addon_group_id === groups[0].id);
await api(`/api/products/${waffle.id}`, 'PUT', { addon_group_id: groups[0].id });
await page.reload();
await page.waitForSelector('.addon-list');
await shot('201-addon-settings');

console.log('\n[the product says which list it offers]');
await page.goto(`${BASE}#/products/${nutella.id}/details`);
await page.waitForSelector('#page-form [name=addon_group_id]');
check('the product form shows the list it offers',
  (await page.inputValue('#page-form [name=addon_group_id]')) === String(groups[0].id));

/* ------------------------------------------------------------ the till */
console.log('\n[a crêpe with toppings and a note]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Nutella');
await page.waitForSelector(`#tiles .tile[data-add="${nutella.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
await page.waitForSelector('.build .build-addon');
const offered = await page.$$eval('.build-addon .build-name', (ns) => ns.map((n) => n.textContent.trim()));
check('tapping it opens its toppings', offered.join() === 'Lotus Biscuit,Banana,Kiwi', offered.join());
check('the Add button starts at the crêpe\'s price', (await page.textContent('#build-total')).includes('$5.00'));
await page.click('.build-addon[data-addon] >> nth=0');
await page.click('.build-addon[data-addon] >> nth=1');
await page.fill('#build-note', 'cut in four');
check('ticking two toppings adds them to the price', (await page.textContent('#build-total')).includes('$7.00'),
  await page.textContent('#build-total'));
await page.waitForTimeout(300);
await shot('202-build-sheet');
await page.click('#build-add');
await page.waitForSelector('.cart-line');
const extras = (await page.textContent('.cart-line [data-extras]')).trim();
check('the line says what was asked for', extras === '+ Lotus Biscuit, Banana · cut in four', extras);
check('at the price with its toppings', (await page.textContent('.cart-line [data-total]')).includes('$7.00'));

console.log('\n[the same again, and a different one]');
for (const ticks of [[0, 1], [2]]) {
  await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
  await page.waitForSelector('.build .build-addon');
  for (const n of ticks) await page.click(`.build-addon[data-addon] >> nth=${n}`);
  if (ticks.length === 2) await page.fill('#build-note', 'cut in four');
  await page.click('#build-add');
  await page.waitForTimeout(400);
}
const cart = await page.$$eval('.cart-line', (ls) => ls.map((l) => `${l.querySelector('[data-field=qty]').value}:${l.querySelector('[data-extras]').textContent.trim()}`));
check('the same toppings and note add one to that line', cart.some((c) => c === '2:+ Lotus Biscuit, Banana · cut in four'), cart.join(' | '));
check('different toppings are a line of their own', cart.some((c) => c === '1:+ Kiwi'), cart.join(' | '));

console.log('\n[a waffle with toppings]');
await page.fill('#scan', 'Belgian');
await page.waitForSelector(`#tiles .tile[data-add="${waffle.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${waffle.id}"]`);
await page.waitForSelector('.build .build-addon');
await page.click('.build-addon[data-addon] >> nth=2');
check('its price and the topping make the line', (await page.textContent('#build-total')).includes('$11.00'), await page.textContent('#build-total'));
await page.click('#build-add');
await page.waitForTimeout(400);
const wLine = (await page.textContent('.cart-line')).replace(/\s+/g, ' ');
check('the waffle line has its topping', wLine.includes('Belgian Waffle L') && wLine.includes('+ Kiwi') && wLine.includes('$11.00'), wLine);

console.log('\n[a note on any line]');
const espresso = (await api('/api/products?search=Espresso&limit=5'))[0];
await page.fill('#scan', espresso.barcode);
await page.keyboard.press('Enter');
await wait(async () => (await page.$$('.cart-line')).length === 4, 4000);
await page.click('.cart-line >> nth=0 >> [data-toggle]');
await page.fill('.cart-line >> nth=0 >> [data-field=note]', 'grind fine');
await page.waitForTimeout(200);
check('a plain line takes a note too', (await page.textContent('.cart-line >> nth=0 >> [data-extras]')).trim() === 'grind fine');
await page.click('.cart-line >> nth=0 >> [data-step="1"]');
await page.waitForTimeout(200);
check('and stays the same line', (await page.$$('.cart-line')).length === 4 &&
  (await page.inputValue('.cart-line >> nth=0 >> [data-field=qty]')) === '2');
await shot('203-cart-extras');

console.log('\n[held and resumed]');
await page.click('#hold-cart');
await page.waitForSelector('#held-chip:not([hidden])');
await page.click('#held-chip');
await page.waitForSelector('.held-table [data-resume]');
await page.click('.held-table [data-resume]');
await wait(async () => (await page.$$('.cart-line')).length === 4, 5000);
const back = await page.$$eval('.cart-line [data-extras]', (es) => es.map((e) => e.textContent.trim()).filter(Boolean).sort());
check('holding and resuming keeps every topping and note',
  back.join(' | ') === ['+ Kiwi', '+ Kiwi', '+ Lotus Biscuit, Banana · cut in four', 'grind fine'].sort().join(' | '), back.join(' | '));

console.log('\n[paid]');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
const receipt = (await page.textContent('.receipt')).replace(/\s+/g, ' ');
check('the receipt lists the toppings and notes', receipt.includes('+ Lotus Biscuit, Banana · cut in four') && receipt.includes('grind fine'),
  receipt.slice(0, 400));
await page.click('.modal-head [data-close]');
const sale = await api(`/api/sales/${(await api('/api/sales?limit=1'))[0].id}`);
const crepe = sale.items.find((i) => i.note === 'cut in four');
check('the sale keeps them, with the toppings in the price',
  crepe && crepe.qty === 2 && Math.abs(crepe.unit_price - 7) < 0.01 && JSON.parse(crepe.addons).length === 2,
  JSON.stringify(sale.items.map((i) => [i.name, i.size, i.addons, i.note, i.unit_price])));

console.log('\n[a list taken away]');
await api(`/api/addon-groups/${groups[0].id}`, 'DELETE');
await page.reload(); // a till opened afresh reads the lists as they are now
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Nutella');
await page.waitForSelector(`#tiles .tile[data-add="${nutella.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
await page.waitForSelector('.cart-line');
check('the crêpe goes straight into the cart again', !(await page.$('.build')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
