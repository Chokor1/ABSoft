import { db, getSettings, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, nextDocNo, num, pageParams, pageResult, str } from '../util.js';

/**
 * Shifts at the till: a shift is opened with the cash already in the drawer and
 * closed by counting it. Every sale and every payment taken while it is open
 * belongs to it, so closing shows what the drawer should hold and what it does.
 *
 * Switched on in Settings → POS. Off, the till sells as it always has.
 */

export const shiftsEnabled = () => getSettings().pos_shifts === '1';

/** The shift open right now, if any. One till, one drawer: one shift at a time. */
export const openShift = () =>
  db.prepare(`SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`).get() || null;

/** The shop's own clock, so a shift reads 08:00 when it was opened at 08:00. */
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/** What a shift has taken, by way of payment, and what the drawer should hold. */
function shiftTotals(shift) {
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(total), 0), 2) AS total,
              ROUND(COALESCE(SUM(total - paid), 0), 2) AS owed
       FROM sales WHERE shift_id = ?`,
    )
    .get(shift.id);
  const payments = db
    .prepare(
      `SELECT method, currency, COUNT(*) AS n,
              ROUND(SUM(amount), 2) AS amount, ROUND(SUM(COALESCE(amount2, 0)), 2) AS amount2
       FROM payments WHERE shift_id = ?
       GROUP BY method, currency ORDER BY amount DESC`,
    )
    .all(shift.id);
  const cashIn = money(payments.filter((p) => p.method === 'cash' && p.currency !== 'second').reduce((a, p) => a + p.amount, 0));
  const cashIn2 = money(payments.filter((p) => p.method === 'cash' && p.currency === 'second').reduce((a, p) => a + p.amount2, 0));
  // Every way of paying other than cash — the card terminal, Whish, OMT… — kept
  // in the currency it was taken in, because that is how it will be counted.
  const others = new Map();
  for (const p of payments) {
    if (p.method === 'cash') continue;
    const row = others.get(p.method) || { method: p.method, n: 0, expected: 0, expected2: 0 };
    row.n += p.n;
    if (p.currency === 'second') row.expected2 = money(row.expected2 + p.amount2);
    else row.expected = money(row.expected + p.amount);
    others.set(p.method, row);
  }
  return {
    sales: num(sales.n),
    sales_total: num(sales.total),
    on_account: num(sales.owed),
    payments,
    others: [...others.values()],
    taken: money(payments.reduce((a, p) => a + p.amount, 0)),
    // What came in through the second currency, whatever way it was paid.
    taken2: money(payments.filter((p) => p.currency === 'second').reduce((a, p) => a + p.amount2, 0)),
    cash_in: cashIn,
    cash_in2: cashIn2,
    expected_cash: money(num(shift.opening_cash) + cashIn),
    expected_cash2: money(num(shift.opening_cash2) + cashIn2),
  };
}

const SELECT = `
  SELECT s.*, uo.username AS opened_by_name, uc.username AS closed_by_name
  FROM shifts s
  LEFT JOIN users uo ON uo.id = s.opened_by
  LEFT JOIN users uc ON uc.id = s.closed_by`;

export function loadShift(id) {
  const shift = db.prepare(`${SELECT} WHERE s.id = ?`).get(id);
  if (!shift) return null;
  const totals = shiftTotals(shift);
  const closed = !!shift.closed_at;
  // A closed shift keeps what was expected when it was counted, whatever happens after.
  const expected = closed ? num(shift.expected_cash) : totals.expected_cash;
  const expected2 = closed ? num(shift.expected_cash2) : totals.expected_cash2;
  let counts = {};
  try {
    counts = JSON.parse(shift.counted_methods || '{}') || {};
  } catch {
    /* an unreadable count reads as none */
  }
  // A closed shift shows each method's count; one not counted was taken as expected.
  const others = totals.others.map((o) => {
    if (!closed) return { ...o, counted: null, counted2: null, difference: null, difference2: null };
    // Older shifts kept one number per method; newer ones keep one per currency.
    const kept = counts[o.method];
    const pair = kept !== null && typeof kept === 'object' ? kept : { main: kept };
    const counted = pair.main === undefined || pair.main === null ? o.expected : num(pair.main);
    const counted2 = pair.second === undefined || pair.second === null ? o.expected2 : num(pair.second);
    return {
      ...o,
      counted,
      counted2,
      difference: money(counted - o.expected),
      difference2: money(counted2 - o.expected2),
    };
  });
  return {
    ...shift,
    status: closed ? 'closed' : 'open',
    ...totals,
    expected_cash: expected,
    expected_cash2: expected2,
    difference: closed ? money(num(shift.counted_cash) - expected) : null,
    difference2: closed ? money(num(shift.counted_cash2) - expected2) : null,
    others,
    // Cash and every other method together, each currency on its own: a drawer
    // short 5,000 L.L has not lost $5.
    difference_total: closed
      ? money(num(shift.counted_cash) - expected + others.reduce((a, o) => a + o.difference, 0))
      : null,
    difference2_total: closed
      ? money(num(shift.counted_cash2) - expected2 + others.reduce((a, o) => a + o.difference2, 0))
      : null,
  };
}

export function register(router) {
  router.get('/api/shifts/current', () => {
    const shift = openShift();
    return { enabled: shiftsEnabled(), shift: shift ? loadShift(shift.id) : null };
  });

  router.post('/api/shifts/open', (ctx) => {
    if (!shiftsEnabled()) throw badRequest('Shifts are switched off in Settings', 'SHIFTS_OFF');
    const open = openShift();
    if (open) throw badRequest(`Shift ${open.doc_no} is still open`, 'SHIFT_OPEN', { doc: open.doc_no });
    const cash = money(Math.max(0, num(ctx.body.opening_cash)));
    const cash2 = money(Math.max(0, num(ctx.body.opening_cash2)));
    return transact(() => {
      const res = db
        .prepare(
          `INSERT INTO shifts (doc_no, opened_by, opened_at, opening_cash, opening_cash2, opening_note)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(nextDocNo(db, 'shifts', 'SH'), ctx.user.id, localNow(), cash, cash2, str(ctx.body.note));
      return loadShift(lastId(res));
    });
  });

  router.post('/api/shifts/:id/close', (ctx) => {
    const shift = loadShift(ctx.params.id);
    if (!shift) throw notFound('Shift not found', 'SHIFT_NOT_FOUND');
    if (shift.status === 'closed') throw badRequest(`Shift ${shift.doc_no} is already closed`, 'SHIFT_CLOSED', { doc: shift.doc_no });
    const counted = money(Math.max(0, num(ctx.body.counted_cash)));
    const counted2 = money(Math.max(0, num(ctx.body.counted_cash2)));
    // What was counted for each other method; one left out counts as expected.
    const sent = ctx.body.counted && typeof ctx.body.counted === 'object' ? ctx.body.counted : {};
    const counts = {};
    for (const o of shift.others) {
      const given = sent[o.method];
      const pair = given !== null && typeof given === 'object' ? given : { main: given };
      const pick = (value, fallback) =>
        value === undefined || value === null || value === '' ? fallback : money(Math.max(0, num(value)));
      counts[o.method] = { main: pick(pair.main, o.expected), second: pick(pair.second, o.expected2) };
    }
    db.prepare(
      `UPDATE shifts SET closed_by = ?, closed_at = ?, expected_cash = ?, expected_cash2 = ?,
                         counted_cash = ?, counted_cash2 = ?, counted_methods = ?, closing_note = ?
       WHERE id = ?`,
    ).run(
      ctx.user.id, localNow(), shift.expected_cash, shift.expected_cash2,
      counted, counted2, JSON.stringify(counts), str(ctx.body.note), shift.id,
    );
    return loadShift(shift.id);
  });

  router.get('/api/shifts', (ctx) => {
    const paging = pageParams({ page: str(ctx.query.page) || '1', per: ctx.query.per }, { per: 25 });
    const total = db.prepare(`SELECT COUNT(*) AS n FROM shifts`).get().n;
    const rows = db
      .prepare(`${SELECT} ORDER BY s.id DESC LIMIT ? OFFSET ?`)
      .all(paging.per, paging.offset)
      .map((s) => loadShift(s.id));
    return pageResult(rows, total, paging);
  });

  router.get('/api/shifts/:id', (ctx) => {
    const shift = loadShift(ctx.params.id);
    if (!shift) throw notFound('Shift not found', 'SHIFT_NOT_FOUND');
    const sales = db
      .prepare(
        `SELECT id, doc_no, customer, total, paid, method, datetime(created_at, 'localtime') AS created_at FROM sales
         WHERE shift_id = ? ORDER BY id DESC LIMIT 500`,
      )
      .all(shift.id);
    return { ...shift, sale_list: sales };
  });
}
