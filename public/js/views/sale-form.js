import { api } from '../api.js';
import { money2 } from '../currency.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import { wireNamePickers } from '../name-picker.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
import { emptyState, esc, forgetSuggestions, money, paymentMethods, qtyText, store, toast, todayISO } from '../ui.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * #/sales/new — a sale entered as a document, the way a purchase is: customer,
 * date, lines, discount and what was paid. It is the same invoice the POS
 * writes, so it lists in Sell, takes payments and moves stock the same way.
 */
export async function renderSaleForm(root, ctx) {
  const back = () => ctx.navigate('sales');
  const taxRate = Number(store.settings.tax_rate) || 0;
  const methods = paymentMethods().length ? paymentMethods() : [{ name: 'cash' }];
  const lines = [];
  const state = { discount: 0, paid: 0, paidTouched: false, method: 'cash' };

  const lineTotal = (l) => Math.max(0, round2(l.qty * l.unit_price - l.discount));
  const totals = () => {
    const subtotal = round2(lines.filter((l) => l.product_id).reduce((s, l) => s + lineTotal(l), 0));
    const discount = Math.min(Math.max(0, state.discount), subtotal);
    const tax = round2(((subtotal - discount) * taxRate) / 100);
    const total = round2(subtotal - discount + tax);
    // Until the amount paid is typed, the sale is paid in full.
    const paid = state.paidTouched ? Math.min(Math.max(0, state.paid), total) : total;
    return { subtotal, discount, tax, total, paid, balance: round2(total - paid) };
  };

  const stockNote = (l) => {
    if (!l.product_id || l.stock === undefined) return '';
    const short = l.qty > l.stock;
    return `<div class="cell-sub ${short ? 'money-neg' : ''}">${esc(
      t(short ? 'sell.short' : 'sell.in_stock', { q: `${qtyText(l.stock)} ${l.unit || ''}`.trim() }),
    )}</div>`;
  };

  const linesHtml = () =>
    lines.length
      ? `<table class="data sale-lines">
          <thead><tr><th>${esc(t('nav.products'))}</th>
            <th class="right" style="width:100px">${esc(t('common.qty'))}</th>
            <th class="right" style="width:120px">${esc(t('common.price'))}</th>
            <th class="right" style="width:110px">${esc(t('common.discount'))}</th>
            <th class="right" style="width:110px">${esc(t('common.total'))}</th><th style="width:40px"></th></tr></thead>
          <tbody>${lines
            .map(
              (l, i) => `<tr>
                <td>
                  <div class="combo"><input class="input" data-product="${i}" value="${esc(l.name)}"
                    placeholder="${esc(t('buy.find_product'))}"/></div>
                  <div data-stock="${i}">${stockNote(l)}</div>
                </td>
                <td><input class="input" type="number" step="any" min="0" value="${l.qty}" data-qty="${i}" style="text-align:end"/></td>
                <td><input class="input" type="number" step="0.01" min="0" value="${l.unit_price}" data-price="${i}" style="text-align:end"/></td>
                <td><input class="input" type="number" step="0.01" min="0" value="${l.discount || ''}" data-discount="${i}" placeholder="0" style="text-align:end"/></td>
                <td class="right"><b data-line-total="${i}">${money(lineTotal(l))}</b></td>
                <td class="right"><button type="button" class="cl-remove" data-remove="${i}" title="${esc(t('common.remove'))}">${icon('trash')}</button></td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
      : emptyState(t('buy.no_lines'), t('sell.no_lines_sub'), 'cart');

  root.innerHTML = `
    <form id="sale-form" class="card form-page" novalidate>
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" data-cancel aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(t('sell.title'))}</h3><div class="sub">${esc(t('sell.sub'))}</div></div>
      </div>
      <div class="card-body">
        <div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="field"><label>${esc(t('common.customer'))}</label>
            <div class="combo"><input class="input" name="customer" data-names="customer"
              placeholder="${esc(t('common.walk_in'))}" autocomplete="off"/></div></div>
          <div class="field"><label>${esc(t('common.date'))}</label>
            <input class="input" type="date" name="date" value="${todayISO()}"/></div>
          <div class="field"><label>${esc(t('common.note'))}</label>
            <input class="input" name="note" placeholder="${esc(t('sell.note_placeholder'))}" autocomplete="off"/></div>
        </div>
      </div>
      <div class="card-head" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div><h3>${esc(t('buy.items'))}</h3></div><div class="spacer"></div>
        <button type="button" class="btn btn-sm" id="add-line">${icon('plus')} ${esc(t('buy.add_line'))}</button>
      </div>
      <div class="table-wrap" id="lines"></div>
      <div class="card-body sale-foot">
        <div class="sale-pay">
          <div class="field"><label>${esc(t('sell.method'))}</label>
            <select class="select" name="method">${methods
              .map((m) => `<option value="${esc(m.name)}">${esc(methodText(m.name))}</option>`)
              .join('')}</select></div>
          <div class="field"><label>${esc(t('sell.paid_now'))}</label>
            <input class="input" type="number" step="0.01" min="0" name="paid" style="text-align:end"/>
            <div class="sale-pay-quick">
              <button type="button" class="btn btn-sm" data-paid="full">${esc(t('pay.full'))}</button>
              <button type="button" class="btn btn-sm" data-paid="none">${esc(t('pay.nothing'))}</button>
            </div>
            <div class="help">${esc(t('sell.paid_help'))}</div></div>
        </div>
        <div class="sale-sums" id="sums"></div>
      </div>
      <div class="card-head form-actions">
        <div class="spacer"></div>
        <button type="button" class="btn" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="save-sale">${icon('check')} ${esc(t('sell.save'))}</button>
      </div>
    </form>`;

  const form = root.querySelector('#sale-form');
  const dropCustomer = wireNamePickers(form);
  const linesEl = root.querySelector('#lines');
  const sumsEl = root.querySelector('#sums');

  function paintSums() {
    const s = totals();
    const row = (label, value, cls = '') => `<div class="sum-row ${cls}"><span>${label}</span><span class="v">${value}</span></div>`;
    sumsEl.innerHTML = `
      ${row(esc(t('common.subtotal')), money(s.subtotal))}
      <div class="sum-row"><span>${esc(t('sell.invoice_discount'))}</span>
        <input class="input" type="number" step="0.01" min="0" id="invoice-discount" value="${state.discount || ''}" placeholder="0" style="text-align:end"/></div>
      ${taxRate ? row(esc(t('sell.tax', { r: taxRate })), money(s.tax)) : ''}
      ${row(esc(t('common.total')), `${money(s.total)}${money2(s.total) ? `<span class="money2 block">${esc(money2(s.total))}</span>` : ''}`, 'strong')}
      ${row(esc(t('pay.paid')), money(s.paid))}
      ${row(esc(t('sell.left_owing')), money(s.balance), s.balance > 0.004 ? 'strong money-neg' : 'muted')}`;
    const paidInput = form.paid;
    if (!state.paidTouched && document.activeElement !== paidInput) paidInput.value = s.total.toFixed(2);
    const discount = sumsEl.querySelector('#invoice-discount');
    discount.addEventListener('input', () => {
      state.discount = Number(discount.value) || 0;
      refresh(discount);
    });
  }

  /** Recompute everything without redrawing the input being typed in. */
  function refresh(keep = null) {
    lines.forEach((l, i) => {
      const cell = linesEl.querySelector(`[data-line-total="${i}"]`);
      if (cell) cell.textContent = money(lineTotal(l));
      const stock = linesEl.querySelector(`[data-stock="${i}"]`);
      if (stock) stock.innerHTML = stockNote(l);
    });
    if (keep && sumsEl.contains(keep)) {
      const pos = keep.selectionStart;
      paintSums();
      const again = sumsEl.querySelector('#invoice-discount');
      again.focus();
      try {
        again.setSelectionRange(pos, pos);
      } catch {
        /* number inputs do not support a caret position */
      }
    } else {
      paintSums();
    }
  }

  let pickers = [];
  const dropPickers = () => {
    pickers.forEach((p) => p.destroy());
    pickers = [];
  };
  const redraw = () => {
    dropPickers();
    linesEl.innerHTML = linesHtml();
    wire();
    paintSums();
  };

  function wire() {
    linesEl.querySelectorAll('[data-product]').forEach((input) => {
      const line = lines[+input.dataset.product];
      pickers.push(
        attachPicker(input, {
          search: (q) => api.products({ search: q, limit: 25 }),
          render: productOption,
          emptyText: t('buy.no_product_match'),
          onPick: (p) => {
            Object.assign(line, { product_id: p.id, name: p.name, unit: p.unit, stock: Number(p.stock) });
            if (!line.touchedPrice) line.unit_price = Number(p.price) || 0;
            redraw();
            linesEl.querySelector(`[data-qty="${input.dataset.product}"]`)?.focus();
          },
        }),
      );
    });
    const onInput = (attr, apply) =>
      linesEl.querySelectorAll(`[${attr}]`).forEach((input) =>
        input.addEventListener('input', () => {
          apply(lines[+input.getAttribute(attr)], Number(input.value) || 0);
          refresh();
        }),
      );
    onInput('data-qty', (l, v) => (l.qty = v));
    onInput('data-price', (l, v) => ((l.unit_price = v), (l.touchedPrice = true)));
    onInput('data-discount', (l, v) => (l.discount = v));
    linesEl.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        lines.splice(+btn.dataset.remove, 1);
        redraw();
      }),
    );
  }

  const addLine = () => {
    lines.push({ product_id: 0, name: '', unit: '', qty: 1, unit_price: 0, discount: 0, touchedPrice: false });
    redraw();
    linesEl.querySelector(`[data-product="${lines.length - 1}"]`)?.focus();
  };
  root.querySelector('#add-line').addEventListener('click', addLine);
  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', back));

  form.paid.addEventListener('input', () => {
    state.paidTouched = true;
    state.paid = Number(form.paid.value) || 0;
    paintSums();
  });
  form.querySelectorAll('[data-paid]').forEach((b) =>
    b.addEventListener('click', () => {
      const full = b.dataset.paid === 'full';
      state.paidTouched = !full;
      state.paid = 0;
      form.paid.value = full ? totals().total.toFixed(2) : '0';
      // Nothing paid now is usually a sale on account.
      // Nothing paid now is a sale on account, when the shop keeps that method.
      if (!full && form.method.value === 'cash' && methods.some((m) => m.name === 'credit')) form.method.value = 'credit';
      paintSums();
    }),
  );
  // Enter in a field must not submit half a sale.
  form.addEventListener('submit', (e) => e.preventDefault());

  root.querySelector('#save-sale').addEventListener('click', async (e) => {
    const valid = lines.filter((l) => l.product_id && l.qty > 0);
    if (!valid.length) return toast(t('sell.need_line'), 'warn');
    const s = totals();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const saved = await api.createSale({
        customer: form.customer.value.trim(),
        date: form.date.value,
        note: form.note.value.trim(),
        discount: s.discount,
        method: form.method.value,
        paid: s.paid,
        items: valid.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, discount: l.discount })),
      });
      toast(t('sell.saved', { doc: saved.doc_no, v: money(saved.total) }), 'success');
      if (saved.shortages?.length) toast(t('pos.shortage', { names: saved.shortages.map((x) => x.name).join(', ') }), 'warn', 6000);
      if (saved.customer) forgetSuggestions('customer');
      ctx.navigate(`sales/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });

  addLine();
  return () => {
    dropPickers();
    dropCustomer();
  };
}
