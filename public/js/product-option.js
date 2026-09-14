import { esc, money, productThumb, qtyText } from './ui.js';

/**
 * One product as it appears in a search dropdown.
 *
 * Shows the things you need to tell two similar products apart — barcode,
 * category, price — plus stock on hand, because picking an item you have none of
 * is worth noticing before it reaches the invoice.
 */
export function productOption(p) {
  const sub = [p.barcode, p.category, p.description].filter(Boolean).join(' · ');
  const out = Number(p.stock) <= 0;
  return `
    ${productThumb(p, 'xs')}
    <div class="ci-main">
      <div class="ci-name">${esc(p.name)}</div>
      ${sub ? `<div class="ci-sub">${esc(sub)}</div>` : ''}
    </div>
    <div class="ci-side">
      <div class="ci-price">${money(p.price)}</div>
      <div class="ci-stock ${out ? 'out' : ''}">${qtyText(p.stock)} ${esc(p.unit)}</div>
    </div>`;
}
