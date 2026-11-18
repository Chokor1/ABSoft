/** Add-ons as items on screen: an add-on and what it goes with, then a crêpe's toppings from its line at the till. */
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
const seed = spawn('node', ['--no-warnings', 'server/tools/seed-classic.js'], { cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA } });
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
const waffle = await api('/api/products', 'POST', { name: 'Belgian Waffle', category: 'Waffles', cost: 2, price: 10 });
const lineOpen = async (n = 0) => {
  // Tapping the line's name opens it, like a person would.
  await page.click(`.cart-line >> nth=${n} >> .cl-name`);
  await page.waitForSelector(`.cart-line.open >> nth=0`);
};

/* ------------------------------------------------------------ before any add-on */
console.log('\n[before any add-on, nothing changes]');
await page.goto(`${BASE}#/settings/store`);
await page.waitForSelector('#set-nav');
check('Settings has no Add-ons section any more', !(await page.$('[data-section="addons"]')));
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Nutella');
await page.waitForSelector(`#tiles .tile[data-add="${nutella.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
await page.waitForSelector('.cart-line');
check('tapping a product puts it straight in the cart', !(await page.$('.modal')) && (await page.$$('.cart-line')).length === 1);
await lineOpen();
check('and its line offers no add-ons', !(await page.$('.cart-line [data-addons]')));
await page.click('#clear-cart');
await page.waitForTimeout(300);

console.log('\n[switched on in Settings]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form [name=name]');
check('while it is off, an item has no add-on mark', !(await page.$('#page-form [name=is_addon]')));
await page.goto(`${BASE}#/settings/pos`);
await page.waitForSelector('#pos-form [name=addons]');
check('the switch is there, and off', !(await page.isChecked('#pos-form [name=addons]')));
await page.check('#pos-form [name=addons]');
await page.click('#pos-form button[type=submit]');
await wait(async () => (await api('/api/settings')).addons === '1', 4000);

/* ------------------------------------------------------------ an add-on item */
console.log('\n[Lotus Biscuit, an add-on for the crêpes]');
await page.goto(`${BASE}#/products/new`);
await page.waitForSelector('#page-form [name=is_addon]');
await page.fill('#page-form [name=name]', 'Lotus Biscuit');
await page.fill('#page-form [name=price]', '1');
await page.fill('#page-form [name=cost]', '0.25');
await page.check('#page-form [name=is_addon]');
await page.click('#page-form button[type=submit]');
await page.waitForSelector('#tabs [data-tab="addon"]');
check('an add-on has an Offered with tab', true);
await page.click('#tabs [data-tab="addon"]');
await page.waitForSelector('[data-scope="categories"]');
check('it starts offered with every item', (await page.getAttribute('[data-scope="all"]', 'aria-checked')) === 'true');
await page.click('[data-scope="categories"]');
await page.check('[data-cat="Crêpes"]');
await shot('200-offered-with');
await page.click('#save-addon-for');
await page.waitForTimeout(500);
const lotus = (await api('/api/addons')).find((a) => a.name === 'Lotus Biscuit');
check('saved: offered with the Crêpes', lotus.scope === 'categories' && lotus.categories.join() === 'Crêpes', JSON.stringify(lotus));
// Kiwi goes with the waffle alone; Banana with everything.
const kiwi = await api('/api/products', 'POST', { name: 'Kiwi', price: 1, cost: 0.3, is_addon: true });
await api(`/api/products/${kiwi.id}/addon-for`, 'PUT', { scope: 'products', product_ids: [waffle.id] });
await api('/api/products', 'POST', { name: 'Banana', price: 1, cost: 0.3, is_addon: true });

/* ------------------------------------------------------------ the till */
console.log('\n[a crêpe with toppings and a note]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
await page.fill('#scan', 'Lotus');
await page.waitForTimeout(800);
check('an add-on is not a card at the till', !(await page.$(`#tiles .tile[data-add="${lotus.id}"]:not([hidden])`)));
await page.fill('#scan', 'Nutella');
await page.waitForSelector(`#tiles .tile[data-add="${nutella.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${nutella.id}"]`);
await page.waitForSelector('.cart-line');
check('the crêpe goes straight in the cart', !(await page.$('.modal')));
await lineOpen();
await page.waitForSelector('.cart-line [data-addons]');
await page.click('.cart-line [data-addons]');
await page.waitForSelector('.build .build-addon');
const offered = await page.$$eval('.build-addon .build-name', (ns) => ns.map((n) => n.textContent.trim()).sort());
check('its add-ons are the ones that go with it: not the waffle\'s Kiwi', offered.join() === 'Banana,Lotus Biscuit', offered.join());
await page.click('.build-addon:has-text("Lotus Biscuit")');
await page.click('.build-addon:has-text("Banana")');
check('the two add $2', (await page.textContent('#build-total')).includes('$2.00'), await page.textContent('#build-total'));
await shot('202-addons-sheet');
await page.click('#build-add');
await page.waitForTimeout(300);
await page.fill('.cart-line >> nth=0 >> [data-field=note]', 'cut in four');
await page.waitForTimeout(200);
const extras = (await page.textContent('.cart-line [data-extras]')).trim();
check('the line says what was asked for', extras === '+ Banana, Lotus Biscuit · cut in four', extras);
check('at the price with its add-ons', (await page.textContent('.cart-line [data-total]')).includes('$7.00'));
check('and the button counts them', (await page.textContent('.cart-line [data-addons]')).includes('2'));

console.log('\n[taking one off]');
await page.click('.cart-line [data-addons]');
await page.waitForSelector('.build .build-addon');
check('the sheet opens with them ticked', (await page.$$('.build-addon.on')).length === 2);
await page.click('.build-addon:has-text("Banana")');
await page.click('#build-add');
await page.waitForTimeout(300);
check('one less is a dollar less', (await page.textContent('.cart-line [data-total]')).includes('$6.00'));

console.log('\n[the waffle]');
await page.fill('#scan', 'Belgian');
await page.waitForSelector(`#tiles .tile[data-add="${waffle.id}"]:not([hidden])`);
await page.click(`#tiles .tile[data-add="${waffle.id}"]`);
await page.waitForFunction(() => document.querySelectorAll('.cart-line').length === 2);
await lineOpen(0);
await page.click('.cart-line >> nth=0 >> [data-addons]');
await page.waitForSelector('.build .build-addon');
const forWaffle = await page.$$eval('.build-addon .build-name', (ns) => ns.map((n) => n.textContent.trim()).sort());
check('the waffle offers Kiwi and Banana, not the crêpes\' Lotus', forWaffle.join() === 'Banana,Kiwi', forWaffle.join());
await page.click('.build-addon:has-text("Kiwi")');
await page.click('#build-add');
await page.waitForTimeout(300);

console.log('\n[held and resumed]');
await page.click('#hold-cart');
await page.waitForSelector('#held-chip:not([hidden])');
await page.click('#held-chip');
await page.waitForSelector('.held-table [data-resume]');
await page.click('.held-table [data-resume]');
await wait(async () => (await page.$$('.cart-line')).length === 2, 5000);
const back = await page.$$eval('.cart-line [data-extras]', (es) => es.map((e) => e.textContent.trim()).filter(Boolean).sort());
check('holding and resuming keeps every add-on and note', back.join(' | ') === ['+ Kiwi', '+ Lotus Biscuit · cut in four'].sort().join(' | '), back.join(' | '));
await lineOpen(0);
check('and the lines still offer their add-ons', !!(await page.$('.cart-line.open [data-addons]')));

console.log('\n[paid]');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
const receipt = (await page.textContent('.receipt')).replace(/\s+/g, ' ');
check('the receipt lists the add-ons and notes', receipt.includes('+ Lotus Biscuit · cut in four') && receipt.includes('+ Kiwi'), receipt.slice(0, 400));
await page.click('.modal-head [data-close]');
const sale = await api(`/api/sales/${(await api('/api/sales?limit=1'))[0].id}`);
const crepe = sale.items.find((i) => i.note === 'cut in four');
check('the sale keeps them, with the add-ons in the price', crepe && Math.abs(crepe.unit_price - 6) < 0.01 && JSON.parse(crepe.addons).length === 1,
  JSON.stringify(sale.items.map((i) => [i.name, i.addons, i.note, i.unit_price])));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
