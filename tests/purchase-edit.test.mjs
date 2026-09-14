/** Editing a saved purchase: stock, average cost, the audit log, and who may do it. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file, so the suite runs from any clone on any machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'purchaseeditdata');
const PORT = 4523;
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
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const adminCookie = cookie;
const mk = async (name, barcode) =>
  (await call('POST', '/api/products', { name, barcode, cost: 4, price: 10, opening_stock: 100 })).data;
const flour = await mk('Edit Flour', 'PE-1');
const rice = await mk('Edit Rice', 'PE-2');
const product = async (p) => (await call('GET', `/api/products/${p.id}`)).data;

/* ------------------------------------------------------------------------ */
console.log('\n[a purchase starts its history when it is saved]');
const created = (await call('POST', '/api/purchases', {
  supplier: 'Mill Co', date: '2026-09-01', note: 'INV-77',
  items: [{ product_id: flour.id, qty: 100, unit_cost: 6 }],
})).data;
check('stock went in', near((await product(flour)).stock, 200));
check('average cost blended to 5', near((await product(flour)).cost, 5), String((await product(flour)).cost));
check('the log has one "created" entry', created.log.length === 1 && created.log[0].action === 'created', JSON.stringify(created.log));
check('with who did it', created.log[0].username === 'admin');
check('the list shows no edits yet', (await call('GET', '/api/purchases?from=2026-01-01&to=2026-12-31')).data[0].edit_count === 0);

/* ------------------------------------------------------------------------ */
console.log('\n[editing the lines corrects stock and cost]');
const edited = await call('PUT', `/api/purchases/${created.id}`, {
  supplier: 'Mill Co', date: '2026-09-01', note: 'INV-77', reason: 'Only half was delivered',
  items: [
    { product_id: flour.id, qty: 50, unit_cost: 6 },
    { product_id: rice.id, qty: 20, unit_cost: 9 },
  ],
});
check('the edit is accepted', edited.status === 200, JSON.stringify(edited.data));
check('the document number is kept', edited.data.doc_no === created.doc_no);
check('the total is recalculated', near(edited.data.total, 50 * 6 + 20 * 9), String(edited.data.total));
check('flour stock is 150, not 250', near((await product(flour)).stock, 150), String((await product(flour)).stock));
check('rice stock gained the new line', near((await product(rice)).stock, 120));
// Before: 100 @ 4 on hand. The 50 @ 6 now received → (400 + 300) / 150.
check('flour cost is re-averaged as if the purchase had always been 50', near((await product(flour)).cost, 4.67),
  String((await product(flour)).cost));
check('rice cost blends its new line', near((await product(rice)).cost, 4.83), String((await product(rice)).cost));
const flourMoves = (await product(flour)).history.filter((m) => m.kind === 'purchase');
check('flour has one purchase movement, not two', flourMoves.length === 1 && near(flourMoves[0].qty, 50), JSON.stringify(flourMoves));

const entry = edited.data.log[0];
check('an "edited" entry lands at the top of the log', entry.action === 'edited' && edited.data.log.length === 2);
check('it keeps the reason', entry.reason === 'Only half was delivered');
const flourChange = entry.changes.lines.find((l) => l.name === 'Edit Flour');
check('it records the flour change from 100 to 50',
  flourChange?.type === 'changed' && flourChange.from.qty === 100 && flourChange.to.qty === 50, JSON.stringify(entry.changes));
check('it records the rice line as added', entry.changes.lines.some((l) => l.name === 'Edit Rice' && l.type === 'added'));
check('it records the total', near(entry.changes.total.from, 600) && near(entry.changes.total.to, 480));
check('the list counts the edit', (await call('GET', '/api/purchases?from=2026-01-01&to=2026-12-31')).data[0].edit_count === 1);

