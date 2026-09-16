/**
 * A database that already has opening stock documents (the short-lived schema
 * v8) updates: each document becomes a stock adjustment of type "opening", its
 * stock movements follow it, and the separate tables go. Nothing about the stock
 * changes.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'openmigdata');
const PORT = 4555;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const start = () => {
  const s = spawn('node', ['--no-warnings', 'server/index.js'], {
    cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.log = '';
  s.stdout.on('data', (d) => (s.log += d));
  s.stderr.on('data', (d) => (s.log += d));
  return s;
};
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
const stop = (s) => new Promise((r) => { s.on('exit', r); s.kill(); });
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

/* 1. A shop on the current build, wound back to schema v8 with an opening document. */
console.log('\n[a shop that recorded opening stock documents]');
rmSync(DATA, { recursive: true, force: true });
let server = start();
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + server.log); process.exit(1); }
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
const tea = (await call('POST', '/api/products', { name: 'Migrated Tea', barcode: 'MIG-1', cost: 2, price: 5 })).data;
const rice = (await call('POST', '/api/products', { name: 'Migrated Rice', barcode: 'MIG-2', cost: 1, price: 2 })).data;
await call('POST', '/api/adjustments', { reason: 'Damaged', items: [{ product_id: tea.id, qty: 1 }] }); // an ordinary one, ADJ-000001
await stop(server);

{
  const db = new DatabaseSync(join(DATA, 'absoft.db'));
  db.exec(`
    ALTER TABLE adjustments DROP COLUMN type;
    CREATE TABLE openings (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT NOT NULL, date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE opening_items (id INTEGER PRIMARY KEY AUTOINCREMENT, opening_id INTEGER NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0);
  `);
  db.prepare(`INSERT INTO openings (id, doc_no, date, note, user_id) VALUES (1, 'OPN-000001', '2026-03-01', 'Start of year', 1)`).run();
  db.prepare(`INSERT INTO opening_items (opening_id, product_id, qty, unit_cost) VALUES (1, ?, 30, 2), (1, ?, 12, 1)`).run(tea.id, rice.id);
  db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
     VALUES (?, 30, 2, 'opening', 'openings', 1, 'OPN-000001', 1, '2026-03-01 09:00:00'),
            (?, 12, 1, 'opening', 'openings', 1, 'OPN-000001', 1, '2026-03-01 09:00:00')`,
  ).run(tea.id, rice.id);
  db.exec('PRAGMA user_version = 8');
  check('wound back to schema v8 with one opening document', Number(db.prepare('PRAGMA user_version').get().user_version) === 8);
  db.close();
}

/* 2. The update. */
console.log('\n[updating]');
server = start();
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + server.log); process.exit(1); }
check('the log shows the conversion', /migrated\s+v9 - opening-stock-as-adjustments/.test(server.log), server.log.slice(0, 400));
cookie = '';
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });

const openings = (await call('GET', '/api/adjustments?page=1&per=10&type=opening')).data;
check('the opening document is now an adjustment of type opening', openings.total === 1, JSON.stringify(openings.rows));
const doc = (await call('GET', `/api/adjustments/${openings.rows[0].id}`)).data;
check('it takes the next adjustment number', doc.doc_no === 'ADJ-000002', doc.doc_no);
check('keeping its date, note and reason', doc.date === '2026-03-01' && doc.note === 'Start of year' && doc.reason === 'Opening stock');
check('and its lines, with their costs', doc.items.length === 2 && near(doc.items.find((i) => i.product_id === tea.id).unit_cost, 2));
check('the older correction is marked as an ordinary adjustment', (await call('GET', '/api/adjustments?page=1&per=10&type=adjustment')).data.total === 1);
const teaNow = (await call('GET', `/api/products/${tea.id}`)).data;
check('stock is unchanged: 30 opened + 1 found', near(teaNow.stock, 31), String(teaNow.stock));
check('the movements now point at the adjustment',
  teaNow.history.some((m) => m.kind === 'opening' && m.ref_table === 'adjustments' && m.ref_id === doc.id), JSON.stringify(teaNow.history));
await call('DELETE', `/api/adjustments/${doc.id}`);
check('so deleting it takes the stock back out, as it should', near((await call('GET', `/api/products/${tea.id}`)).data.stock, 1));
await stop(server);

{
  const db = new DatabaseSync(join(DATA, 'absoft.db'), { readOnly: true });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('openings', 'opening_items')`).all();
  check('the separate tables are gone', tables.length === 0, JSON.stringify(tables));
  db.close();
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
