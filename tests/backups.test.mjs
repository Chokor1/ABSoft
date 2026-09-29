/** Backups nobody has to remember: one a day, one at every shift close, a copy in a second folder. */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const DATA = resolve(APP, '.test-run', 'backupsdata');
const SECOND = join(DATA, 'second-folder');
const PORT = 4543;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const backups = (dir = join(DATA, 'backups')) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.db')) : []);
const wait = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};

rmSync(DATA, { recursive: true, force: true });
let server, log = '';
const start = async () => {
  server = spawn('node', ['--no-warnings', 'server/index.js'], {
    cwd: APP, env: { ...process.env, ABSOFT_DATA: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  if (!(await wait(async () => (await fetch(BASE + '/')).ok))) { console.log('server failed\n' + log); process.exit(1); }
};
const stop = () => new Promise((r) => { server.on('exit', r); server.kill(); });
await start();

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

console.log('\n[the first start of the day]');
check('a fresh database gets its backup as the server starts', backups().length === 1, backups().join());
let settings = (await call('GET', '/api/settings')).data;
check('…and the settings say when', (settings.backup_last_auto || '').startsWith(today), settings.backup_last_auto);
check('…with nothing to report', !settings.backup_last_error, settings.backup_last_error);
check('a backup is a real database', backups()[0].startsWith('absoft-backup-') && (await call('GET', '/api/system')).data.backups.length === 1);

await stop();
await start();
await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
check('starting again the same day takes no second one', backups().length === 1, backups().join());

console.log('\n[a second folder]');
let r = await call('PUT', '/api/settings', { backup_dir2: join(DATA, 'absoft.db', 'inside-a-file') });
check('a folder that cannot be made is refused', r.status === 400 && r.data.code === 'BACKUP_DIR_BAD', JSON.stringify(r.data));
check('…and nothing was kept', !(await call('GET', '/api/settings')).data.backup_dir2);
const beforeFolder = backups();
r = await call('PUT', '/api/settings', { backup_dir2: SECOND });
check('a usable folder is kept, and made', r.status === 200 && r.data.backup_dir2 === SECOND && existsSync(SECOND), JSON.stringify(r.data.backup_dir2));
const added = backups().filter((n) => !beforeFolder.includes(n));
check('…and gets its first copy at once', backups(SECOND).length === 1 && added.length === 1, `${backups(SECOND).join()} / ${backups().join()}`);
check('the copy has the same name as the new backup', backups(SECOND)[0] === added[0], `${backups(SECOND)[0]} vs ${added[0]}`);
// Within a second of the start-up backup, the new one takes a "-2" suffix rather than failing.
check('two in one second do not fight over a name', added[0] !== beforeFolder[0], added.join());
check('the reply already carries the new status', r.data.backup_last_auto >= settings.backup_last_auto && !r.data.backup_last_error, JSON.stringify([r.data.backup_last_auto, r.data.backup_last_error]));
r = await call('PUT', '/api/settings', { backup_dir2: SECOND });
check('saving the same folder again takes nothing', backups().length === 2);
r = await call('PUT', '/api/settings', { store_name: 'Backup Test' });
check('nor does saving something else', backups().length === 2 && r.data.backup_dir2 === SECOND);

console.log('\n[a shift closes]');
await call('PUT', '/api/settings', { pos_shifts: '1' });
const shift = (await call('POST', '/api/shifts/open', { opening_cash: 50 })).data;
check('a shift opened', !!shift.id, JSON.stringify(shift));
const before = backups().length;
r = await call('POST', `/api/shifts/${shift.id}/close`, { counted_cash: 50 });
check('the shift closed at once', r.status === 200 && r.data.status === 'closed', JSON.stringify(r.data).slice(0, 120));
check('…and a backup follows, in both folders', await wait(() => backups().length === before + 1 && backups(SECOND).length === 2, 8000),
  `${backups().length} / ${backups(SECOND).length}`);
settings = (await call('GET', '/api/settings')).data;
check('the status moved on', settings.backup_last_auto >= r.data.closed_at.slice(0, 16) && !settings.backup_last_error, settings.backup_last_auto);

console.log('\n[when the second folder goes away]');
rmSync(SECOND, { recursive: true, force: true });
const gone = (await call('POST', '/api/shifts/open', { opening_cash: 10 })).data;
await call('POST', `/api/shifts/${gone.id}/close`, { counted_cash: 10 });
check('a missing folder is simply made again', await wait(() => backups(SECOND).length === 1, 8000), backups(SECOND).join());
await call('PUT', '/api/settings', { backup_dir2: '' });
check('the folder can be switched off', (await call('GET', '/api/settings')).data.backup_dir2 === '');
const cashier = (await call('POST', '/api/users', { username: 'till9', password: 'test1234', role: 'cashier' })).data;
cookie = '';
await call('POST', '/api/auth/login', { username: 'till9', password: 'test1234' });
r = await call('PUT', '/api/settings', { backup_dir2: SECOND });
check('a cashier cannot point backups anywhere', r.status === 403 && !!cashier, String(r.status));

await stop();
console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
