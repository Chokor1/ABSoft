/**
 * Restaurant mode on screen: tables set up in Settings, an order sent to a table,
 * opened again and added to, then paid from the floor — and no trace of tables
 * while it is off.
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
const DATA = resolve(WORK, 'tablesui');
const PORT = 4631;
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
const lines = () => page.$$eval('.cart-line', (ls) => ls.length);

try {
  await page.goto(BASE);
  await page.waitForSelector('#login-form');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell');

  console.log('\n[switched off: no tables anywhere]');
  await page.goto(`${BASE}#/pos`);
  await page.waitForSelector('#tiles .tile');
  check('the till has no Tables button, and no Table beside Make payment', !(await page.$('#open-tables')) && !(await page.$('#to-table')));
  await page.goto(`${BASE}#/settings/pos`);
  await page.waitForSelector('#pos-form');
  check('Restaurant mode is there, and off', !(await page.isChecked('#pos-form [name=restaurant]')));
  check('Settings has no Tables section', !(await page.$('[data-section="tables"]')));

  console.log('\n[setting up the tables]');
  await page.check('#pos-form [name=restaurant]');
  await page.click('#pos-form button[type=submit]');
  await page.waitForSelector('[data-section="tables"]');
  await page.click('[data-section="tables"]');
  await page.waitForSelector('#tables-many');
  await page.click('#tables-many');
  await page.waitForSelector('.modal input[name=count]');
  await page.fill('.modal input[name=count]', '4');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('#tables-table [data-table-row]');
  check('four tables, all free', (await page.$$('#tables-table [data-table-row]')).length === 4
    && (await page.textContent('#tables-table')).includes('Table 4'));

  console.log('\n[an order sent to Table 1]');
  await page.goto(`${BASE}#/pos`);
  await page.waitForSelector('#open-tables');
  check('the till has its Tables button and Table beside Make payment', !!(await page.$('#to-table')));
  await page.click('#tiles .tile >> nth=0');
  await page.click('#tiles .tile >> nth=1');
  await wait(async () => (await lines()) === 2, 4000);
  await page.click('#to-table');
  await page.waitForSelector('.table-floor [data-table]');
  check('the floor shows every table free', (await page.$$('.table-card.free')).length === 4);
  await shot('230-send-to-table');
  await page.click('.table-card >> nth=0');
  await wait(async () => (await lines()) === 0, 4000);
  check('the cart is sent and the till is free', (await lines()) === 0);
  await wait(async () => !(await page.$eval('#tables-open', (el) => el.hidden)), 4000);
  check('one table open', (await page.textContent('#tables-open')).trim() === '1');
  const t1 = (await api('/api/tables')).find((tb) => tb.name === 'Table 1');
  check('Table 1 holds the two lines', t1.status === 'open' && t1.order.lines === 2, JSON.stringify(t1));

  console.log('\n[opened again, and added to]');
  await page.click('#open-tables');
  await page.waitForSelector('.table-card.open [data-act="open"]');
  await shot('231-floor');
  await page.click('.table-card.open [data-act="open"]');
  await wait(async () => (await lines()) === 2, 4000);
  check('its order comes into the cart', (await lines()) === 2);
  check('the cart says which table', (await page.textContent('#table-chip')).includes('Table 1'));
  check('and the button saves to it', (await page.textContent('#to-table')).includes('Save to Table 1'));
  check('a table\'s order is not held', await page.isDisabled('#hold-cart'));
  await page.click('#tiles .tile >> nth=2');
  await wait(async () => (await lines()) === 3, 4000);
  await page.click('#to-table');
  await wait(async () => (await lines()) === 0, 4000);
  const again = (await api('/api/tables')).find((tb) => tb.name === 'Table 1');
  check('saved straight back: 3 lines, no table to choose', again.order.lines === 3 && !(await page.$('.table-floor')), JSON.stringify(again.order));

  console.log('\n[paid from the floor]');
  await page.click('#open-tables');
  await page.waitForSelector('.table-card.open [data-act="pay"]');
  await page.click('.table-card.open [data-act="pay"]');
  await page.waitForSelector('#pay-confirm');
  await page.click('#pay-confirm');
  await page.waitForSelector('.receipt', { timeout: 8000 });
  check('the receipt says Table 1', (await page.textContent('.modal-head')).includes('Table 1'), await page.textContent('.modal-head'));
  await page.click('.modal-head [data-close]');
  await wait(async () => await page.$eval('#tables-open', (el) => el.hidden), 4000);
  check('the table is free again', (await api('/api/tables')).every((tb) => tb.status === 'free'));
  check('and the badge is gone', await page.$eval('#tables-open', (el) => el.hidden));

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
  await shot('239-tables-failure').catch(() => null);
}
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
