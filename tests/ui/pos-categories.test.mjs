/** Categories at the till: off by default, a row of them when switched on. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'poscats');
const PORT = 4607;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
// A press where the chip is, as a finger or a mouse would: Playwright's own
// click scrolls its target first, which a person's tap never does.
const tap = async (sel) => {
  const box = await page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
};
const tileIds = () => page.$$eval('#tiles .tile:not([hidden])', (ts) => ts.map((t) => Number(t.dataset.add)));

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ off: as before */
console.log('\n[off, the till is as it was]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
check('no row of categories', !(await page.$('#cat-bar')));
check('and the layout is the usual one', !(await page.$eval('.pos', (el) => el.classList.contains('with-cats'))));
const before = (await tileIds()).length;
check('the best sellers fill the cards as before', before > 0, String(before));

/* ------------------------------------------------------------ switching it on */
console.log('\n[switched on in Settings → POS]');
await page.goto(`${BASE}#/settings/pos`);
await page.waitForSelector('#pos-form');
check('the setting is there, and off', !(await page.isChecked('#pos-form input[name=pos_categories]')));
await page.check('#pos-form input[name=pos_categories]');
await page.click('#pos-form button[type=submit]');
await wait(async () => (await api('/api/settings')).pos_categories === '1', 5000);
check('and it is saved', (await api('/api/settings')).pos_categories === '1');

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#cat-bar .cat-chip');
await page.waitForSelector('#tiles .tile');
const chips = await page.$$eval('#cat-bar .cat-chip', (cs) => cs.map((c) => ({ cat: c.dataset.cat, text: c.textContent.replace(/\s+/g, ' ').trim(), on: c.classList.contains('active') })));
const inUse = await api('/api/categories/in-use');
check('a row of categories appears, All first and chosen', chips[0].cat === '' && chips[0].on && chips[0].text.startsWith('All'), JSON.stringify(chips[0]));
check('then every category that has products, with how many',
  chips.length === inUse.length + 1 && inUse.every((c, i) => chips[i + 1].cat === c.name && chips[i + 1].text.includes(String(c.n))),
  `${chips.length - 1} chips / ${inUse.length} categories`);
check('there are several to choose from', inUse.length >= 3, String(inUse.length));
await shot('180-pos-categories');

/* ------------------------------------------------------------ picking one */
console.log('\n[picking a category]');
const pick = inUse.find((c) => c.n >= 2) || inUse[0];
await tap(`#cat-bar .cat-chip[data-cat="${pick.name}"]`);
await wait(async () => {
  const ids = await tileIds();
  return ids.length > 0 && ids.length <= pick.n;
}, 6000);
const inside = new Set((await api(`/api/products?category=${encodeURIComponent(pick.name)}&limit=200`)).map((p) => p.id));
const shown = await tileIds();
check('only that category\'s products are on the cards', shown.length > 0 && shown.every((id) => inside.has(id)),
  `${shown.length} shown, ${shown.filter((id) => !inside.has(id)).length} from elsewhere`);
check('and all of them', shown.length === Math.min(pick.n, 40), `${shown.length} of ${pick.n}`);
check('the chip shows it is chosen', await page.$eval(`#cat-bar .cat-chip[data-cat="${pick.name}"]`, (c) => c.classList.contains('active') && c.getAttribute('aria-selected') === 'true'));
check('and All no longer is', !(await page.$eval('#cat-bar .cat-chip[data-cat=""]', (c) => c.classList.contains('active'))));
const allSeen = await page.$eval('#cat-bar', (bar) => {
  const all = bar.querySelector('.cat-chip[data-cat=""]').getBoundingClientRect();
  const box = bar.getBoundingClientRect();
  return { ok: all.left >= box.left - 1 && all.right <= box.right + 1, all: [Math.round(all.left), Math.round(all.right)],
           bar: [Math.round(box.left), Math.round(box.right)], scrollLeft: bar.scrollLeft, first: bar.firstElementChild.dataset.cat };
});
check('All is still in view, to go back with one tap', allSeen.ok, JSON.stringify(allSeen));
await page.waitForTimeout(300);
await shot('181-pos-category-picked');

console.log('\n[searching inside it]');
const sample = (await api(`/api/products?category=${encodeURIComponent(pick.name)}&limit=200`))[0];
const word = sample.name.split(' ')[0].slice(0, 4);
await page.fill('#scan', word);
await page.waitForTimeout(900);
const searched = await tileIds();
check('a search stays inside the chosen category', searched.length > 0 && searched.every((id) => inside.has(id)),
  `${searched.length} shown for "${word}"`);
await page.fill('#scan', '');
await page.waitForTimeout(700);

console.log('\n[a scan still finds anything]');
const elsewhere = (await api('/api/products?limit=200')).find((p) => p.barcode && p.category && p.category.toLowerCase() !== pick.name.toLowerCase());
await page.fill('#scan', elsewhere.barcode);
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line', { timeout: 6000 });
check('a product from another category still rings up when scanned',
  (await page.textContent('.cart')).includes(elsewhere.name), elsewhere.name);
await page.click('#clear-cart');
await page.waitForTimeout(300);

console.log('\n[back to everything]');
await tap('#cat-bar .cat-chip[data-cat=""]');
await wait(async () => (await tileIds()).some((id) => !inside.has(id)), 6000);
check('All brings every category back', (await tileIds()).some((id) => !inside.has(id)));

/* ------------------------------------------------------------ off again */
console.log('\n[switched off again]');
await page.goto(`${BASE}#/settings/pos`);
await page.waitForSelector('#pos-form');
await page.uncheck('#pos-form input[name=pos_categories]');
await page.click('#pos-form button[type=submit]');
await wait(async () => (await api('/api/settings')).pos_categories === '0', 5000);
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#tiles .tile');
check('the row is gone and the till is as before',
  !(await page.$('#cat-bar')) && !(await page.$eval('.pos', (el) => el.classList.contains('with-cats'))));

console.log('\n[a cashier can use it]');
await page.evaluate(async () => {
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pos_categories: '1' }) });
  await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'till9', password: 'pass9', role: 'cashier' }) });
});
const cashier = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await cashier.goto(BASE);
await cashier.waitForSelector('#login-form');
await cashier.fill('input[name=username]', 'till9');
await cashier.fill('input[name=password]', 'pass9');
await cashier.click('button[type=submit]');
await cashier.waitForSelector('.shell');
await cashier.goto(`${BASE}#/pos`);
await cashier.waitForSelector('#cat-bar .cat-chip', { timeout: 8000 });
check('a cashier sees the categories too', (await cashier.$$('#cat-bar .cat-chip')).length === inUse.length + 1);
await cashier.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
