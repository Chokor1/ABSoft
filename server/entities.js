import { db, lastId } from './db.js';
import { badRequest, notFound } from './http.js';
import { pageResult, required, str } from './util.js';

/**
 * Reusable names: customers, suppliers, product categories, units, expense categories.
 *
 * The documents themselves keep storing plain text — a sale still has a `customer`
 * column holding "Ahmad Store". This table is a *directory* that fills itself in as
 * you work: type a name once on an invoice and it is remembered, so next time you can
 * pick it instead of retyping. Nothing is ever required, and an unrecognised name is
 * simply a new entry rather than an error.
 *
 * Keeping the text on the document also means reports, exports and historic invoices
 * are completely unaffected by anything here.
 */
export const ENTITY_KINDS = {
  customer: { table: 'sales', column: 'customer', contact: true },
  supplier: { table: 'purchases', column: 'supplier', contact: true },
  category: { table: 'products', column: 'category', contact: false },
  unit: { table: 'products', column: 'unit', contact: false },
  expense_category: { table: 'expenses', column: 'category', contact: false },
  // How people pay is written on sales, on each payment and on expenses alike.
  payment_method: {
    table: 'sales',
    column: 'method',
    contact: false,
    icon: true,
    also: [
      ['payments', 'method'],
      ['expenses', 'method'],
    ],
  },
};

/** Every table and column a kind's name is written in. */
const targetsOf = (kind) => [[ENTITY_KINDS[kind].table, ENTITY_KINDS[kind].column], ...(ENTITY_KINDS[kind].also || [])];

export const isKind = (kind) => Object.hasOwn(ENTITY_KINDS, kind);

function assertKind(kind) {
  if (!isKind(kind)) throw badRequest(`Unknown list "${kind}"`, 'UNKNOWN_KIND', { kind });
  return kind;
}

/**
 * Resolve what should actually be written on the document.
 *
 * If the directory already knows this name in a different capitalisation, the
 * stored spelling wins — so a cashier typing "ahmad store" produces an invoice
 * reading "Ahmad Store". Without this, documents drift into several spellings of
 * one customer, which then breaks grouping, counting and renaming.
 *
 * An unknown name is returned untouched: it is simply a new entry.
 */
export function canonicalName(kind, name) {
  const value = str(name);
  if (!value || !isKind(kind)) return value;
  // entities.name is COLLATE NOCASE, so this lookup ignores capitalisation.
  const known = db.prepare(`SELECT name FROM entities WHERE kind = ? AND name = ?`).get(kind, value);
  return known ? known.name : value;
}

/**
 * Record a name typed on a document. Called on every save, so it must stay cheap
 * and must never fail the save it is attached to — a directory entry is a
 * convenience, not part of the transaction's meaning.
 */
export function rememberEntity(kind, name) {
  const value = str(name);
  if (!value || !isKind(kind)) return null;
  try {
    db.prepare(`INSERT OR IGNORE INTO entities (kind, name) VALUES (?, ?)`).run(kind, value);
    // Bump usage so the most-used names can float to the top of suggestions.
    db.prepare(
      `UPDATE entities SET used_count = used_count + 1, last_used_at = datetime('now')
       WHERE kind = ? AND name = ?`,
    ).run(kind, value);
    return value;
  } catch {
    return value; // never let bookkeeping break a sale
  }
}

/** Remember several fields at once, e.g. a product's category and unit. */
export const rememberAll = (pairs) => pairs.forEach(([kind, name]) => rememberEntity(kind, name));

// COLLATE NOCASE throughout: documents written before the directory existed may
// hold any capitalisation, and they should still be counted against their entry.
const SELECT = `
  SELECT e.*,
         (SELECT COUNT(*) FROM sales     s WHERE e.kind = 'customer'         AND s.customer = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM purchases p WHERE e.kind = 'supplier'         AND p.supplier = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM products  r WHERE e.kind = 'category'         AND r.category = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM products  u WHERE e.kind = 'unit'             AND u.unit     = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM expenses  x WHERE e.kind = 'expense_category' AND x.category = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM sales     m WHERE e.kind = 'payment_method'   AND m.method   = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM payments  y WHERE e.kind = 'payment_method'   AND y.method   = e.name COLLATE NOCASE)
       + (SELECT COUNT(*) FROM expenses  z WHERE e.kind = 'payment_method'   AND z.method   = e.name COLLATE NOCASE)
       AS in_use
  FROM entities e`;

