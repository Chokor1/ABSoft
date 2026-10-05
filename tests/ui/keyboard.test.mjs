/** A whole sale with the keyboard alone, focus you can always see, and names a screen reader can say. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'keyboarddata');
const PORT = 4541;
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
const shot = (n) => page.screenshot({ path: `${SHOTS}\\${n}.png` });
const key = (k) => page.keyboard.press(k);
const active = () => page.evaluate(() => {
  const el = document.activeElement;
  return { tag: el?.tagName, id: el?.id, cls: el?.className || '', inModal: !!el?.closest('.modal'), isModal: el?.classList?.contains('modal') };
});
// What a screen reader would call each icon-only button on screen: its aria-label, else its title.
const unnamedButtons = () => page.evaluate(() => [...document.querySelectorAll('button')]
  .filter((b) => b.offsetParent !== null && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'))
  .map((b) => b.id || b.className));

/* ------------------------------------------------------------- sign in */
console.log('\n[Sign in and open the till]');
await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.focus('input[name=username]');
await page.keyboard.type('admin');
await key('Tab');
await page.keyboard.type('admin');
await key('Enter');
await page.waitForSelector('.shell');
check('signed in with the keyboard', true);
check('the menu button and the rest of the shell have names', (await unnamedButtons()).length === 0, JSON.stringify(await unnamedButtons()));
check('toasts are announced', (await page.getAttribute('#toasts', 'aria-live')) === 'polite');

await key('F2');
await page.waitForSelector('.tile');
await page.waitForTimeout(500);
check('F2 opens the till with the cursor in the search box', (await active()).id === 'scan', JSON.stringify(await active()));
check('every icon-only button on the till has a name', (await unnamedButtons()).length === 0, JSON.stringify(await unnamedButtons()));
check('the total is announced as it changes', (await page.getAttribute('#totals', 'aria-live')) === 'polite' &&
  (await page.getAttribute('#totals', 'aria-atomic')) === 'true');
check('Make payment says F9', (await page.getAttribute('#checkout', 'aria-keyshortcuts')).startsWith('F9') &&
  (await page.textContent('#checkout')).includes('F9'));

await key('F9');
await page.waitForTimeout(300);
check('F9 with an empty cart does nothing', (await page.$$('.modal-backdrop')).length === 0);

/* ---------------------------------------------------------- the sale */
console.log('\n[Scan, pay, receipt]');
await page.keyboard.type('5449000000996');
await key('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('7622210992796');
await key('Enter');
await page.waitForTimeout(500);
check('two scans, two lines', (await page.$$('#cart-lines .cart-line, #cart-lines [data-line]')).length === 2 ||
  (await page.textContent('#cart-count')).startsWith('2'), await page.textContent('#cart-count'));
check('…and the cursor is back in the search box', (await active()).id === 'scan');

await key('F9');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(300);
const dialog = await page.evaluate(() => {
  const m = document.querySelector('.modal');
  const title = document.getElementById(m.getAttribute('aria-labelledby'));
  return { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), title: title?.textContent.trim() };
});
check('F9 opens the payment dialog, named by its title', dialog.role === 'dialog' && dialog.modal === 'true' && !!dialog.title, JSON.stringify(dialog));
const start = await active();
check('the cursor starts inside it, in a field', start.inModal && start.tag === 'INPUT', JSON.stringify(start));

// Tab round the whole dialog twice, forwards and back: it never leaves, and a button always shows a ring.
let escaped = 0, ringless = [];
for (let i = 0; i < 40; i++) {
  await key(i < 28 ? 'Tab' : 'Shift+Tab');
  const where = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return {
      inside: !!el.closest('.modal'),
      button: el.tagName === 'BUTTON',
      ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
      name: el.textContent.trim().slice(0, 20) || el.getAttribute('aria-label'),
    };
  });
  if (!where.inside) escaped++;
  if (where.button && !where.ring) ringless.push(where.name);
}
check('Tab and Shift+Tab stay inside the dialog', escaped === 0, String(escaped));
check('every button the keyboard reaches shows a focus ring', ringless.length === 0, JSON.stringify([...new Set(ringless)]));
// Land on a button, to see the ring.
for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement.tagName === 'BUTTON' && document.activeElement.textContent.includes('Card'))); i++) await key('Tab');
await shot('190-keyboard-focus');

