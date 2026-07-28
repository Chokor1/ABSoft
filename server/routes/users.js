import { db, getSettings, saveSettings } from '../db.js';
import { createUser, hashPassword, publicUser, verifyPassword } from '../auth.js';
import { badRequest, forbidden, notFound } from '../http.js';
import { required, str } from '../util.js';

const ROLES = new Set(['admin', 'cashier']);

const adminOnly = (ctx) => {
  if (ctx.user.role !== 'admin') throw forbidden('Administrator access required', 'ADMIN_ONLY');
};

export function register(router) {
  router.get('/api/users', (ctx) => {
    adminOnly(ctx);
    return db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM sales s WHERE s.user_id = u.id) AS sales_count
         FROM users u ORDER BY u.username`,
      )
      .all()
      .map((u) => ({ ...publicUser(u), sales_count: u.sales_count }));
  });

  router.post('/api/users', (ctx) => {
    adminOnly(ctx);
    const username = required(ctx.body.username, 'Username', 'username');
    const password = required(ctx.body.password, 'Password', 'password');
    if (password.length < 4) throw badRequest('Password must be at least 4 characters', 'PASSWORD_SHORT');
    if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(username)) {
      throw badRequest(`Username "${username}" is already taken`, 'USERNAME_TAKEN', { username });
    }
    const role = ROLES.has(str(ctx.body.role)) ? str(ctx.body.role) : 'cashier';
    const id = createUser({ username, password, full_name: str(ctx.body.full_name), role });
    return publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
  });

  router.put('/api/users/:id', (ctx) => {
    adminOnly(ctx);
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(ctx.params.id);
    if (!user) throw notFound('User not found', 'USER_NOT_FOUND');

    const role = ROLES.has(str(ctx.body.role)) ? str(ctx.body.role) : user.role;
    const active = ctx.body.active === undefined ? user.active : ctx.body.active ? 1 : 0;
    // Never let the last usable administrator lock everyone out.
    if ((role !== 'admin' || !active) && user.role === 'admin') {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get();
      if (n <= 1) throw badRequest('At least one active administrator must remain', 'LAST_ADMIN');
    }

    db.prepare(`UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?`).run(
      ctx.body.full_name === undefined ? user.full_name : str(ctx.body.full_name),
      role,
      active,
      user.id,
    );

    if (str(ctx.body.password)) {
      if (str(ctx.body.password).length < 4) throw badRequest('Password must be at least 4 characters', 'PASSWORD_SHORT');
      const { hash, salt } = hashPassword(str(ctx.body.password));
      db.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`).run(hash, salt, user.id);
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(user.id);
    }
    return publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id));
  });

  router.delete('/api/users/:id', (ctx) => {
    adminOnly(ctx);
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(ctx.params.id);
    if (!user) throw notFound('User not found', 'USER_NOT_FOUND');
    if (user.id === ctx.user.id) throw badRequest('You cannot delete your own account', 'DELETE_SELF');
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE user_id = ?`).get(user.id);
    if (n > 0) {
      db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(user.id);
      return { archived: true };
    }
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    return { deleted: true };
  });

  // Any signed-in user may change their own password.
  router.post('/api/me/password', (ctx) => {
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(ctx.user.id);
    if (!verifyPassword(str(ctx.body.current_password), row.salt, row.password_hash)) {
      throw badRequest('Current password is incorrect', 'WRONG_PASSWORD');
    }
    const next = required(ctx.body.new_password, 'New password', 'new_password');
    if (next.length < 4) throw badRequest('Password must be at least 4 characters', 'PASSWORD_SHORT');
    const { hash, salt } = hashPassword(next);
    db.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`).run(hash, salt, row.id);
    return { ok: true };
  });

  router.get('/api/settings', () => getSettings());

  router.put('/api/settings', (ctx) => {
    adminOnly(ctx);
    const allowed = ['store_name', 'currency', 'tax_rate', 'low_stock_alert', 'receipt_footer'];
    const patch = {};
    for (const key of allowed) if (ctx.body[key] !== undefined) patch[key] = str(ctx.body[key]);
    return saveSettings(patch);
  });
}
