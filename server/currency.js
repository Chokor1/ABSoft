import { getSettings } from './db.js';
import { money, num } from './util.js';

/**
 * The optional second currency (for example L.L beside $).
 *
 * The first currency stays the currency of the books: prices, costs, totals,
 * profit and every report are kept in it. The second one is a way of showing
 * amounts and of taking money: a payment in it is converted at the rate of the
 * moment and stored in the first currency, with the amount actually handed over
 * and the rate kept beside it.
 */
export function secondCurrency(settings = getSettings()) {
  if (settings.currency2_enabled !== '1') return null;
  const rate = num(settings.currency2_rate);
  if (!(rate > 0)) return null;
  return {
    symbol: settings.currency2_symbol || 'L.L',
    rate,
    decimals: Math.min(4, Math.max(0, Math.round(num(settings.currency2_decimals)))),
  };
}

/** An amount in the second currency, rounded the way that currency is counted. */
export const roundSecond = (value, second) => {
  const f = 10 ** second.decimals;
  return Math.round(num(value) * f) / f;
};

/** Second-currency money into first-currency money. */
export const toBase = (amount2, second) => money(num(amount2) / second.rate);

/** First-currency money into the second currency. */
export const toSecond = (amount, second) => roundSecond(num(amount) * second.rate, second);