await key('Escape');
await page.waitForTimeout(300);
check('Escape closes it', (await page.$$('.modal-backdrop')).length === 0);
check('…and the cursor goes back where it was', (await active()).id === 'scan', JSON.stringify(await active()));

// A laptop whose top row sends media keys has no F9 without Fn: Ctrl+Enter does the same.
const salesBefore = (await page.evaluate(async () => (await (await fetch('/api/sales?page=1&per=1')).json()))).total;
await key('Control+Enter');
await page.waitForTimeout(400);
check('Ctrl+Enter opens the payment dialog too', (await page.$$('.modal-backdrop #pay-amount')).length === 1);
await key('Control+Enter');
await key('Control+Enter');
await page.waitForTimeout(600);
const salesAfter = (await page.evaluate(async () => (await (await fetch('/api/sales?page=1&per=1')).json()))).total;
check('…and pressing it again does not confirm the sale', (await page.$$('.modal-backdrop #pay-amount')).length === 1 && salesAfter === salesBefore,
  `${salesBefore} → ${salesAfter}`);
await key('Escape');
await page.waitForTimeout(300);
await page.fill('#scan', 'muffin');
await key('Control+Enter');
await page.waitForTimeout(400);
check('with text in the search box, Ctrl+Enter still pays rather than scans', (await page.$$('.modal-backdrop #pay-amount')).length === 1 &&
  (await page.$$('.cart-line')).length === 2);
await key('Escape');
await page.waitForTimeout(300);
await page.fill('#scan', '');
check('the button says both shortcuts', (await page.getAttribute('#checkout', 'title')).includes('Ctrl+Enter') &&
  (await page.getAttribute('#checkout', 'aria-keyshortcuts')) === 'F9 Control+Enter');

await key('F9');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(300);
await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
await page.keyboard.type('50');
await key('Enter');
// The payment dialog closes, the sale-done mark plays, then the receipt opens: wait for the receipt itself.
await page.waitForSelector('#receipt-print', { timeout: 10000 });
await wait(async () => (await page.$$('.sale-done')).length === 0, 6000);
await page.waitForTimeout(400);
const receipt = await active();
check('the receipt opens holding the focus itself, not a button', receipt.isModal, JSON.stringify(receipt));
// A scanner's Enter after the next barcode must not press Print.
await key('Enter');
await page.waitForTimeout(300);
check('Enter on the receipt prints nothing', (await page.evaluate(() => window.__printed)) === 0);
await key('Escape');
await page.waitForTimeout(400);
check('Escape closes the receipt', (await page.$$('.modal-backdrop')).length === 0);
check('the cart is empty and the cursor is ready for the next customer',
  (await active()).id === 'scan' && (await page.$eval('#checkout', (b) => b.disabled)), JSON.stringify(await active()));
const sales = await page.evaluate(async () => (await (await fetch('/api/sales?page=1&per=5')).json()));
check('the sale was saved', (sales.rows || sales).length >= 1);

/* ------------------------------------------------------ stacked dialogs */
console.log('\n[Stacked dialogs]');
await page.goto(`${BASE}#/dashboard`);
await page.waitForSelector('.stat');
await page.evaluate(async () => {
  const { modal, confirmDialog } = await import('/js/ui.js');
  modal({ title: 'Outer', body: '<p>outer</p>', footer: '<button class="btn" id="outer-btn">Outer</button>' });
  setTimeout(() => confirmDialog({ title: 'Inner', message: 'inner' }), 50);
});
await page.waitForTimeout(300);
check('two dialogs are open', (await page.$$('.modal-backdrop')).length === 2);
await key('Escape');
await page.waitForTimeout(200);
check('Escape closes only the top one', (await page.$$('.modal-backdrop')).length === 1 &&
  (await page.textContent('.modal-backdrop h3')) === 'Outer');
await key('Escape');
await page.waitForTimeout(200);
check('a second Escape closes the other', (await page.$$('.modal-backdrop')).length === 0);

/* -------------------------------------------------------------- other screens */
console.log('\n[Names on other screens]');
for (const route of ['dashboard', 'products', 'categories', 'units', 'purchases/new', 'expenses', 'expense-categories', 'customers', 'suppliers', 'settings/payments', 'users', 'sales']) {
  await page.goto(`${BASE}#/${route}`);
  await page.waitForTimeout(900);
  const missing = await unnamedButtons();
  check(`#/${route}: every icon-only button has a name`, missing.length === 0, JSON.stringify(missing));
}

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' || '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
