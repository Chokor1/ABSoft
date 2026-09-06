/**
 * The full update path: a shop still running the very first release (schema v0)
 * installs the current version. Every migration runs in one go, and a year of
 * trading has to come through untouched.
 *
 * This is the test to run before shipping anything to a real till.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const WORK = resolve(APP, '.test-run');
const DATA = resolve(WORK, 'migrate-v1');
const PORT = 4517;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

/* ------------------------------------------------------------------------- */
/* A v1.0.0 database, written by hand exactly as that release shaped it.      */
/* ------------------------------------------------------------------------- */
console.log('\n[a shop running the first release]');
{
  const db = new DatabaseSync(join(DATA, 'absoft.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT UNIQUE,
      category TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'pcs', cost REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, qty REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, ref_table TEXT NOT NULL DEFAULT '',
      ref_id INTEGER, note TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT NOT NULL,
      supplier TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, total REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      qty REAL NOT NULL, unit_cost REAL NOT NULL, total REAL NOT NULL);
    CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT NOT NULL,
      customer TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
      cogs REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, method TEXT NOT NULL DEFAULT 'cash',
      note TEXT NOT NULL DEFAULT '', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      qty REAL NOT NULL, unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL);
    CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General', note TEXT NOT NULL DEFAULT '', amount REAL NOT NULL,
      method TEXT NOT NULL DEFAULT 'cash', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIEW product_stock AS SELECT p.id AS product_id, COALESCE(SUM(m.qty), 0) AS stock
      FROM products p LEFT JOIN stock_moves m ON m.product_id = p.id GROUP BY p.id;
  `);

  const salt = randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO users (username, full_name, password_hash, salt, role) VALUES (?,?,?,?,?)`)
    .run('owner', 'Shop Owner', scryptSync('secret123', salt, 64).toString('hex'), salt, 'admin');

  // Arabic and English names, to prove the directory back-fill copes with both.
  db.prepare(`INSERT INTO products (name, barcode, category, unit, cost, price, min_stock) VALUES (?,?,?,?,?,?,?)`)
    .run('Legacy Widget', 'LEG-1', 'Tools', 'pcs', 4, 10, 3);
  db.prepare(`INSERT INTO products (name, barcode, category, unit, cost, price, min_stock) VALUES (?,?,?,?,?,?,?)`)
    .run('معسل تفاح', 'LEG-2', 'معسل', 'box', 6, 15, 2);

  db.prepare(`INSERT INTO stock_moves (product_id, qty, unit_cost, kind, user_id) VALUES (1,100,4,'opening',1)`).run();
  db.prepare(`INSERT INTO stock_moves (product_id, qty, unit_cost, kind, user_id) VALUES (2,40,6,'opening',1)`).run();

  db.prepare(`INSERT INTO purchases (doc_no, supplier, date, total, user_id) VALUES ('PO-000001','Acme Supply','2026-01-05',200,1)`).run();
  db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, total) VALUES (1,1,50,4,200)`).run();
  db.prepare(`INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, user_id) VALUES (1,50,4,'purchase','purchases',1,1)`).run();

  // one fully paid, one never paid
  db.prepare(`INSERT INTO sales (doc_no, customer, date, subtotal, total, cogs, paid, method, user_id)
              VALUES ('INV-000001','حسن شكر','2026-01-15',100,100,40,100,'cash',1)`).run();
  db.prepare(`INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost, total) VALUES (1,1,10,10,4,100)`).run();
  db.prepare(`INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, user_id) VALUES (1,-10,4,'sale','sales',1,1)`).run();

  db.prepare(`INSERT INTO sales (doc_no, customer, date, subtotal, total, cogs, paid, method, user_id)
              VALUES ('INV-000002','Slow Payer','2026-01-20',150,150,60,0,'credit',1)`).run();
  db.prepare(`INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost, total) VALUES (2,2,10,15,6,150)`).run();
  db.prepare(`INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, user_id) VALUES (2,-10,6,'sale','sales',2,1)`).run();

  db.prepare(`INSERT INTO expenses (date, category, note, amount, user_id) VALUES ('2026-01-25','Rent','January rent',500,1)`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('store_name','Legacy Shop'),('currency','$'),('tax_rate','0')`).run();

  check('the database is at schema v0', Number(db.prepare('PRAGMA user_version').get().user_version) === 0);
  check('it has no description column',
    !db.prepare(`PRAGMA table_info('products')`).all().some((c) => c.name === 'description'));
  check('no reusable-names directory', !db.prepare(`SELECT name FROM sqlite_master WHERE name='entities'`).get());
  check('no payments ledger', !db.prepare(`SELECT name FROM sqlite_master WHERE name='payments'`).get());
  db.close();
}

