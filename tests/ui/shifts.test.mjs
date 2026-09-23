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
// Count print requests instead of opening a print dialog.
await page.addInitScript(() => {
  window.__prints = 0;
  window.print = () => { window.__prints++; };
});

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* ------------------------------------------------------------ settings */
console.log('\n[settings, one section at a time]');
await page.goto(`${BASE}#/settings`);
await page.waitForSelector('#set-nav');
check('the sections sit in the page header', !!(await page.$('.page-head #set-nav')));
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
console.log('\n[searching from the first letter, the default]');
await page.click('.set-nav-item[data-section=search]');
await page.waitForSelector('#search-form');
check('search starts from 1 letter by default', (await page.inputValue('#search-form select[name=search_min_chars]')) === '1');
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
// A second sale paid by card, to count at the close as well.
await page.fill('#scan', '5901234123457');
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-method [data-method=card]');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
await page.click('.modal-head [data-close]');

console.log('\n[closing]');
await page.click('#shift-chip');
await page.waitForSelector('#counted-cash');
const expected = await page.inputValue('#counted-cash');
check('the count starts at what the drawer should hold', Math.abs(Number(expected) - 118) < 0.01, expected);
check('which balances', (await page.textContent('#shift-diff')).length > 0 && (await page.getAttribute('#shift-diff', 'class')).includes('settled'));
const lines = await page.$$eval('.sct-row', (rows) => rows.map((r) => r.dataset.line));
check('card is counted beside the cash', lines.join() === 'cash,card', lines.join());
check('expecting the card sale', Math.abs(Number(await page.inputValue('[data-count=card]')) - 18) < 0.01);
await page.fill('#counted-cash', '115');
check('counting less shows the drawer short', (await page.getAttribute('#shift-diff', 'class')).includes('owing'));
check('and the cash line shows by how much', (await page.textContent('[data-diff=cash]')).includes('3.00'));
await page.waitForTimeout(700);
await shot('132-shift-close');
await page.click('#shift-close');
await page.waitForSelector('.shift-done');
await page.waitForTimeout(1200);
const done = (await page.textContent('.shift-done')).replace(/\s+/g, ' ');
check('closing shows the shift closed, with each method', done.includes('SH-000001') && done.includes('Card') && done.includes('Short'), done);
check('and asks whether to print', done.includes('Print the shift report?'));
await shot('134-shift-closed');
await page.click('.shift-done [data-print]');
await page.waitForSelector('#shift-report');
await page.waitForTimeout(400);
const report = (await page.textContent('#shift-report')).replace(/\s+/g, ' ');
check('Print opens the shift report and prints it', (await page.evaluate(() => window.__prints)) === 1 &&
  report.includes('Shift report SH-000001') && report.includes('Card') && report.includes('Total difference'), report);
await shot('135-shift-report');
await page.click('.modal-head [data-close]');
await page.waitForSelector('#shift-gate:not([hidden])');
check('once closed, the till asks for the next shift', await page.isVisible('#shift-open-form'));

/* --------------------------------------------- a shift that took two currencies */
console.log('\n[counting two currencies, method by method]');
await page.goto(`${BASE}#/settings/currency`);
await page.waitForSelector('#currency2-form');
await page.check('#currency2-form input[name=currency2_enabled]');
await page.fill('#currency2-form input[name=currency2_rate]', '89500');
await page.click('#currency2-form button[type=submit]');
await wait(async () => (await page.evaluate(async () => (await fetch('/api/settings')).json())).currency2_enabled === '1', 5000);

await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#shift-gate:not([hidden])');
await page.fill('#opening-cash', '50');
await page.fill('#opening-cash2', '1000000');
await page.click('#shift-open');
await page.waitForSelector('#shift-gate', { state: 'hidden' });

// One sale paid in L.L on the card, one in dollars in cash.
await page.fill('#scan', '5901234123457');   // 18.00
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-method [data-method=card]');
await page.fill('#pay-amount2', '1611000');   // 18.00 in L.L
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
await page.click('.modal-head [data-close]');
await page.fill('#scan', '5901234123457');
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
await page.click('.modal-head [data-close]');

await page.click('#shift-chip');
await page.waitForSelector('#counted-cash');
const rows2 = await page.$$eval('.sct-row', (rs) => rs.map((r) => r.dataset.line));
check('cash and the card are each counted in both currencies', rows2.join() === 'cash,cash2,card~2', rows2.join());
check('the drawer expects the dollars it took', Math.abs(Number(await page.inputValue('#counted-cash')) - 68) < 0.01,
  await page.inputValue('#counted-cash'));
check('and the L.L it started with', Math.abs(Number(await page.inputValue('#counted-cash2')) - 1000000) < 1,
  await page.inputValue('#counted-cash2'));
check('the card row expects L.L, not dollars', Math.abs(Number(await page.inputValue('[data-count="card~2"]')) - 1611000) < 1,
  await page.inputValue('[data-count="card~2"]'));
check('and says which money it is counted in', (await page.textContent('.sct-row[data-line="card~2"] .sct-cur')).includes('L.L'));
await page.fill('[data-count="card~2"]', '1600000');
const banner = (await page.textContent('#shift-diff')).replace(/\s+/g, ' ');
check('a shortfall in L.L is said in L.L, not turned into dollars', banner.includes('11,000') && !banner.includes('$'), banner);
await page.waitForTimeout(600);
await shot('136-shift-close-two-currencies');
await page.click('#shift-close');
await page.waitForSelector('.shift-done');
await page.waitForTimeout(1300);
const done2 = (await page.textContent('.shift-done')).replace(/\s+/g, ' ');
check('the closing card shows each method in the money it took', done2.includes('1,600,000') && done2.includes('Short'), done2);
await shot('137-shift-closed-two-currencies');
await page.click('.shift-done [data-print]');
await page.waitForSelector('#shift-report');
const report2 = (await page.textContent('#shift-report')).replace(/\s+/g, ' ');
check('so does the report', report2.includes('1,600,000') && report2.includes('11,000'), report2.slice(0, 400));
await page.click('.modal-head [data-close]');
await page.goto(`${BASE}#/settings/currency`);
await page.waitForSelector('#currency2-form');
await page.uncheck('#currency2-form input[name=currency2_enabled]');
await page.click('#currency2-form button[type=submit]');
await wait(async () => (await page.evaluate(async () => (await fetch('/api/settings')).json())).currency2_enabled === '0', 5000);

console.log('\n[history]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('#shift-gate:not([hidden])');
await page.click('#shift-history');
await page.waitForSelector('#shift-table');
const rows = await page.$$eval('#shift-table tbody tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ')));
check('every closed shift is in the history, newest first',
  rows.length === 2 && rows[0].includes('SH-000002') && rows[1].includes('SH-000001'), rows.join(' | '));
await page.click('#shift-table tbody tr:last-child');
await page.waitForSelector('.doc-head');
const doc = (await page.textContent('#page')).replace(/\s+/g, ' ');
check('a shift opens with its count and its sales', doc.includes('SH-000001') && doc.includes('115') && doc.includes(sale.doc_no), doc.slice(0, 300));
await shot('133-shift-doc');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
