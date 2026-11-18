/**
 * Attributes, variants, recipes and consumption on screen: switched on in
 * Settings, a shake template with its sizes, a recipe for one of them, sold at
 * the till, and its mango reconciled — and nothing of it shown while off.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'variantsui');
const PORT = 4627;
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0011;

try {
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');

  const someProduct = (await api('/api/products?limit=1'))[0];

  console.log('\n[switched off: nothing of it shows]');
  await page.goto(`${BASE}#/products/${someProduct.id}/details`);
  await page.waitForSelector('#page-form');
  check('a product is not asked about templates or recipes',
    !(await page.$('#page-form [name=has_variants]')) && !(await page.$('#page-form [name=made_to_order]')) && !(await page.$('#page-form [name=raw]')));
  check('its tabs are as they were', (await page.$$eval('#tabs [data-tab]', (b) => b.map((x) => x.dataset.tab).join(','))) === 'details,pricing,overview,movements,sales,purchases');
  check('the menu has no Consumption', !(await page.$('.nav-item[data-route="consumption"]')));
  await page.goto(`${BASE}#/settings/pos`);
  await page.waitForSelector('#pos-form');
  check('both switches are there, and off',
    !(await page.isChecked('#pos-form [name=attributes]')) && !(await page.isChecked('#pos-form [name=recipes]')));
  check('Settings has no Attributes section', !(await page.$('[data-section="attributes"]')));

  console.log('\n[switched on]');
  await page.check('#pos-form [name=attributes]');
  await page.check('#pos-form [name=recipes]');
  await page.click('#pos-form button[type=submit]');
  await page.waitForSelector('[data-section="attributes"]');
  check('the Attributes section appears', true);
  await wait(async () => !!(await page.$('.nav-item[data-route="consumption"]')), 4000);
  check('and Consumption in the menu', !!(await page.$('.nav-item[data-route="consumption"]')));

  await page.click('[data-section="attributes"]');
  await page.waitForSelector('#attr-new');
  await page.click('#attr-new');
  await page.waitForSelector('.modal input[name=name]');
  await page.fill('.modal input[name=name]', 'Size');
  for (const v of ['S', 'L']) {
    await page.fill('.modal .tags-entry', v);
    await page.keyboard.press('Enter');
  }
  await shot('210-attribute-form');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.addon-list[data-attr]');
  const attrs = await api('/api/attributes');
  check('Size is saved with S and L', attrs.length === 1 && attrs[0].values.map((v) => v.name).join() === 'S,L', JSON.stringify(attrs));

  // The ingredient, bought by the kilo.
  const mango = await api('/api/products', 'POST', { name: 'Mango pulp', unit: 'kg', cost: 3, price: 0, opening_stock: 10, raw: true });

  console.log('\n[a template]');
  await page.goto(`${BASE}#/products/new`);
  await page.waitForSelector('#page-form [name=has_variants]');
  await page.fill('#page-form [name=name]', 'Mango shake');
  await page.fill('#page-form [name=price]', '4');
  await page.check('#page-form [name=has_variants]');
  await page.check('#page-form [name=made_to_order]');
  check('a template is not offered as a raw material on its page later, but a new product is asked', !!(await page.$('#page-form [name=raw]')));
  await page.click('#page-form button[type=submit]');
  await page.waitForSelector('#tabs [data-tab="variants"]');
  check('a template has its details and its variants', (await page.$$eval('#tabs [data-tab]', (b) => b.map((x) => x.dataset.tab).join(','))) === 'details,variants');
  await page.click('#tabs [data-tab="variants"]');
  await page.waitForSelector('.attr-chip');
  for (const chip of await page.$$('.attr-chip input')) await chip.check();
  check('ticking S and L says 2 variants will be made', (await page.textContent('#variant-count')).includes('2'));
  await page.click('#generate');
  await page.waitForSelector('#variants-table [data-variant-row]');
  check('they are generated', (await page.$$('#variants-table [data-variant-row]')).length === 2);
  await page.fill('#variants-table [data-variant-price] >> nth=1', '6');
  await page.click('#save-variant-prices');
  await page.waitForTimeout(500);
  const template = (await api('/api/products?search=Mango%20shake&limit=5')).find((p) => p.has_variants === 1);
  const vs = (await api(`/api/products/${template.id}/variants`)).variants;
  check('S at 4, L at 6', vs.map((v) => `${v.label}:${v.price}`).join() === 'S:4,L:6', JSON.stringify(vs.map((v) => [v.label, v.price])));
  await shot('211-variants');

  console.log('\n[a recipe for the large]');
  await page.click('#variants-table [data-open] >> nth=1');
  await page.waitForSelector('#tabs [data-tab="recipe"]');
  check('the variant leads back to its template', (await page.textContent('[data-template]')).includes('Mango shake'));
  await page.click('#tabs [data-tab="recipe"]');
  await page.waitForSelector('#recipe-find');
  await page.fill('#recipe-find', 'Mango pulp');
  await page.waitForSelector('.picker-item, .picker [data-index], .combo .item', { timeout: 5000 }).catch(() => null);
  await page.keyboard.press('ArrowDown').catch(() => null);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-recipe-qty]');
  await page.fill('[data-recipe-qty]', '0.3');
  check('its cost shows as it is typed: 0.90', (await page.textContent('#recipe-cost')).includes('0.90'), await page.textContent('#recipe-cost'));
  await page.click('#save-recipe');
  await page.waitForTimeout(500);
  const large = vs[1];
  const recipe = await api(`/api/products/${large.id}/recipe`);
  check('saved: 0.3 kg of mango pulp', recipe.lines.length === 1 && recipe.lines[0].ingredient.id === mango.id && recipe.lines[0].qty === 0.3, JSON.stringify(recipe));
  await shot('212-recipe');

  console.log('\n[at the till]');
  await page.goto(`${BASE}#/pos`);
  await page.waitForSelector('#tiles .tile');
  await page.fill('#scan', 'Mango');
  await page.waitForSelector(`#tiles .tile[data-add="${template.id}"]:not([hidden])`);
  const shown = await page.$$eval('#tiles .tile:not([hidden])', (ts) => ts.map((x) => Number(x.dataset.add)));
  check('the till shows the template, not its variants, nor the raw mango',
    shown.includes(template.id) && !shown.includes(large.id) && !shown.includes(mango.id), JSON.stringify(shown));
  check('the card says it comes in 2', (await page.textContent(`#tiles .tile[data-add="${template.id}"]`)).includes('2 variants'));
  await page.click(`#tiles .tile[data-add="${template.id}"]`);
  await page.waitForSelector('.size-pick [data-variant]');
  check('tapping it asks which one', (await page.$$('.size-pick [data-variant]')).length === 2);
  await shot('213-variant-pick');
  await page.keyboard.press('2');
  await page.waitForSelector('.cart-line');
  const line = (await page.textContent('.cart-line')).replace(/\s+/g, ' ');
  check('2 picks the large, at its own price', line.includes('Mango shake L') && line.includes('$6.00'), line);
  check('the key did not go on into the search box', (await page.inputValue('#scan')) !== '2');
  check('made to order: never short of stock', await page.$eval('.cart-line [data-stock]', (el) => el.hidden));
  await page.click('#checkout');
  await page.waitForSelector('#pay-confirm');
  await page.click('#pay-confirm');
  await page.waitForSelector('.receipt', { timeout: 8000 });
  await page.click('.modal-head [data-close]');
  check('the shake moved no stock, and the mango not yet', near((await api(`/api/products/${large.id}`)).stock, 0) && near((await api(`/api/products/${mango.id}`)).stock, 10));

  console.log('\n[reconciled]');
  await page.goto(`${BASE}#/consumption`);
  await page.waitForSelector('#con-new');
  await page.click('#con-new');
  await page.waitForSelector('#con-lines [data-counted]');
  const row = '#con-lines tr:has-text("Mango pulp")';
  check('the recipes say 0.3 kg of mango was used', (await page.textContent(`${row} >> td >> nth=3`)).includes('0.3'), await page.textContent(row));
  await page.fill(`${row} [data-counted]`, '9.6');
  check('counting 9.6 kg left makes 0.4 kg used', (await page.inputValue(`${row} [data-actual]`)) === '0.4');
  check('0.1 more than the recipes say', (await page.textContent(`${row} [data-diff]`)).includes('0.1'));
  check('and the line is ticked', await page.isChecked(`${row} [data-on]`));
  await shot('214-consumption');
  await page.click('#con-submit');
  await page.waitForSelector('.modal [data-confirm]');
  await page.click('.modal [data-confirm]');
  await page.waitForSelector('#con-doc');
  check('submitted', (await page.textContent('.card-head h3')).includes('Submitted'));
  check('the mango goes down by what was really used: 9.6 left', near((await api(`/api/products/${mango.id}`)).stock, 9.6));
  await page.goto(`${BASE}#/consumption`);
  await page.waitForSelector('#con-table');
  check('and it is listed', (await page.$$('#con-table [data-open]')).length === 1);

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
  await shot('219-variants-failure').catch(() => null);
}
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
