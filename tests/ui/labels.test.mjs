/** Barcode labels: the bars are drawn right, and the sheet prints at label size. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const WORK = resolve(APP, '.test-run');
const SHOTS = resolve(WORK, 'shots');
const DATA = resolve(WORK, 'labelsdata');
const PORT = 4583;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

/* ------------------------------------------- the encoder, before any browser */
const { barcodeModules, eanCheckDigit, isEan13 } = await import(`file://${resolve(APP, 'public/js/barcode.js')}`);

console.log('\n[the bars say what the number says]');
check('a check digit is worked out the GS1 way', eanCheckDigit('590123412345') === 7 && eanCheckDigit('400638133393') === 1);
check('a wrong check digit is not an EAN-13', isEan13('5901234123457') && !isEan13('5901234123458'));

// Read an EAN-13 back out of its own bars, the way a scanner would.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function decodeEan13(modules) {
  if (modules.length !== 95 || !modules.startsWith('101') || !modules.endsWith('101')) return null;
  if (modules.slice(45, 50) !== '01010') return null;
  const left = [];
  const parity = [];
  for (let i = 0; i < 6; i++) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    const l = L.indexOf(chunk);
    const g = G.indexOf(chunk);
    if (l < 0 && g < 0) return null;
    left.push(l < 0 ? g : l);
    parity.push(l < 0 ? 'G' : 'L');
  }
  const first = PARITY.indexOf(parity.join(''));
  if (first < 0) return null;
  const right = [];
  for (let i = 0; i < 6; i++) {
    const chunk = modules.slice(50 + i * 7, 57 + i * 7);
    const r = R.indexOf(chunk);
    if (r < 0) return null;
    right.push(r);
  }
  return `${first}${left.join('')}${right.join('')}`;
}
for (const code of ['5901234123457', '4006381333931', '2000000001005']) {
  const drawn = barcodeModules(code);
  check(`${code} scans back to itself`, drawn.kind === 'ean13' && decodeEan13(drawn.modules) === code,
    `${drawn.kind} ${decodeEan13(drawn.modules)}`);
}
const c128 = barcodeModules('AB-12');
check('anything else is drawn as Code 128, starting and ending with a bar',
  c128.kind === 'code128' && c128.modules.startsWith('11') && c128.modules.endsWith('11'), c128.modules.slice(0, 12));
check('a long run of digits is packed two to a symbol',
  barcodeModules('12345678').modules.length === 79, String(barcodeModules('12345678').modules.length));

/* ------------------------------------------------------------- the screen */
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

console.log('\n[a sheet of labels]');
await page.goto(`${BASE}#/labels`);
await page.waitForSelector('#label-find');
check('it is reached from the Products screen', await page.evaluate(async () => {
  location.hash = '#/products';
  await new Promise((r) => setTimeout(r, 900));
  return !!document.querySelector('#page-actions #labels, .page-actions #labels');
}));
await page.goto(`${BASE}#/labels`);
await page.waitForSelector('#label-find');
check('the label starts at 40 × 20 mm', (await page.inputValue('#label-w')) === '40' && (await page.inputValue('#label-h')) === '20');
check('the name is printed by default, the price is not',
  (await page.isChecked('#label-name')) && !(await page.isChecked('#label-price')));
check('and nothing is on the sheet yet', (await page.textContent('#page')).includes('Nothing to print yet'));

await page.fill('#label-find', 'Espresso');
await page.waitForSelector('.combo-menu:not([hidden]) .combo-item', { timeout: 8000 });
await page.click('.combo-menu .combo-item');
await page.waitForSelector('#label-table tbody tr');
check('a product joins the sheet with one label', (await page.$$('#label-table tbody tr')).length === 1 &&
  (await page.inputValue('#label-table [data-copies]')) === '1');
const preview = await page.evaluate(() => {
  const label = document.querySelector('#label-preview .label');
  const box = label.getBoundingClientRect();
  return {
    w: Math.round(box.width), h: Math.round(box.height),
    name: label.querySelector('.label-name')?.textContent.trim(),
    price: !!label.querySelector('.label-price'),
    bars: label.querySelectorAll('.bc rect').length,
    code: label.querySelector('.label-code')?.textContent.trim(),
  };
});
// 40mm at 96dpi is ~151px, 20mm ~76px.
check('the preview is the real size of the label', Math.abs(preview.w - 151) <= 3 && Math.abs(preview.h - 76) <= 3,
  JSON.stringify(preview));
check('with the name on it and no price', preview.name === 'Espresso Beans 1kg' && !preview.price, JSON.stringify(preview));
check('and the barcode drawn as bars', preview.bars > 20 && preview.code === '5 901234 123457', JSON.stringify(preview));
await shot('160-labels');

console.log('\n[what goes on the label]');
await page.check('#label-price');
await page.waitForTimeout(300);
check('the price can be added', await page.evaluate(() => !!document.querySelector('#label-preview .label-price')));
await page.uncheck('#label-name');
await page.waitForTimeout(300);
check('and the name taken off', await page.evaluate(() => !document.querySelector('#label-preview .label-name')));
await page.check('#label-name');
await page.fill('#label-h', '30');
await page.waitForTimeout(300);
const taller = await page.evaluate(() => Math.round(document.querySelector('#label-preview .label').getBoundingClientRect().height));
check('a different roll size is followed', Math.abs(taller - 113) <= 4, String(taller));
await page.fill('#label-h', '20');
await shot('161-labels-price');

console.log('\n[printing]');
await page.fill('#label-table [data-copies]', '3');
await page.waitForTimeout(300);
check('the sheet holds one label per copy', (await page.evaluate(() => document.querySelectorAll('#labels-sheet .label').length)) === 3);
await page.click('#labels-print');
check('printing is asked for', (await page.evaluate(() => window.__prints)) === 1);
const printed = await page.evaluate(() => {
  const style = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join(' ');
  return { page: /@page\s*{\s*size:\s*40mm 20mm/.test(style) };
});
check('on a page exactly the size of the label', printed.page, JSON.stringify(printed));
await page.emulateMedia({ media: 'print' });
await page.waitForTimeout(300);
const onPaper = await page.evaluate(() => {
  const vis = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display !== 'none' : false; };
  return { sheet: vis('#labels-sheet'), app: vis('#app'), head: vis('#print-head') };
});
check('only the labels reach the paper', onPaper.sheet && !onPaper.app && !onPaper.head, JSON.stringify(onPaper));
await shot('162-labels-print');
await page.emulateMedia({ media: 'screen' });

console.log('\n[a product with no barcode]');
const made = await page.evaluate(async () => (await (await fetch('/api/products', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Loose Dates', price: 7, cost: 4, unit: 'kg' }),
})).json()));
check('a product can be saved without one', !made.barcode, JSON.stringify(made.barcode));
await page.goto(`${BASE}#/labels/${made.id}`);
await page.waitForSelector('#label-table tbody tr');
check('the product page sends it straight to the labels screen', (await page.textContent('#label-table')).includes('Loose Dates'));
check('and the sheet says it has no barcode yet', !!(await page.$('#label-table [data-make]')));
await page.click('#label-table [data-make]');
await wait(async () => !(await page.$('#label-table [data-make]')), 6000);
const code = (await page.textContent('#label-table .mono')).trim();
check('one can be made for it, in the shop’s own range', /^200\d{9}\d$/.test(code), code);
const scans = await page.evaluate(() => document.querySelectorAll('#label-preview .bc rect').length);
check('and it draws as a barcode like any other', scans > 20, String(scans));
await shot('163-labels-generated');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
