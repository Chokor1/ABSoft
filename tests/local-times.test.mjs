/**
 * A sale's time is this computer's time: the receipt, the sales list and the
 * stock movement say what the clock on the wall said, not UTC. Sales written by
 * an older version (in UTC) are moved to local time once, by the update.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'localtimes');
const PORT = 4639;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const utcOf = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
/** Minutes between a stored stamp and now, as this computer reads it. */
const minutesOff = (stamp) => Math.abs(new Date(stamp.replace(' ', 'T')).getTime() - Date.now()) / 60000;

let server, log = '';
async function start() {
  server = spawn('node', ['--no-warnings', 'server/index.js'], {
    cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('server failed\n' + log);
  process.exit(1);
}
const stop = () => new Promise((r) => { server.on('exit', r); server.kill(); });

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

rmSync(DATA, { recursive: true, force: true });
const offset = -new Date().getTimezoneOffset();
console.log(`\n(this computer is UTC${offset >= 0 ? '+' : ''}${offset / 60})`);

try {
  await start();
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const p = (await call('POST', '/api/products', { name: 'Pepsi', price: 1, cost: 0.4, opening_stock: 10 })).data;

  console.log('\n[a sale now]');
  const sale = (await call('POST', '/api/sales', { tax: 0, items: [{ product_id: p.id, qty: 1, unit_price: 1 }] })).data;
  check('its time is the clock on this computer', minutesOff(sale.created_at) < 2, `${sale.created_at} vs ${stampOf(new Date())}`);
  check('its payment too', sale.payments?.length && minutesOff(sale.payments[0].created_at) < 2, JSON.stringify(sale.payments));
  const detail = (await call('GET', `/api/products/${p.id}`)).data;
  const move = (detail.history || detail.moves || []).find((m) => m.kind === 'sale');
  check('and the stock it moved', move && minutesOff(move.created_at) < 2, JSON.stringify(move));

  console.log('\n[a sale written in UTC by an older version]');
  await stop();
  const db = new DatabaseSync(resolve(DATA, 'absoft.db'));
  const earlier = new Date(Date.now() - 3 * 3600000);
  db.prepare(`UPDATE sales SET created_at = ? WHERE id = ?`).run(utcOf(earlier), sale.id);
  db.prepare(`UPDATE payments SET created_at = ? WHERE sale_id = ?`).run(utcOf(earlier), sale.id);
  const v = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(`PRAGMA user_version = ${v - 1}`);
  db.close();
  await start();
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const moved = (await call('GET', `/api/sales/${sale.id}`)).data;
  check('the update moves it to local time', moved.created_at === stampOf(earlier), `${moved.created_at} vs ${stampOf(earlier)}`);
  check('and its payment', moved.payments[0].created_at === stampOf(earlier), moved.payments[0].created_at);
  const again = (await call('GET', `/api/sales/${sale.id}`)).data;
  check('once only', again.created_at === stampOf(earlier));
} catch (e) {
  fail++;
  console.log('  FAIL  threw', e.stack);
} finally {
  server?.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
