import { badRequest } from './http.js';

/** Round to 2 decimals, avoiding binary float dust like 0.1+0.2. */
export const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Quantities allow 3 decimals so fractional units (kg, litres) work. */
export const qty = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function str(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

export function required(value, field, key) {
  const s = str(value);
  if (!s) throw badRequest(`${field} is required`, 'REQUIRED', { field: key });
  return s;
}

/** Today's date where the shop is (the machine's local time), not in UTC. */
export const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** A YYYY-MM-DD date moved by a number of days. */
export function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Normalise a YYYY-MM-DD input; falls back to today when blank/invalid. */
/** EAN-13's last digit: weights of 1 and 3 over the first twelve, so a misread fails loudly. */
export function ean13Check(digits12) {
  const sum = [...String(digits12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

export function isoDate(value) {
  const s = str(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : today();
}

/** Inclusive range used by every report; defaults to the current month. */
export function dateRange(query) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(str(query.from)) ? str(query.from) : `${today().slice(0, 7)}-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(str(query.to)) ? str(query.to) : today();
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Paging for the list screens. A request without `page` is answered as before —
 * a plain array — so the till, the pickers and the reports keep working; with
 * `page` the answer becomes { rows, total, page, per, pages }.
 */
export function pageParams(query, { per = 50, max = 200 } = {}) {
  if (!str(query.page)) return null;
  const size = Math.min(max, Math.max(5, Math.round(num(query.per, per))));
  const page = Math.max(1, Math.round(num(query.page, 1)));
  return { page, per: size, offset: (page - 1) * size };
}

export const pageResult = (rows, total, p) => ({
  rows,
  total,
  page: p.page,
  per: p.per,
  pages: Math.max(1, Math.ceil(total / p.per)),
});

/** Sequential document numbers, e.g. INV-000042. */
export function nextDocNo(db, table, prefix) {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS last FROM ${table}`).get();
  return `${prefix}-${String(Number(row.last) + 1).padStart(6, '0')}`;
}
