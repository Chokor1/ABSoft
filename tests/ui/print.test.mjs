/** The shop's logo, and what a printed page looks like: letterhead, document, software line. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'printdata');
const PORT = 4569;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

// A picture to stand in for the shop's logo: a blue band, 240×90, written as a PNG.
const LOGO = resolve(WORK, 'logo.png');
writeFileSync(LOGO, pngOf(240, 90, [23, 58, 166]));

/** The smallest honest PNG: one solid colour, no filtering. */
function pngOf(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

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
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: resolve(SHOTS, `${n}.png`) });
await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });

await page.goto(BASE);
await page.waitForSelector('#login-form');
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin');
await page.click('button[type=submit]');
await page.waitForSelector('.shell');

/* --------------------------------------------------------------- the logo */
console.log('\n[a shop gives itself a logo]');
await page.goto(`${BASE}#/settings/store`);
await page.waitForSelector('#settings-form');
check('the store settings ask for a logo', !!(await page.$('#logo-preview')));
check('with nothing chosen yet', (await page.$$('#logo-preview img')).length === 0);
await page.setInputFiles('#logo-file', LOGO);
await page.waitForSelector('#logo-preview img', { timeout: 5000 });
check('the chosen picture shows at once', !!(await page.$('#logo-preview img')));
await page.click('#settings-form button[type=submit]');
await wait(async () => (await page.evaluate(async () => (await fetch('/api/settings')).json())).store_logo?.startsWith('data:image'), 5000);
const cfg = await page.evaluate(async () => (await fetch('/api/settings')).json());
check('it is kept with the shop settings, shrunk small', cfg.store_logo.startsWith('data:image') && cfg.store_logo.length < 60000,
  `${cfg.store_logo.slice(0, 24)} · ${cfg.store_logo.length} chars`);
check('the letterhead picks it up without a reload', !!(await page.$('#print-head .print-logo')));
const foot = await page.textContent('#print-foot');
check('and the page foot names the software', /ABSoft POS v\d/.test(foot), foot);
await shot('140-settings-logo');

/* ------------------------------------------------------------ the receipt */
console.log('\n[a receipt on the shop\'s own paper]');
await page.goto(`${BASE}#/pos`);
await page.waitForSelector('.tile');
await page.fill('#scan', '5901234123457');
await page.keyboard.press('Enter');
await page.waitForSelector('.cart-line');
await page.click('#checkout');
await page.waitForSelector('#pay-confirm');
await page.click('#pay-confirm');
await page.waitForSelector('.receipt', { timeout: 8000 });
check('the receipt carries the logo', !!(await page.$('.receipt .r-logo img')));
const by = await page.textContent('.receipt .r-by');
check('and the software line at its foot', /ABSoft POS v\d/.test(by), by);
await page.emulateMedia({ media: 'print' });
await page.waitForTimeout(300);
const framed = await page.evaluate(() => {
  const head = document.getElementById('print-head');
  return { headShown: getComputedStyle(head).display !== 'none' };
});
check('the letterhead stands aside for a receipt, which has its own', !framed.headShown);
await shot('141-print-receipt');
await page.emulateMedia({ media: 'screen' });
await page.click('.modal-head [data-close]');

/* ----------------------------------------------------------- a document */
console.log('\n[an invoice on paper]');
const sale = (await page.evaluate(async () => (await fetch('/api/sales?limit=1')).json()))[0];
await page.goto(`${BASE}#/sales/${sale.id}`);
await page.waitForSelector('.doc-head');
await page.emulateMedia({ media: 'print' });
await page.waitForTimeout(300);
const sheet = await page.evaluate(() => {
  const vis = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display !== 'none' : false; };
  return {
    head: vis('#print-head'),
    foot: vis('#print-foot'),
    logo: !!document.querySelector('#print-head .print-logo'),
    sidebar: vis('.sidebar'),
    topbar: vis('.topbar'),
    actions: vis('.doc-actions'),
    paper: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
  };
});
check('the letterhead and the software line are on the page', sheet.head && sheet.foot && sheet.logo, JSON.stringify(sheet));
check('the screen furniture is not', !sheet.sidebar && !sheet.topbar && !sheet.actions, JSON.stringify(sheet));
check('and it is black on white', sheet.text === 'rgb(0, 0, 0)' && sheet.paper === 'rgb(255, 255, 255)', JSON.stringify(sheet));
await shot('142-print-invoice');

// Dark mode is a screen choice; paper stays white.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await page.waitForTimeout(200);
const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('even with the screen in dark mode', dark === 'rgb(255, 255, 255)', dark);
await shot('143-print-invoice-dark');
await page.emulateMedia({ media: 'screen' });

/* ------------------------------------------------------------ a list */
console.log('\n[a list on paper]');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.goto(`${BASE}#/sales`);
await page.waitForSelector('table.data');
await page.emulateMedia({ media: 'print' });
await page.waitForTimeout(300);
const list = await page.evaluate(() => {
  const th = document.querySelector('table.data th');
  const filters = document.querySelector('.toolbar');
  return {
    head: getComputedStyle(th).backgroundColor,
    headText: getComputedStyle(th).color,
    filters: filters ? getComputedStyle(filters).display : 'none',
    width: Math.round(document.querySelector('.page').getBoundingClientRect().width),
  };
});
check('a table keeps its headings, in ink', list.headText === 'rgb(28, 34, 48)' && list.head !== 'rgba(0, 0, 0, 0)', JSON.stringify(list));
check('the filter bar is left on screen', list.filters === 'none', JSON.stringify(list));
check('and the list has the whole sheet', list.width > 1000, String(list.width));
await shot('144-print-list');
await page.emulateMedia({ media: 'screen' });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
