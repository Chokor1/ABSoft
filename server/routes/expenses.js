import { db, lastId } from '../db.js';
import { canonicalName, listEntities, rememberEntity } from '../entities.js';
import { badRequest, notFound } from '../http.js';
import { isoDate, money, num, pageParams, pageResult, str } from '../util.js';

const SELECT = `SELECT e.*, u.username FROM expenses e LEFT JOIN users u ON u.id = e.user_id`;

export function register(router) {
  router.get('/api/expenses', (ctx) => {
    const where = [];
    const args = [];
    if (str(ctx.query.from)) (where.push('e.date >= ?'), args.push(str(ctx.query.from)));
    if (str(ctx.query.to)) (where.push('e.date <= ?'), args.push(str(ctx.query.to)));
    if (str(ctx.query.category)) (where.push('e.category = ?'), args.push(str(ctx.query.category)));
    if (str(ctx.query.search)) {
      where.push('(e.note LIKE ? OR e.category LIKE ?)');
      const like = `%${str(ctx.query.search)}%`;
      args.push(like, like);
    }
    if (str(ctx.query.method)) (where.push('e.method = ?'), args.push(str(ctx.query.method)));
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const paging = pageParams(ctx.query, { per: 50 });
    if (paging) {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM expenses e ${clause}`).get(...args).n;
      const rows = db
        .prepare(`${SELECT} ${clause} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`)
        .all(...args, paging.per, paging.offset);
      // The breakdown beside the list covers the whole period, not just this page.
      const byCategory = db
        .prepare(`SELECT e.category, ROUND(SUM(e.amount), 2) AS amount FROM expenses e ${clause} GROUP BY e.category ORDER BY amount DESC`)
        .all(...args);
      const sums = db.prepare(`SELECT ROUND(COALESCE(SUM(e.amount), 0), 2) AS total FROM expenses e ${clause}`).get(...args);
      return { ...pageResult(rows, total, paging), sums, byCategory };
    }
    return db
      .prepare(`${SELECT} ${clause} ORDER BY e.date DESC, e.id DESC LIMIT ${Math.min(1000, num(ctx.query.limit, 300))}`)
      .all(...args);
  });

  router.get('/api/expenses/:id', (ctx) => {
    const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(ctx.params.id);
    if (!row) throw notFound('Expense not found', 'EXPENSE_NOT_FOUND');
    return row;
  });

  router.post('/api/expenses', (ctx) => {
    const amount = money(num(ctx.body.amount));
    if (!(amount > 0)) throw badRequest('Expense amount must be greater than zero', 'EXPENSE_POSITIVE');
    const category = canonicalName('expense_category', str(ctx.body.category) || 'General');
    const res = db
      .prepare(`INSERT INTO expenses (date, category, note, amount, method, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        isoDate(ctx.body.date),
        category,
        str(ctx.body.note),
        amount,
        str(ctx.body.method) || 'cash',
        ctx.user.id,
      );
    rememberEntity('expense_category', category);
    return db.prepare(`${SELECT} WHERE e.id = ?`).get(lastId(res));
  });

  router.put('/api/expenses/:id', (ctx) => {
    const existing = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(ctx.params.id);
    if (!existing) throw notFound('Expense not found', 'EXPENSE_NOT_FOUND');
    const amount = ctx.body.amount === undefined ? existing.amount : money(num(ctx.body.amount));
    if (!(amount > 0)) throw badRequest('Expense amount must be greater than zero', 'EXPENSE_POSITIVE');
    const category = canonicalName(
      'expense_category',
      ctx.body.category === undefined ? existing.category : str(ctx.body.category) || 'General',
    );
    db.prepare(`UPDATE expenses SET date = ?, category = ?, note = ?, amount = ?, method = ? WHERE id = ?`).run(
      ctx.body.date === undefined ? existing.date : isoDate(ctx.body.date),
      category,
      ctx.body.note === undefined ? existing.note : str(ctx.body.note),
      amount,
      ctx.body.method === undefined ? existing.method : str(ctx.body.method) || 'cash',
      existing.id,
    );
    rememberEntity('expense_category', category);
    return db.prepare(`${SELECT} WHERE e.id = ?`).get(existing.id);
  });

  router.delete('/api/expenses/:id', (ctx) => {
    const res = db.prepare(`DELETE FROM expenses WHERE id = ?`).run(ctx.params.id);
    if (!res.changes) throw notFound('Expense not found', 'EXPENSE_NOT_FOUND');
    return { deleted: true };
  });

  // From the directory, most-used first. The browser adds its own translated
  // starter suggestions on top, so defaults are never stored in one fixed language.
  router.get('/api/expense-categories', () => listEntities('expense_category').map((e) => e.name));
}
