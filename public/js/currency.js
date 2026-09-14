import { api } from './api.js';
import { locale } from './i18n.js';
import { esc, store } from './ui.js';

/**
 * The optional second currency (for example L.L beside $).
 *
 * Amounts are kept in the first currency everywhere; the second is shown beside
 * them. Anything drawn with `money2Html` repaints itself when the rate changes,
 * so updating the rate in the sidebar changes every price on screen at once.
 */

/** { symbol, rate, decimals } when the second currency is on, otherwise null. */
export function second() {
  const s = store.settings || {};
  if (s.currency2_enabled !== '1') return null;
  const rate = Number(s.currency2_rate);
  if (!(rate > 0)) return null;
  return {
    symbol: s.currency2_symbol || 'L.L',
    rate,
    decimals: Math.min(4, Math.max(0, Math.round(Number(s.currency2_decimals) || 0))),
  };
}

/** A first-currency amount converted and formatted, e.g. "8,950,000 L.L". */
export function money2(value, rate) {
  const cur = second();
  if (!cur) return '';
  const r = Number(rate) > 0 ? Number(rate) : cur.rate;
  return formatSecond((Number(value) || 0) * r, cur);
}

/** An amount already in the second currency, formatted. */
export function formatSecond(amount2, cur = second()) {
  if (!cur) return '';
  const f = 10 ** cur.decimals;
  const n = Math.round((Number(amount2) || 0) * f) / f;
  const body = Math.abs(n).toLocaleString(locale(), {
    minimumFractionDigits: cur.decimals,
    maximumFractionDigits: cur.decimals,
  });
  return `‎${n < 0 ? '-' : ''}${body} ${cur.symbol}`;
}

/** Second-currency money into first-currency money (two decimals). */
export const toBase = (amount2, cur = second()) => (cur ? Math.round(((Number(amount2) || 0) / cur.rate) * 100) / 100 : 0);

/** First-currency money into the second currency, rounded as that currency is counted. */
export function toSecond(amount, cur = second()) {
  if (!cur) return 0;
  const f = 10 ** cur.decimals;
  return Math.round((Number(amount) || 0) * cur.rate * f) / f;
}

/**
 * A live second-currency amount. `rate` pins it to a past rate (an invoice keeps
 * the rate of its day); without it the amount follows the current rate.
 */
export function money2Html(value, { rate = null, cls = '' } = {}) {
  if (!second()) return '';
  return `<span class="money2 ${cls}" data-base="${Number(value) || 0}" ${rate ? `data-rate="${rate}"` : ''}>${esc(
    money2(value, rate),
  )}</span>`;
}

/** Redraw every live amount, after the rate changed. */
export function repaintMoney2(root = document) {
  root.querySelectorAll('.money2[data-base]').forEach((el) => {
    el.textContent = money2(el.dataset.base, el.dataset.rate);
  });
}

const listeners = new Set();

/** Be told when the rate (or the second currency itself) changes. Returns an unsubscribe. */
export function onRateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  repaintMoney2();
  listeners.forEach((fn) => {
    try {
      fn(second());
    } catch {
      /* one broken listener must not stop the others */
    }
  });
}

/** Adopt new settings; announce only when something about the second currency changed. */
export function applySettings(next) {
  const keys = ['currency2_enabled', 'currency2_symbol', 'currency2_rate', 'currency2_decimals'];
  const changed = keys.some((k) => String(store.settings?.[k] ?? '') !== String(next?.[k] ?? ''));
  store.settings = next;
  if (changed) announce();
  return changed;
}

/** Save a new rate (administrators) and repaint everything that shows it. */
export async function saveRate(rate) {
  const next = await api.saveExchangeRate(rate);
  applySettings(next);
  return next;
}

/** Pick up a rate changed on another till, once a minute. */
let polling = null;
export function watchRate() {
  if (polling) return;
  polling = setInterval(async () => {
    if (!store.user || document.hidden) return;
    try {
      applySettings(await api.settings());
    } catch {
      /* offline for a moment; try again next time */
    }
  }, 60000);
}
