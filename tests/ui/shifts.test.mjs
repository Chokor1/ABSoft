/** Settings in sections; shifts at the till; searching from fewer letters. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'shiftuidata');
const PORT = 4567;
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
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ settings */
console.log('\n[settings, one section at a time]');
await page.goto(`${BASE}#/settings`);
await page.waitForSelector('.set-nav');
const sections = await page.$$eval('.set-nav-item', (as) => as.map((a) => a.dataset.section));
check('the sections are listed down the side', sections.join() === 'store,pos,search,currency,language,backup,about', sections.join());
check('the first section opens by default', !!(await page.$('#settings-form')) && !(await page.$('#pos-form')));
await page.click('.set-nav-item[data-section=pos]');
await page.waitForSelector('#pos-form');
check('a section has its own address', page.url().endsWith('#/settings/pos'), page.url());
check('shifts start switched off', !(await page.isChecked('#pos-form input[name=pos_shifts]')));
check('no Shifts in the menu while they are off', !(await page.$('.nav-item[data-route=shifts]')));
await shot('130-settings-pos');

/* ------------------------------------------------------------ search */
console.log('\n[a small shop searches from the first letter]');
await page.click('.set-nav-item[data-section=search]');
await page.waitForSelector('#search-form');
await page.selectOption('#search-form select[name=search_min_chars]', '1');
await page.click('#search-form button[type=submit]');
await wait(async () => (await page.evaluate(async () => (await fetch('/api/settings')).json())).search_min_chars === '1', 4000);
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
const placeholder = await page.getAttribute('#scan', 'placeholder');
check('the till no longer asks for 3 letters', !placeholder.includes('3'), placeholder);
const before = await page.$$eval('.tile', (t) => t.length);
await page.fill('#scan', 'e');
await page.waitForTimeout(700);
check('one letter already searches every product', !(await page.$('.type-more')) && (await page.$$eval('.tile', (t) => t.length)) > 0,
  `${before} → ${await page.$$eval('.tile', (t) => t.length)}`);
await page.fill('#scan', '');

/* ------------------------------------------------------------ shifts on */
console.log('\n[switching shifts on]');
await page.goto(`${BASE}#/settings/pos`);
await page.waitForSelector('#pos-form');
await page.check('#pos-form input[name=pos_shifts]');
await page.click('#pos-form button[type=submit]');
await page.waitForSelector('.nav-item[data-route=shifts]', { state: 'attached', timeout: 4000 });
check('Shifts appears in the menu once switched on', !!(await page.$('.nav-item[data-route=shifts]')));

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#shift-gate:not([hidden])');
check('with no shift open, the till asks to open one', await page.isVisible('#shift-open-form'));
check('and there is no shift chip yet', await page.$eval('#shift-chip', (el) => el.hidden));
await shot('131-shift-gate');
await page.fill('#opening-cash', '100');
await page.fill('#opening-note', 'Morning');
await page.click('#shift-open');
await page.waitForSelector('#shift-gate', { state: 'hidden' });
const chip = await page.textContent('#shift-chip');
check('the open shift shows in the search bar', chip.includes('SH-000001'), chip);

console.log('\n[selling inside the shift]');
await page.fill('#scan', '5901234123457'); // Espresso Beans, 18.00
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
await page.click('.modal-head [data-close]');
const sale = (await page.evaluate(async () => (await fetch('/api/sales?limit=1')).json()))[0];
check('the sale belongs to the shift', !!sale.shift_id, JSON.stringify(sale.shift_id));

console.log('\n[closing]');
await page.click('#shift-chip');
await page.waitForSelector('#counted-cash');
const expected = await page.inputValue('#counted-cash');
check('the count starts at what the drawer should hold', Math.abs(Number(expected) - 118) < 0.01, expected);
check('which balances', (await page.textContent('#shift-diff')).length > 0 && (await page.getAttribute('#shift-diff', 'class')).includes('settled'));
await page.fill('#counted-cash', '115');
check('counting less shows the drawer short', (await page.getAttribute('#shift-diff', 'class')).includes('owing'));
await shot('132-shift-close');
await page.click('#shift-close');
await page.waitForSelector('#shift-gate:not([hidden])');
check('once closed, the till asks for the next shift', await page.isVisible('#shift-open-form'));

console.log('\n[history]');
await page.click('#shift-history');
await page.waitForSelector('#shift-table');
const rows = await page.$$eval('#shift-table tbody tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ')));
check('the closed shift is in the history', rows.length === 1 && rows[0].includes('SH-000001'), rows.join(' | '));
await page.click('#shift-table tbody tr');
await page.waitForSelector('.doc-head');
const doc = (await page.textContent('#page')).replace(/\s+/g, ' ');
check('a shift opens with its count and its sales', doc.includes('SH-000001') && doc.includes('115') && doc.includes(sale.doc_no), doc.slice(0, 300));
await shot('133-shift-doc');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
