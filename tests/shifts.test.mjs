/**
 * Shifts at the till — opened with the cash in the drawer, closed by counting
 * it — and the till's search settings.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'shiftsdata');
const PORT = 4565;
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
const get = async (path) => (await call('GET', path)).data;
const sell = (extra) => call('POST', '/api/sales', { tax: 0, items: [{ product_id: tea.id, qty: 1, unit_price: 20 }], ...extra });

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const tea = (await call('POST', '/api/products', { name: 'Shift Tea', barcode: 'SH-T', cost: 5, price: 20, opening_stock: 100 })).data;

console.log('\n[search settings]');
let s = await get('/api/settings');
check('a shop starts searching from 3 letters, 40 cards at a time, shifts off',
  s.search_min_chars === '3' && s.pos_page_size === '40' && s.pos_shifts === '0', JSON.stringify(s));
s = (await call('PUT', '/api/settings', { search_min_chars: '1', pos_page_size: '1000' })).data;
check('a small shop can search from the first letter', s.search_min_chars === '1');
check('and a silly batch size is held to 200', s.pos_page_size === '200');
s = (await call('PUT', '/api/settings', { search_min_chars: '0', pos_page_size: '60' })).data;
check('below one letter is not a search', s.search_min_chars === '1' && s.pos_page_size === '60');

console.log('\n[shifts switched off]');
check('opening a shift is refused', (await call('POST', '/api/shifts/open', { opening_cash: 50 })).data.code === 'SHIFTS_OFF');
check('and the till sells as it always has', (await sell({ source: 'pos' })).status === 200);

console.log('\n[shifts switched on]');
await call('PUT', '/api/settings', { pos_shifts: '1' });
let r = await sell({ source: 'pos' });
check('the till will not sell without an open shift', r.status === 400 && r.data.code === 'SHIFT_REQUIRED', JSON.stringify(r.data));
check('a sale entered by hand from Sell still goes through', (await sell({})).status === 200);
const old = (await sell({ customer: 'Owing Omar', paid: 0, method: 'credit' })).data; // owed from before the shift

r = await call('POST', '/api/shifts/open', { opening_cash: 50, note: 'Morning' });
const shift = r.data;
check('opening a shift numbers it and counts the drawer', r.status === 200 && shift.doc_no === 'SH-000001' &&
  near(shift.opening_cash, 50) && shift.status === 'open', JSON.stringify(r.data));
check('only one shift at a time', (await call('POST', '/api/shifts/open', { opening_cash: 10 })).data.code === 'SHIFT_OPEN');

const inShift = (await sell({ source: 'pos' })).data;
check('a till sale now belongs to the shift', inShift.shift_id === shift.id, String(inShift.shift_id));
await sell({ source: 'pos', customer: 'Tab Tina', paid: 0, method: 'credit' });
await sell({ source: 'pos', method: 'card' });
await call('POST', `/api/sales/${old.id}/payments`, { amount: 5, method: 'cash' });

let cur = (await get('/api/shifts/current')).shift;
check('the shift counts its sales', cur.sales === 3 && near(cur.sales_total, 60), `${cur.sales} / ${cur.sales_total}`);
check('and what is still owed on them', near(cur.on_account, 20), String(cur.on_account));
check('cash in: the sale paid in cash and a debt collected during the shift', near(cur.cash_in, 25), String(cur.cash_in));
check('so the drawer should hold 50 + 25', near(cur.expected_cash, 75), String(cur.expected_cash));
check('with each way of paying listed', cur.payments.some((p) => p.method === 'card' && near(p.amount, 20)),
  JSON.stringify(cur.payments));

console.log('\n[closing]');
r = await call('POST', `/api/shifts/${shift.id}/close`, { counted_cash: 70, note: 'Five short' });
check('closing records the count against what was expected', r.status === 200 && r.data.status === 'closed' &&
  near(r.data.expected_cash, 75) && near(r.data.counted_cash, 70) && near(r.data.difference, -5), JSON.stringify(r.data));
check('a closed shift cannot be closed twice', (await call('POST', `/api/shifts/${shift.id}/close`, { counted_cash: 1 })).data.code === 'SHIFT_CLOSED');
check('and once closed, the till waits for the next one', (await sell({ source: 'pos' })).data.code === 'SHIFT_REQUIRED');
await call('POST', `/api/sales/${old.id}/payments`, { amount: 5, method: 'cash' });
check('a closed shift keeps what it expected, whatever comes after', near((await get(`/api/shifts/${shift.id}`)).expected_cash, 75));

console.log('\n[history]');
await call('POST', '/api/shifts/open', { opening_cash: 70 });
const list = await get('/api/shifts?page=1&per=10');
check('shifts are kept, newest first', list.total === 2 && list.rows[0].status === 'open' && list.rows[1].status === 'closed');
const detail = await get(`/api/shifts/${shift.id}`);
check('a shift opens with its sales', detail.sale_list.length === 3 && detail.opened_by_name === 'admin');

console.log('\n[a cashier runs their own shift]');
await call('POST', '/api/users', { username: 'till2', password: 'pass2', role: 'cashier' });
const open = (await get('/api/shifts/current')).shift;
cookie = '';
await call('POST', '/api/auth/login', { username: 'till2', password: 'pass2' });
check('a cashier sees the shift', (await get('/api/shifts/current')).shift?.id === open.id);
r = await call('POST', `/api/shifts/${open.id}/close`, { counted_cash: 70 });
check('closes it', r.status === 200 && r.data.closed_by_name === 'till2');
r = await call('POST', '/api/shifts/open', { opening_cash: 70 });
check('and opens the next', r.status === 200 && r.data.opened_by_name === 'till2');
check('but cannot switch shifts off', (await call('PUT', '/api/settings', { pos_shifts: '0' })).status === 403);

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