/* ------------------------------------------------------------------------- */
console.log('\n[installing the current version over it]');
const server = spawn('node', ['--no-warnings', 'server/index.js'], {
  cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const wait = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};
if (!(await wait(async () => (await fetch(BASE + '/')).ok))) {
  console.log('server failed to start\n' + log);
  process.exit(1);
}
check('it starts on the old database', true);
check('every migration ran in one go', (log.match(/migrated/g) || []).length >= 3, log.slice(0, 400));

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

const login = await call('POST', '/api/auth/login', { username: 'owner', password: 'secret123' });
check('the owner can still sign in', login.status === 200 && login.data.user.full_name === 'Shop Owner');
check('the store settings survived', login.data.settings.store_name === 'Legacy Shop');

/* --------------------------------------------------------- nothing lost -- */
console.log('\n[the trading history is intact]');
const products = (await call('GET', '/api/products')).data;
check('both products are there', products.length === 2, String(products.length));
check('the Arabic product name is untouched', products.some((p) => p.name === 'معسل تفاح'),
  products.map((p) => p.name).join('|'));
const widget = products.find((p) => p.name === 'Legacy Widget');
check('stock is still right (100 + 50 - 10 = 140)', near(widget.stock, 140), String(widget.stock));

const sales = (await call('GET', '/api/sales?from=2000-01-01&to=2100-01-01')).data;
check('both invoices survived', sales.length === 2);
check('the Arabic customer name survived', sales.some((s) => s.customer === 'حسن شكر'));
check('profit on the first invoice is unchanged (100 - 40 = 60)',
  near(sales.find((s) => s.doc_no === 'INV-000001').profit, 60));

const pnl = (await call('GET', '/api/reports/pnl?from=2000-01-01&to=2100-01-01')).data;
check('revenue unchanged (100 + 150)', near(pnl.revenue, 250), String(pnl.revenue));
check('cost of goods unchanged (40 + 60)', near(pnl.cogs, 100), String(pnl.cogs));
check('expenses unchanged', near(pnl.expenses, 500), String(pnl.expenses));
check('net profit unchanged (250 - 100 - 500)', near(pnl.net_profit, -350), String(pnl.net_profit));
check('the purchase survived', (await call('GET', '/api/purchases?from=2000-01-01&to=2100-01-01')).data.length === 1);

/* ------------------------------------------------------ everything new -- */
console.log('\n[and the new features are wired up]');
check('the schema is fully up to date',
  (await call('GET', '/api/system')).data.schema_version === (await call('GET', '/api/system')).data.schema_latest);

check('descriptions can be written', (await call('PUT', `/api/products/${widget.id}`,
  { description: 'now with a description' })).data.description === 'now with a description');

const customers = (await call('GET', '/api/entities/customer')).data.map((c) => c.name);
check('old customers became reusable names', customers.includes('حسن شكر') && customers.includes('Slow Payer'),
  customers.join('|'));
check('old suppliers too', (await call('GET', '/api/entities/supplier')).data.some((s) => s.name === 'Acme Supply'));
check('old categories too, Arabic included',
  (await call('GET', '/api/entities/category')).data.some((c) => c.name === 'معسل'));

const paidInvoice = (await call('GET', `/api/sales/${sales.find((s) => s.doc_no === 'INV-000001').id}`)).data;
check('the settled invoice shows no balance', near(paidInvoice.balance, 0), String(paidInvoice.balance));
check('its payment was back-filled', paidInvoice.payments.length === 1);

const owed = (await call('GET', `/api/sales/${sales.find((s) => s.doc_no === 'INV-000002').id}`)).data;
check('the unpaid invoice still owes the lot', near(owed.balance, 150), String(owed.balance));
check('with no payment invented', owed.payments.length === 0);
check('receivables reports exactly that debt',
  near((await call('GET', '/api/reports/receivables')).data.total, 150));

const settled = (await call('POST', `/api/sales/${owed.id}/payments`, { amount: 60 })).data;
check('an instalment can be taken against the old invoice', near(settled.balance, 90), String(settled.balance));

check('selling still works after the upgrade',
  (await call('POST', '/api/sales', { customer: 'حسن شكر', items: [{ product_id: widget.id, qty: 1, unit_price: 10 }] })).status === 200);
check('and stock moved for it', near((await call('GET', `/api/products/${widget.id}`)).data.stock, 139),
  String((await call('GET', `/api/products/${widget.id}`)).data.stock));

server.kill();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