/* ------------------------------------------------------------------------ */
console.log('\n[editing only the header leaves stock and cost alone]');
const costBefore = (await product(flour)).cost;
const header = (await call('PUT', `/api/purchases/${created.id}`, {
  supplier: 'Grain House', date: '2026-09-03', note: 'INV-77',
  items: [
    { product_id: flour.id, qty: 50, unit_cost: 6 },
    { product_id: rice.id, qty: 20, unit_cost: 9 },
  ],
})).data;
check('the supplier and date change', header.supplier === 'Grain House' && header.date === '2026-09-03');
check('the log records just those fields',
  header.log[0].changes.lines.length === 0 &&
    header.log[0].changes.fields.map((f) => f.field).sort().join() === 'date,supplier', JSON.stringify(header.log[0].changes));
check('flour cost did not move', (await product(flour)).cost === costBefore);
const move = (await product(flour)).history.find((m) => m.kind === 'purchase');
check('the stock movement follows the new date and supplier',
  move.created_at.startsWith('2026-09-03') && move.note.includes('Grain House'), JSON.stringify(move));

console.log('\n[saving with nothing changed adds nothing to the log]');
const same = (await call('PUT', `/api/purchases/${created.id}`, {
  supplier: 'Grain House', date: '2026-09-03', note: 'INV-77',
  items: [
    { product_id: rice.id, qty: 20, unit_cost: 9 },
    { product_id: flour.id, qty: 50, unit_cost: 6 },
  ],
})).data;
check('still three entries', same.log.length === 3, String(same.log.length));

/* ------------------------------------------------------------------------ */
console.log('\n[past sales keep the cost they were sold at]');
const sale = (await call('POST', '/api/sales', { paid: 100, items: [{ product_id: flour.id, qty: 10, unit_price: 10 }] })).data;
await call('PUT', `/api/purchases/${created.id}`, {
  items: [{ product_id: flour.id, qty: 80, unit_cost: 2 }, { product_id: rice.id, qty: 20, unit_cost: 9 }],
});
const saleAfter = (await call('GET', `/api/sales/${sale.id}`)).data;
check('the sale cost of goods is unchanged', near(saleAfter.cogs, sale.cogs), `${sale.cogs} → ${saleAfter.cogs}`);
check('omitted header fields are kept', (await call('GET', `/api/purchases/${created.id}`)).data.supplier === 'Grain House');

/* ------------------------------------------------------------------------ */
console.log('\n[refusals]');
check('an empty purchase is refused',
  (await call('PUT', `/api/purchases/${created.id}`, { items: [] })).data.code === 'PURCHASE_EMPTY');
check('a zero quantity is refused',
  (await call('PUT', `/api/purchases/${created.id}`, { items: [{ product_id: flour.id, qty: 0, unit_cost: 1 }] })).data.code === 'QTY_POSITIVE');
check('a missing purchase is 404', (await call('PUT', '/api/purchases/99999', { items: [] })).status === 404);
const stockAfterRefusals = (await product(flour)).stock;
check('refused edits change nothing', near(stockAfterRefusals, 100 + 80 - 10), String(stockAfterRefusals));

await call('POST', '/api/users', { username: 'buyer9', password: 'test1234', role: 'cashier' });
cookie = '';
await call('POST', '/api/auth/login', { username: 'buyer9', password: 'test1234' });
const refused = await call('PUT', `/api/purchases/${created.id}`, { items: [{ product_id: flour.id, qty: 1, unit_cost: 1 }] });
check('a cashier cannot edit a purchase', refused.status === 403 && refused.data.code === 'ADMIN_ONLY', JSON.stringify(refused));
cookie = adminCookie;

/* ------------------------------------------------------------------------ */
console.log('\n[the log outlives a deleted purchase]');
await call('DELETE', `/api/purchases/${created.id}`);
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(resolve(DATA, 'absoft.db'), { readOnly: true });
const rows = db.prepare(`SELECT action FROM purchase_log WHERE purchase_id = ? ORDER BY id`).all(created.id);
check('created, edits and the deletion are all still there',
  rows.map((r) => r.action).join() === 'created,edited,edited,edited,deleted', rows.map((r) => r.action).join());
db.close();

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
