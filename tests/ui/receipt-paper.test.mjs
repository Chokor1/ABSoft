/**
 * A receipt on a thermal roll: with "80 mm roll" chosen in Settings, the printer
 * is given one page as wide as the roll and as long as the receipt, not a sheet
 * of A4 that feeds metres of blank paper. Left as it is, a receipt prints on a
 * full page, as it always has.
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
const DATA = resolve(WORK, 'receiptpaper');
const PORT = 4637;
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

/** A PDF's pages, and the first page's size in mm. */
const pdfPages = (buf) => {
  const text = buf.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const mm = (pt) => Math.round((Number(pt) * 25.4) / 72);
  return { pages, width: box ? mm(box[3] - box[1]) : 0, height: box ? mm(box[4] - box[2]) : 0 };
};

/** Sell three things at the till, and stop the receipt's Print at the moment it would open the print dialog. */
async function receiptPrinted() {
  await page.goto(`${BASE}#/pos`);
  await page.waitForSelector('#tiles .tile');
  for (const n of [0, 1, 2]) await page.click(`#tiles .tile >> nth=${n}`);
  await page.click('#checkout');
  await page.waitForSelector('#pay-confirm');
  await page.click('#pay-confirm');
  await page.waitForSelector('.receipt', { timeout: 8000 });
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('.modal [data-print]');
  const state = await page.evaluate(() => ({
    printed: window.__printed,
    roll: document.body.classList.contains('print-roll'),
    page: [...document.querySelectorAll('style')].map((s) => s.textContent).find((s) => s.includes('@page')) || '',
  }));
  await page.emulateMedia({ media: 'print' });
  const pdf = pdfPages(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  await page.emulateMedia({ media: 'screen' });
  return { ...state, pdf };
}

console.log('\n[as every shop starts: a full page]');
check('the setting starts empty', ((await api('/api/settings')).receipt_paper || '') === '');
let r = await receiptPrinted();
check('Print prints', r.printed === 1);
check('with no roll size of its own', !r.roll && !r.page, JSON.stringify(r));
check('so the page is the printer\'s own, as before', r.pdf.width > 150, JSON.stringify(r.pdf));
await page.click('.modal-head [data-close]');

console.log('\n[an 80 mm roll, chosen in Settings]');
await page.goto(`${BASE}#/settings/store`);
await page.waitForSelector('#settings-form [name=receipt_paper]');
await page.selectOption('#settings-form [name=receipt_paper]', '80');
await page.click('#settings-form button[type=submit]');
await wait(async () => (await api('/api/settings')).receipt_paper === '80', 4000);
check('saved', (await api('/api/settings')).receipt_paper === '80');
await page.reload();
await page.waitForSelector('.shell');
r = await receiptPrinted();
check('Print prints', r.printed === 1);
check('one page, 80 mm wide', r.pdf.pages === 1 && r.pdf.width === 80, JSON.stringify(r.pdf));
check('as long as the receipt, not a sheet of A4', r.pdf.height > 60 && r.pdf.height < 250, JSON.stringify(r.pdf));
await page.screenshot({ path: resolve(SHOTS, '210-receipt-roll.png') });
await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
check('and the screen is itself again after printing',
  await page.evaluate(() => !document.body.classList.contains('print-roll') && ![...document.querySelectorAll('style')].some((s) => s.textContent.includes('size: 80mm'))));
await page.click('.modal-head [data-close]');

console.log('\n[nonsense is a full page]');
await api('/api/settings', 'PUT', { receipt_paper: '300' });
check('only 80 or 58 is a roll', (await api('/api/settings')).receipt_paper === '');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
