import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_FILE, db, getSettings } from './db.js';
import { currentVersion } from './migrations.js';
import { VERSION, diskVersion } from './version.js';
import { ensureSeedAdmin, login, logout, purgeExpiredSessions, userFromToken } from './auth.js';
import {
  HttpError,
  Router,
  forbidden,
  parseCookies,
  readJsonBody,
  sendJson,
  serveStatic,
  notFound,
} from './http.js';
import { register as registerProducts } from './routes/products.js';
import { register as registerPurchases } from './routes/purchases.js';
import { register as registerSales } from './routes/sales.js';
import { register as registerExpenses } from './routes/expenses.js';
import { register as registerReports } from './routes/reports.js';
import { register as registerUsers } from './routes/users.js';
import { register as registerSystem } from './routes/system.js';
import { register as registerEntities } from './routes/entities.js';
import { register as registerAdjustments } from './routes/adjustments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE = 'absoft_session';

const router = new Router();

/* ---------------------------------------------------------------- auth ---- */

router.post('/api/auth/login', async (ctx) => {
  const result = login(ctx.body.username, ctx.body.password);
  if (!result) throw new HttpError(401, 'Wrong username or password', 'BAD_LOGIN');
  ctx.res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${14 * 24 * 3600}`,
  );
  return { user: result.user, settings: getSettings(), version: VERSION, restart_needed: diskVersion() !== VERSION };
});

router.post('/api/auth/logout', (ctx) => {
  logout(ctx.token);
  ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return { ok: true };
});

router.get('/api/auth/me', (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'Not signed in', 'NOT_SIGNED_IN');
  // The files were updated but this process still runs the old code.
  return { user: ctx.user, settings: getSettings(), version: VERSION, restart_needed: diskVersion() !== VERSION };
});

registerProducts(router);
registerPurchases(router);
registerSales(router);
registerExpenses(router);
registerReports(router);
registerUsers(router);
registerSystem(router);
registerEntities(router);
registerAdjustments(router);

/* -------------------------------------------------------------- server ---- */

const PUBLIC_ROUTES = new Set(['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me']);

/**
 * A cashier works the till: find products, sell, take payments on invoices and
 * look sales up. Everything else is administrator work. Some routes here still
 * refuse cashiers inside their handler (voiding a sale, removing a payment) with
 * a message of their own.
 */
const CASHIER_ROUTES = new Set([
  'GET /api/products',
  'GET /api/products/lookup',
  'GET /api/products/:id/image',
  'GET /api/sales',
  'GET /api/sales/:id',
  'POST /api/sales',
  'DELETE /api/sales/:id',
  'POST /api/sales/:id/payments',
  'DELETE /api/payments/:id',
  'GET /api/entities/:kind',
  'GET /api/settings',
  'GET /api/system',
  'POST /api/me/password',
]);

// What things cost and what they earn stays with administrators.
const COST_FIELDS = new Set(['cost', 'unit_cost', 'stock_value', 'margin', 'cogs', 'profit']);
function withoutCosts(value) {
  if (Array.isArray(value)) return value.map(withoutCosts);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!COST_FIELDS.has(k)) out[k] = withoutCosts(v);
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      const route = router.match(req.method, pathname);
      if (!route) throw notFound(`No API route for ${req.method} ${pathname}`, 'NO_ROUTE');

      const token = parseCookies(req.headers.cookie).absoft_session;
      const user = userFromToken(token);
      if (!user && !PUBLIC_ROUTES.has(`${req.method} ${pathname}`)) {
        throw new HttpError(401, 'Your session has expired — please sign in again', 'SESSION_EXPIRED');
      }
      const cashier = user && user.role !== 'admin';
      if (cashier && !CASHIER_ROUTES.has(`${req.method} ${route.pattern}`)) {
        throw forbidden('Administrator access required', 'ADMIN_ONLY');
      }

      const ctx = {
        req,
        res,
        user,
        token,
        params: route.params,
        query: Object.fromEntries(url.searchParams),
        body: req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req),
      };
      const result = await route.handler(ctx);
      const payload = cashier ? withoutCosts(result) : result;
      // Streaming handlers (the backup download) write their own head and body.
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, payload ?? { ok: true });
      return;
    }

    // Static assets, with the SPA shell as the fallback for client-side routes.
    if (await serveStatic(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname)) return;
    if (!pathname.includes('.') && (await serveStatic(res, PUBLIC_DIR, 'index.html'))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[ABSoft POS] ${req.method} ${pathname}`, err);
    if (!res.headersSent && !res.writableEnded) {
      // `code`/`params` let the browser show this message in the user's language.
      sendJson(res, status, {
        error: err.message || 'Server error',
        code: err.code || null,
        params: err.params || null,
      });
    }
  }
});

const seeded = ensureSeedAdmin();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM products`).get();
  console.log('');
  // ASCII only: the Windows console runs in an OEM codepage and mangles the rest.
  console.log(`  ABSoft POS v${VERSION}  -  developed by Abbass Chokor`);
  console.log(`  ------------------------------------------`);
  console.log(`  Running at   http://${HOST}:${PORT}`);
  console.log(`  Database     ${DB_FILE}  (schema v${currentVersion(db)})`);
  console.log(`  Products     ${n}`);
  if (seeded) console.log(`  First login  ${seeded.username} / ${seeded.password}  (change this)`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    try {
      db.close();
    } catch {
      /* nothing to close */
    }
    process.exit(0);
  });
}