export function listEntities(kind, { search = '', all = false, page = null } = {}) {
  assertKind(kind);
  const where = ['e.kind = ?'];
  const args = [kind];
  if (!all) where.push('e.active = 1');
  if (str(search)) {
    where.push('(e.name LIKE ? OR e.phone LIKE ? OR e.email LIKE ? OR e.note LIKE ?)');
    const like = `%${str(search)}%`;
    args.push(like, like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const order = 'ORDER BY e.used_count DESC, e.name COLLATE NOCASE';
  // Without paging this answers as it always has: every name, for the pickers.
  if (!page) return db.prepare(`${SELECT} ${clause} ${order}`).all(...args);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM entities e ${clause}`).get(...args).n;
  const rows = db.prepare(`${SELECT} ${clause} ${order} LIMIT ? OFFSET ?`).all(...args, page.per, page.offset);
  return pageResult(rows, total, page);
}

export const getEntity = (id) => db.prepare(`${SELECT} WHERE e.id = ?`).get(id);

// An icon is either the name of one the app draws, or a small uploaded logo.
const MAX_LOGO = 80 * 1024;
function readIcon(value) {
  const icon = str(value);
  if (!icon.startsWith('data:')) return icon.slice(0, 40);
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(icon)) {
    throw badRequest('Use a PNG, JPEG or WebP logo', 'LOGO_TYPE');
  }
  if (icon.length > MAX_LOGO) throw badRequest('That logo is too large', 'LOGO_TOO_LARGE');
  return icon;
}

function readPayload(body) {
  return {
    name: required(body.name, 'Name', 'name'),
    icon: readIcon(body.icon),
    phone: str(body.phone),
    email: str(body.email),
    address: str(body.address),
    tax_id: str(body.tax_id),
    note: str(body.note),
    active: body.active === false ? 0 : 1,
  };
}

export function createEntity(kind, body) {
  assertKind(kind);
  const data = readPayload(body);
  const clash = db.prepare(`SELECT id FROM entities WHERE kind = ? AND name = ?`).get(kind, data.name);
  if (clash) throw badRequest(`"${data.name}" is already in this list`, 'ENTITY_EXISTS', { name: data.name });
  const res = db
    .prepare(
      `INSERT INTO entities (kind, name, phone, email, address, tax_id, note, active, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kind, data.name, data.phone, data.email, data.address, data.tax_id, data.note, data.active, data.icon);
  return getEntity(lastId(res));
}

/**
 * Renaming also rewrites the documents that used the old name.
 *
 * That is deliberate: these names are stored as text, so a typo fixed here should
 * disappear everywhere it was recorded. It is what someone correcting "Ahmd Store"
 * expects, and it keeps the directory and the documents from drifting apart.
 */
export function updateEntity(id, body) {
  const existing = getEntity(id);
  if (!existing) throw notFound('Entry not found', 'ENTITY_NOT_FOUND');
  const data = readPayload(body);

  if (data.name !== existing.name) {
    // Cash and On account are written into every report and receipt; they can be
    // switched off, but not renamed into something the app no longer recognises.
    if (existing.builtin) throw badRequest('This entry cannot be renamed', 'BUILTIN_ENTRY', { name: existing.name });
    const clash = db
      .prepare(`SELECT id FROM entities WHERE kind = ? AND name = ? AND id <> ?`)
      .get(existing.kind, data.name, existing.id);
    if (clash) throw badRequest(`"${data.name}" is already in this list`, 'ENTITY_EXISTS', { name: data.name });
    for (const [table, column] of targetsOf(existing.kind)) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ? COLLATE NOCASE`).run(data.name, existing.name);
    }
  }

  db.prepare(
    `UPDATE entities SET name = ?, phone = ?, email = ?, address = ?, tax_id = ?, note = ?, active = ?, icon = ?
     WHERE id = ?`,
  ).run(data.name, data.phone, data.email, data.address, data.tax_id, data.note, data.active, data.icon, existing.id);
  return getEntity(existing.id);
}

/** Removing a directory entry never touches the documents that referenced it. */
export function deleteEntity(id) {
  const existing = getEntity(id);
  if (!existing) throw notFound('Entry not found', 'ENTITY_NOT_FOUND');
  if (existing.builtin) throw badRequest('This entry cannot be removed — switch it off instead', 'BUILTIN_ENTRY', { name: existing.name });
  db.prepare(`DELETE FROM entities WHERE id = ?`).run(existing.id);
  return { deleted: true, in_use: existing.in_use };
}
