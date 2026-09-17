import { db } from './db.js';
import { getEntity } from './entities.js';
import { badRequest, notFound } from './http.js';
import { money, num, qty, str, today } from './util.js';

/**
 * A customer's or supplier's own page: where they stand, and every document
 * behind it. Documents store the name as text (see entities.js), so everything
 * here is matched by name, ignoring capitalisation.
 *
 * A customer owes what their invoices come to less what they have paid. A
 * supplier's purchases carry no payments, so their page adds up what was bought.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function loadParty(kind, id) {
  if (kind !== 'customer' && kind !== 'supplier') {
    throw badRequest('Only customers and suppliers have a statement', 'PARTY_KIND', { kind });
  }
  const entity = getEntity(num(id));
  if (!entity || entity.kind !== kind) throw notFound('Entry not found', 'ENTITY_NOT_FOUND');
  return entity;
}

/** The window of a statement. Without dates it runs from the first document to today. */
function statementRange(query, first) {
  let from = DATE.test(str(query.from)) ? str(query.from) : first || today();
  let to = DATE.test(str(query.to)) ? str(query.to) : today();
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

export function partySummary(kind, id) {
  const entity = loadParty(kind, id);
  if (kind === 'customer') {
    const s = db
      .prepare(
        `SELECT COUNT(*) AS invoices,
                ROUND(COALESCE(SUM(total), 0), 2) AS total,
                ROUND(COALESCE(SUM(paid), 0), 2) AS paid,
                ROUND(COALESCE(SUM(total - paid), 0), 2) AS balance,
                ROUND(COALESCE(SUM(total - tax - cogs), 0), 2) AS profit,
                ROUND(COALESCE(SUM(total - tax), 0), 2) AS revenue,
                COALESCE(SUM(CASE WHEN ROUND(total - paid, 2) > 0.005 THEN 1 ELSE 0 END), 0) AS open_invoices,
                MIN(date) AS first_date, MAX(date) AS last_date
         FROM sales WHERE customer = ? COLLATE NOCASE`,
      )
      .get(entity.name);
    const lastPayment = db
      .prepare(
        `SELECT p.date, p.amount FROM payments p JOIN sales s ON s.id = p.sale_id
         WHERE s.customer = ? COLLATE NOCASE ORDER BY p.date DESC, p.id DESC LIMIT 1`,
      )
      .get(entity.name);
    return {
      entity,
      summary: {
        ...s,
        margin: s.revenue > 0 ? Math.round((s.profit / s.revenue) * 1000) / 10 : 0,
        avg_invoice: s.invoices ? money(s.total / s.invoices) : 0,
        last_payment: lastPayment || null,
      },
    };
  }
  const s = db
    .prepare(
      `SELECT COUNT(*) AS purchases,
              ROUND(COALESCE(SUM(total), 0), 2) AS total,
              MIN(date) AS first_date, MAX(date) AS last_date,
              (SELECT COUNT(DISTINCT i.product_id) FROM purchase_items i JOIN purchases x ON x.id = i.purchase_id
               WHERE x.supplier = ? COLLATE NOCASE) AS items
       FROM purchases WHERE supplier = ? COLLATE NOCASE`,
    )
    .get(entity.name, entity.name);
  return { entity, summary: { ...s, avg_purchase: s.purchases ? money(s.total / s.purchases) : 0 } };
}

/**
 * The statement: a balance brought forward, then every invoice and payment (or
 * every purchase) in date order, with the running balance after each.
 */
export function partyStatement(kind, id, query) {
  const { entity, summary } = partySummary(kind, id);
  const { from, to } = statementRange(query, summary.first_date);
  const name = entity.name;

  if (kind === 'customer') {
    const opening = money(
      num(db.prepare(`SELECT SUM(total) AS v FROM sales WHERE customer = ? COLLATE NOCASE AND date < ?`).get(name, from).v) -
        num(
          db
            .prepare(
              `SELECT SUM(p.amount) AS v FROM payments p JOIN sales s ON s.id = p.sale_id
               WHERE s.customer = ? COLLATE NOCASE AND p.date < ?`,
            )
            .get(name, from).v,
        ),
    );
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT 'invoice' AS type, s.id AS sale_id, s.doc_no, s.date, s.total AS debit, 0 AS credit,
                  s.method, s.created_at AS at, s.id AS seq
           FROM sales s WHERE s.customer = ? COLLATE NOCASE AND s.date BETWEEN ? AND ?
           UNION ALL
           SELECT 'payment', s.id, s.doc_no, p.date, 0, p.amount, p.method, p.created_at, p.id
           FROM payments p JOIN sales s ON s.id = p.sale_id
           WHERE s.customer = ? COLLATE NOCASE AND p.date BETWEEN ? AND ?
         )
         -- In the order they happened; a payment taken at the till follows its own invoice.
         ORDER BY date, at, sale_id, CASE type WHEN 'invoice' THEN 0 ELSE 1 END, seq
         LIMIT 10000`,
      )
      .all(name, from, to, name, from, to);
    let balance = opening;
    const entries = rows.map(({ at, seq, ...r }) => {
      balance = money(balance + num(r.debit) - num(r.credit));
      return { ...r, balance };
    });
    const debit = money(entries.reduce((a, e) => a + num(e.debit), 0));
    const credit = money(entries.reduce((a, e) => a + num(e.credit), 0));
    return { entity, from, to, opening, debit, credit, closing: money(opening + debit - credit), entries };
  }

  const opening = money(
    num(db.prepare(`SELECT SUM(total) AS v FROM purchases WHERE supplier = ? COLLATE NOCASE AND date < ?`).get(name, from).v),
  );
  const rows = db
    .prepare(
      `SELECT 'purchase' AS type, pu.id AS purchase_id, pu.doc_no, pu.date, pu.total AS debit, 0 AS credit,
              (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS lines, pu.note
       FROM purchases pu WHERE pu.supplier = ? COLLATE NOCASE AND pu.date BETWEEN ? AND ?
       ORDER BY pu.date, pu.id LIMIT 10000`,
    )
    .all(name, from, to);
  let balance = opening;
  const entries = rows.map((r) => {
    balance = money(balance + num(r.debit));
    return { ...r, balance };
  });
  const debit = money(entries.reduce((a, e) => a + num(e.debit), 0));
  return { entity, from, to, opening, debit, credit: 0, closing: money(opening + debit), entries };
}

/** What a supplier sold us, product by product. (A customer's items come from the sales analysis.) */
export function supplierItems(id, query) {
  const { entity, summary } = partySummary('supplier', id);
  const { from, to } = statementRange(query, summary.first_date);
  const rows = db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.barcode, p.category, p.unit,
              ROUND(SUM(i.qty), 3) AS qty, ROUND(SUM(i.total), 2) AS total,
              COUNT(DISTINCT pu.id) AS purchases, MAX(pu.date) AS last_date,
              (SELECT i2.unit_cost FROM purchase_items i2 JOIN purchases p2 ON p2.id = i2.purchase_id
               WHERE i2.product_id = p.id AND p2.supplier = ? COLLATE NOCASE
               ORDER BY p2.date DESC, i2.id DESC LIMIT 1) AS last_cost
       FROM purchase_items i
       JOIN purchases pu ON pu.id = i.purchase_id
       JOIN products p ON p.id = i.product_id
       WHERE pu.supplier = ? COLLATE NOCASE AND pu.date BETWEEN ? AND ?
       GROUP BY p.id ORDER BY total DESC, p.name COLLATE NOCASE`,
    )
    .all(entity.name, entity.name, from, to)
    .map((r) => ({ ...r, avg_cost: r.qty ? money(r.total / r.qty) : 0 }));
  return {
    from,
    to,
    rows,
    totals: { qty: qty(rows.reduce((a, r) => a + r.qty, 0)), total: money(rows.reduce((a, r) => a + r.total, 0)) },
  };
}
