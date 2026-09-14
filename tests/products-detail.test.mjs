/** Product pictures, the per-product sales and purchase reports, and restart detection. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'productdetaildata');
const PORT = 4531;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['--no-warnings', 'server/index.js'], {
  cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + log); process.exit(1); }

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return { status: res.status, type, bytes: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// A real 2×2 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

const login = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const admin = cookie;
check('login says whether a restart is needed', login.data.restart_needed === false, JSON.stringify(login.data.restart_needed));
check('and so does /me', (await call('GET', '/api/auth/me')).data.restart_needed === false);

const product = (await call('POST', '/api/products', { name: 'Picture Tea', barcode: 'PIC-1', cost: 2, price: 5, opening_stock: 40 })).data;

console.log('\n[a product picture]');
check('a new product has no picture', product.image_at === null, JSON.stringify(product.image_at));
check('asking for it is a 404', (await call('GET', `/api/products/${product.id}/image`)).status === 404);
const up = await call('PUT', `/api/products/${product.id}/image`, { data: `data:image/png;base64,${PNG}` });
check('uploading a PNG works', up.status === 200 && !!up.data.image_at, JSON.stringify(up.data).slice(0, 120));
const img = await call('GET', `/api/products/${product.id}/image?v=1`);
check('the picture is served with its type', img.status === 200 && img.type === 'image/png', `${img.status} ${img.type}`);
check('byte for byte', img.bytes.equals(Buffer.from(PNG, 'base64')));
check('lists carry the picture stamp', (await call('GET', '/api/products?search=Picture')).data[0].image_at === up.data.image_at);
check('a non-image is refused', (await call('PUT', `/api/products/${product.id}/image`, { data: 'data:text/html;base64,PGI+' })).data.code === 'IMAGE_TYPE');
check('an oversized picture is refused', (await call('PUT', `/api/products/${product.id}/image`, {
  data: `data:image/jpeg;base64,${Buffer.alloc(1600 * 1024, 7).toString('base64')}`,
})).data.code === 'IMAGE_TOO_LARGE');

await call('POST', '/api/users', { username: 'pic-till', password: 'test1234', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'pic-till', password: 'test1234' });
check('a cashier sees the picture on the till', (await call('GET', `/api/products/${product.id}/image`)).status === 200);
check('but cannot change it', (await call('PUT', `/api/products/${product.id}/image`, { data: `data:image/png;base64,${PNG}` })).status === 403);
check('nor read the product report', (await call('GET', `/api/products/${product.id}/sales`)).status === 403);
cookie = admin;

check('removing it works', (await call('DELETE', `/api/products/${product.id}/image`)).data.image_at === null);
check('and it is gone', (await call('GET', `/api/products/${product.id}/image`)).status === 404);

console.log('\n[the product reports]');
await call('POST', '/api/purchases', { supplier: 'Leaf Co', items: [{ product_id: product.id, qty: 10, unit_cost: 2 }] });
await call('POST', '/api/sales', { paid: 100, items: [{ product_id: product.id, qty: 3, unit_price: 5 }] });
await call('POST', '/api/sales', { paid: 100, items: [{ product_id: product.id, qty: 2, unit_price: 5, discount: 1 }] });
const report = (await call('GET', `/api/products/${product.id}/sales?from=2000-01-01&to=2100-01-01`)).data;
check('quantity sold adds up', near(report.summary.qty, 5), JSON.stringify(report.summary));
check('revenue counts the line discount', near(report.summary.revenue, 24));
check('cost is at the frozen average cost', near(report.summary.cost, 10));
check('profit and margin follow', near(report.summary.profit, 14) && near(report.summary.margin, 58.3), JSON.stringify(report.summary));
check('two invoices', report.summary.invoices === 2);
check('every line is listed with its invoice', report.lines.length === 2 && report.lines.every((l) => /^INV-/.test(l.doc_no)));
check('the daily series is keyed by date', report.byDay.length >= 1 && 'date' in report.byDay[0], JSON.stringify(report.byDay[0]));
const detail = (await call('GET', `/api/products/${product.id}`)).data;
check('the product shows what sold in 30 days', near(detail.sold_30, 5) && near(detail.revenue_30, 24), `${detail.sold_30} ${detail.revenue_30}`);
const bought = (await call('GET', `/api/products/${product.id}/purchases`)).data;
check('purchases list the supplier and cost', bought.length === 1 && bought[0].supplier === 'Leaf Co' && near(bought[0].unit_cost, 2));
check('an empty range reports nothing', (await call('GET', `/api/products/${product.id}/sales?from=1990-01-01&to=1990-01-31`)).data.lines.length === 0);

console.log('\n[deleting a product that was only ever adjusted]');
const counted = (await call('POST', '/api/products', { name: 'Only Adjusted', price: 1 })).data;
await call('POST', `/api/products/${counted.id}/adjust`, { qty: 4 });
const removed = await call('DELETE', `/api/products/${counted.id}`);
check('it is archived rather than failing', removed.status === 200 && removed.data.archived === true, JSON.stringify(removed.data));

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
