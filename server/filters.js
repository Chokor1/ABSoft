import { badRequest } from './http.js';
import { num, str } from './util.js';

/**
 * Filters typed in a list's filter builder: [{ field, op, value }, …], all of
 * which must hold. Every field and operator is looked up in the list's own
 * table of them, and every value is a bound parameter: nothing typed ever
 * becomes SQL.
 *
 *   field types: text  — eq, neq, like, not_like, starts, set, not_set
 *                number — eq, neq, gt, gte, lt, lte
 *                bool   — is (value '1' or '0')
 */

const MAX_FILTERS = 12;

const TEXT_OPS = new Set(['eq', 'neq', 'like', 'not_like', 'starts', 'set', 'not_set']);
const NUMBER_OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// A typed % or _ is looked for as itself, not as a wildcard.
const likeText = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Parse `raw` (a JSON string or an array) against `fields`
 * ({ name: { sql, type } }). Returns { where: [sql…], args: […], fields: [names] }.
 */
export function readFilters(raw, fields) {
  let list = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { where: [], args: [], fields: [] };
    try {
      list = JSON.parse(raw);
    } catch {
      throw badRequest('The filters could not be read', 'FILTER_INVALID');
    }
  }
  if (!Array.isArray(list)) return { where: [], args: [], fields: [] };
  const where = [];
  const args = [];
  const used = [];
  for (const f of list.slice(0, MAX_FILTERS)) {
    const field = fields[str(f?.field)];
    const op = str(f?.op);
    if (!field) throw badRequest('One of the filters names a field that does not exist', 'FILTER_INVALID');
    used.push(str(f.field));
    const value = f.value === undefined || f.value === null ? '' : String(f.value).trim();
    if (field.type === 'text') {
      if (!TEXT_OPS.has(op)) throw badRequest('One of the filters has an operator that does not apply', 'FILTER_INVALID');
      const x = `COALESCE(${field.sql}, '')`;
      if (op === 'set') where.push(`${x} <> ''`);
      else if (op === 'not_set') where.push(`${x} = ''`);
      else if (op === 'eq') (where.push(`${x} = ? COLLATE NOCASE`), args.push(value));
      else if (op === 'neq') (where.push(`${x} <> ? COLLATE NOCASE`), args.push(value));
      else if (op === 'like') (where.push(`${x} LIKE ? ESCAPE '\\'`), args.push(`%${likeText(value)}%`));
      else if (op === 'not_like') (where.push(`${x} NOT LIKE ? ESCAPE '\\'`), args.push(`%${likeText(value)}%`));
      else if (op === 'starts') (where.push(`${x} LIKE ? ESCAPE '\\'`), args.push(`${likeText(value)}%`));
    } else if (field.type === 'number') {
      const sqlOp = NUMBER_OPS[op];
      if (!sqlOp) throw badRequest('One of the filters has an operator that does not apply', 'FILTER_INVALID');
      if (value === '' || !Number.isFinite(Number(value))) throw badRequest('A number filter needs a number', 'FILTER_NUMBER');
      where.push(`(${field.sql}) ${sqlOp} ?`);
      args.push(num(value));
    } else if (field.type === 'bool') {
      if (op !== 'is') throw badRequest('One of the filters has an operator that does not apply', 'FILTER_INVALID');
      where.push(value === '0' || value === 'false' ? `NOT (${field.sql})` : `(${field.sql})`);
    }
  }
  return { where, args, fields: used };
}
