import { db, lastId } from '../db.js';
import { notFound } from '../http.js';
import { badRequest } from '../http.js';
import { isoDate, money, num, str } from '../util.js';

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
    const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY e.date DESC, e.id DESC LIMIT ${Math.min(1000, num(ctx.query.limit, 300))}`;
    return db.prepare(sql).all(...args);
  });

  router.post('/api/expenses', (ctx) => {
    const amount = money(num(ctx.body.amount));
    if (!(amount > 0)) throw badRequest('Expense amount must be greater than zero', 'EXPENSE_POSITIVE');
    const res = db
      .prepare(`INSERT INTO expenses (date, category, note, amount, method, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        isoDate(ctx.body.date),
        str(ctx.body.category) || 'General',
        str(ctx.body.note),
        amount,
        str(ctx.body.method) || 'cash',
        ctx.user.id,
      );
    return db.prepare(`${SELECT} WHERE e.id = ?`).get(lastId(res));
  });

  router.put('/api/expenses/:id', (ctx) => {
    const existing = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(ctx.params.id);
    if (!existing) throw notFound('Expense not found', 'EXPENSE_NOT_FOUND');
    const amount = ctx.body.amount === undefined ? existing.amount : money(num(ctx.body.amount));
    if (!(amount > 0)) throw badRequest('Expense amount must be greater than zero', 'EXPENSE_POSITIVE');
    db.prepare(`UPDATE expenses SET date = ?, category = ?, note = ?, amount = ?, method = ? WHERE id = ?`).run(
      ctx.body.date === undefined ? existing.date : isoDate(ctx.body.date),
      ctx.body.category === undefined ? existing.category : str(ctx.body.category) || 'General',
      ctx.body.note === undefined ? existing.note : str(ctx.body.note),
      amount,
      ctx.body.method === undefined ? existing.method : str(ctx.body.method) || 'cash',
      existing.id,
    );
    return db.prepare(`${SELECT} WHERE e.id = ?`).get(existing.id);
  });

  router.delete('/api/expenses/:id', (ctx) => {
    const res = db.prepare(`DELETE FROM expenses WHERE id = ?`).run(ctx.params.id);
    if (!res.changes) throw notFound('Expense not found', 'EXPENSE_NOT_FOUND');
    return { deleted: true };
  });

  // Only the categories actually in use — the browser adds its own translated
  // suggestions on top, so the defaults are never stored in one fixed language.
  router.get('/api/expense-categories', () =>
    db
      .prepare(`SELECT DISTINCT category FROM expenses WHERE category <> '' ORDER BY category`)
      .all()
      .map((r) => r.category),
  );
}
