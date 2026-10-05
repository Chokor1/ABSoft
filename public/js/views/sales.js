import { api } from '../api.js';
import { formatSecond, money2, second, toSecond } from '../currency.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  dateTimeText,
  debounce,
  docPage,
  filterSelect,
  pager,
  downloadCsv,
  emptyState,
  esc,
  modal,
  readFields,
  renderFields,
  money,
  monthStart,
  qtyText,
  rangeBar,
  signClass,
  slipFoot,
  slipHead,
  store,
  toast,
  todayISO,
} from '../ui.js';
import { methodMark, paymentMethods } from '../ui.js';
import { openParty } from './lists.js';
import { renderSaleForm } from './sale-form.js';

/**
 * Printable receipt / invoice for a completed sale.
 *
 * `afterSale` is the receipt shown the moment a sale is saved at the till. It is
 * just the document, to print or close: taking the rest of a balance is a later
 * visit's business, and it stays available from Sales History for that.
 */
/** The printable receipt itself. */
function receiptHtml(sale, change = 0, change2 = null) {
  const cfg = sale.settings || store.settings;
  const line = (label, value, cls = '') =>
    `<div class="r-line ${cls}"><span>${esc(label)}</span><span>${value}</span></div>`;
  return `<div class="receipt" id="receipt-print">
        ${slipHead(cfg)}
        <div class="r-center">${esc(sale.doc_no)} · ${dateTimeText(sale.created_at || sale.date)}</div>
        ${
          sale.kind === 'return'
            ? `<div class="r-center"><b>${esc(t('ret.badge').toUpperCase())}</b>${sale.original ? ` · ${esc(t('ret.for', { doc: sale.original.doc_no }))}` : ''}</div>`
            : ''
        }
        <div class="r-rule"></div>
        ${sale.items
          .map(
            (i) =>
              `${line(`${i.name}`, money(i.total))}
               <div class="r-line" style="color:var(--muted)"><span class="r-detail">&nbsp;&nbsp;${qtyText(
                 i.qty,
               )} ${esc(i.unit)} × ${money(i.unit_price)}${
                i.discount ? ` − ${money(i.discount)}` : ''
              }</span><span></span></div>`,
          )
          .join('')}
        <div class="r-rule"></div>
        ${line(t('common.subtotal'), money(sale.subtotal))}
        ${sale.discount ? line(t('common.discount'), `−${money(sale.discount)}`) : ''}
        ${sale.tax ? line(t('common.tax'), money(sale.tax)) : ''}
        ${line(t('receipt.total'), money(sale.total), 'r-total')}
        ${sale.rate2 && second() ? line('', money2(sale.total, sale.rate2), 'r-second') : ''}
        ${sale.kind === 'return' ? line(t('ret.refund'), money(-sale.paid)) : line(t('pay.paid'), money(sale.paid))}
        ${sale.balance < -0.004 ? line(t('ret.credited'), money(-sale.balance), 'r-total') : ''}
        ${(sale.payments || [])
          .filter((p) => p.currency === 'second' && p.amount2)
          .map((p) => line(t('receipt.paid_in', { c: second()?.symbol || '' }), esc(formatSecond(p.amount2)), 'r-second'))
          .join('')}
        ${change > 0.004 ? line(t('receipt.change'), money(change)) : ''}
        ${change > 0.004 && change2 ? line('', esc(formatSecond(change2)), 'r-second') : ''}
        ${sale.balance > 0.004 ? line(t('pay.balance'), money(sale.balance), 'r-total') : ''}
        <div class="r-rule"></div>
        ${cfg.receipt_footer ? `<div class="r-center">${esc(cfg.receipt_footer)}</div>` : ''}
        ${slipFoot()}
      </div>`;
}

export function showReceipt(sale, { change = 0, change2 = null, onChanged, afterSale = false } = {}) {
  const owing = !afterSale && sale.balance > 0.004;

  return modal({
    title: t('receipt.title', { doc: sale.doc_no }),
    subtitle: `${dateText(sale.date)} · ${sale.customer || t('common.walk_in')}`,
    body: `${receiptHtml(sale, change, change2)}
      ${afterSale ? '' : paymentsHtml(sale)}`,
    footer: `<button class="btn" data-close>${esc(t('common.close'))}</button>
             ${
               owing
                 ? `<button class="btn btn-primary no-print" data-pay>${icon('coins')} ${esc(t('pay.record'))}</button>`
                 : ''
             }
             <button class="btn ${owing ? '' : 'btn-primary'} no-print" data-print>${icon('print')} ${esc(
               t('common.print'),
             )}</button>`,
    setup: (root, close) => {
      root.querySelector('[data-print]').addEventListener('click', () => window.print());
      root.querySelector('[data-pay]')?.addEventListener('click', async () => {
        close();
        const updated = await recordPayment(sale);
        if (updated) {
          onChanged?.();
          showReceipt(updated, { onChanged });
        }
      });
      root.querySelectorAll('[data-del-pay]').forEach((b) =>
        b.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: t('pay.delete_title'),
            message: t('pay.delete_msg'),
            confirmLabel: t('common.remove'),
            danger: true,
          });
          if (!ok) return;
          try {
            const updated = await api.deletePayment(b.dataset.delPay);
            toast(t('pay.removed'), 'success');
            close();
            onChanged?.();
            showReceipt(updated, { onChanged });
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }),
      );
    },
  });
}

/** The instalments recorded against an invoice, newest last. */
function paymentsHtml(sale) {
  const rows = sale.payments || [];
  return `<div class="no-print" style="margin-top:16px">
    <div class="card-head" style="padding:0 0 8px;border-bottom:0">
      <div><h3 style="font-size:14px">${esc(t('pay.history'))}</h3></div>
      <div class="spacer"></div>
      <span class="badge ${sale.balance > 0.004 ? 'warn' : 'success'}">${esc(
        sale.balance > 0.004 ? t('pay.due', { v: money(sale.balance) }) : t('pay.status_paid'),
      )}</span>
    </div>
    ${
      rows.length
        ? `<div class="table-wrap"><table class="data"><tbody>${rows
            .map(
              (r) => `<tr>
                <td class="nowrap">${dateText(r.date)}</td>
                <td><span class="badge">${esc(methodText(r.method))}</span></td>
                <td class="muted">${esc(r.note || '')}</td>
                <td class="right"><b>${money(r.amount)}</b>${
                  r.currency === 'second' && r.amount2
                    ? `<div class="money2">${esc(formatSecond(r.amount2))} · ${esc(t('pay.at_rate', { r: Number(r.rate).toLocaleString() }))}</div>`
                    : ''
                }</td>
                <td class="right">${
                  store.user.role === 'admin'
                    ? `<button class="btn btn-sm btn-ghost" data-del-pay="${r.id}" title="${esc(
                        t('common.remove'),
                      )}" aria-label="${esc(
                        t('common.remove'),
                      )}">${icon('trash')}</button>`
                    : ''
                }</td>
              </tr>`,
            )
            .join('')}</tbody></table></div>`
        : `<p class="muted" style="font-size:12.5px">${esc(t('pay.no_payments'))}</p>`
    }
  </div>`;
}

/** Take an instalment against an invoice. Resolves with the updated sale. */
export async function recordPayment(sale) {
  const cur = second();
  const fields = [
    ...(cur
      ? [
          {
            name: 'currency',
            label: t('pay.currency'),
            type: 'select',
            value: 'base',
            options: [
              { value: 'base', label: store.settings.currency || '$' },
              { value: 'second', label: cur.symbol },
            ],
          },
        ]
      : []),
    {
      name: 'amount',
      label: t('pay.amount'),
      type: 'number',
      step: 'any',
      min: 0,
      // Pre-filled with the whole balance: settling in full is the common case,
      // and anything less is just a smaller number typed over it.
      value: sale.balance.toFixed(2),
      required: true,
      autofocus: true,
      help: cur
        ? t('pay.amount_help_second', { v: formatSecond(toSecond(sale.balance, cur), cur) })
        : t('pay.amount_help'),
    },
    {
      name: 'method',
      label: t('pos.payment_method'),
      type: 'select',
      value: 'cash',
      options: paymentMethods().map((m) => ({ value: m.name, label: methodText(m.name) })),
    },
    { name: 'date', label: t('common.date'), type: 'date', value: todayISO() },
    { name: 'note', label: t('common.note'), span: 2 },
  ];

  const data = await modal({
    title: t('pay.record_title', { doc: sale.doc_no }),
    subtitle: t('pay.record_sub', { balance: money(sale.balance), total: money(sale.total) }),
    body: `<form id="modal-form" class="form-grid" style="padding:8px 0 12px">${renderFields(fields)}</form>`,
    footer: `<div class="spacer"></div>
      <button class="btn" data-close>${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" form="modal-form" type="submit">${esc(t('pay.record'))}</button>`,
    setup: (root, close) => {
      const form = root.querySelector('#modal-form');
      // Switching currency converts the amount, so the balance stays the balance.
      form.currency?.addEventListener('change', () => {
        const value = Number(form.amount.value) || 0;
        form.amount.value =
          form.currency.value === 'second' ? toSecond(value, cur) : (Math.round((value / cur.rate) * 100) / 100).toFixed(2);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        close(readFields(root, fields));
      });
    },
  });
  if (!data) return null;
  try {
    const updated = await api.addPayment(sale.id, {
      ...data,
      currency: data.currency === 'second' ? 'second' : '',
    });
    toast(
      updated.balance > 0.004 ? t('pay.added', { balance: money(updated.balance) }) : t('pay.settled'),
      'success',
    );
    return updated;
  } catch (err) {
    toast(errorText(err), 'error');
    return null;
  }
}

/** paid / part paid / unpaid, from the balance rather than a stored flag. */
function payStatus(sale) {
  if (sale.kind === 'return') {
    return sale.balance < -0.004
      ? `<span class="badge warn">${esc(t('ret.credited'))}</span>`
      : `<span class="badge">${esc(t('ret.refunded'))}</span>`;
  }
  if (sale.balance <= 0.004) return `<span class="badge success">${esc(t('pay.status_paid'))}</span>`;
  if (sale.paid > 0.004) return `<span class="badge warn">${esc(t('pay.status_partial'))}</span>`;
  return `<span class="badge danger">${esc(t('pay.status_unpaid'))}</span>`;
}

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * Part of an invoice comes back. Pick the lines and how many, say whether each goes
 * back on the shelf or was damaged, choose how the money goes out (or leave it owed
 * to the customer), and the return is saved as a document of its own. Resolves with
 * the saved return — carrying `exchange: true` when the till should start a new sale
 * for the customer straight after — or null.
 */
export function returnDialog(sale, { atTill = false } = {}) {
  const lines = sale.items.map((i) => ({ item: i, left: round3(Math.max(0, i.qty - (i.returned || 0))), qty: 0, restock: true }));
  if (!lines.some((l) => l.left > 0)) {
    toast(t('ret.all_back'), 'info');
    return Promise.resolve(null);
  }
  const methods = paymentMethods().map((m) => ({ value: m.name, label: methodText(m.name), icon: m.icon }));
  if (!methods.some((m) => m.value === 'credit')) methods.push({ value: 'credit', label: methodText('credit'), icon: 'receipt' });
  let method = methods.some((m) => m.value === sale.method) ? sale.method : methods[0].value;

  // What the customer paid for the goods coming back: their share of the invoice's
  // discount and tax comes back with them, the same way the server works it out.
  const refundOf = () => {
    const subtotal = lines.reduce((s, l) => s + (l.qty > 0 ? (l.item.total * l.qty) / l.item.qty : 0), 0);
    const ratio = sale.subtotal > 0 ? subtotal / sale.subtotal : 0;
    return Math.round((subtotal - sale.discount * ratio + sale.tax * ratio) * 100) / 100;
  };
  const lineRefund = (l) => (l.qty > 0 ? ((l.item.total * l.qty) / l.item.qty) * (sale.subtotal > 0 ? sale.total / sale.subtotal : 1) : 0);

  return modal({
    title: t('ret.title', { doc: sale.doc_no }),
    subtitle: `${dateText(sale.date)} · ${sale.customer || t('common.walk_in')} · ${methodText(sale.method)}`,
    wide: true,
    body: `
      <div class="table-wrap"><table class="data ret-table">
        <thead><tr><th>${esc(t('ret.item'))}</th><th class="right">${esc(t('ret.sold'))}</th><th class="right">${esc(t('ret.returning'))}</th>
          <th>${esc(t('ret.shelf'))}</th><th class="right">${esc(t('ret.refund'))}</th></tr></thead>
        <tbody>${lines
          .map(
            (l, i) => `<tr data-i="${i}" class="${l.left > 0 ? '' : 'muted'}">
              <td><div class="cell-title">${esc(l.item.name)}</div>${
                l.item.returned ? `<div class="cell-sub">${esc(t('ret.already', { q: qtyText(l.item.returned) }))}</div>` : ''
              }</td>
              <td class="right">${qtyText(l.item.qty)} ${esc(l.item.unit || '')}</td>
              <td class="right"><input class="input ret-qty" type="number" min="0" max="${l.left}" step="any" value="0" data-qty
                     ${l.left > 0 ? '' : 'disabled'} aria-label="${esc(t('ret.returning'))} · ${esc(l.item.name)}"/></td>
              <td><span class="seg seg-sm" role="radiogroup" aria-label="${esc(t('ret.shelf'))}">
                <button type="button" class="active" data-shelf="1" role="radio" aria-checked="true">${esc(t('ret.shelf_yes'))}</button>
                <button type="button" data-shelf="0" role="radio" aria-checked="false">${esc(t('ret.damaged'))}</button></span></td>
              <td class="right" data-refund>—</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <div class="ret-foot">
        <div class="field">
          <label>${esc(t('ret.refund_by'))}</label>
          <div class="pay-methods ret-methods" id="ret-method" role="radiogroup">${methods
            .map(
              (m) => `<button type="button" role="radio" data-method="${esc(m.value)}" class="${m.value === method ? 'active' : ''}"
                        aria-checked="${m.value === method}">${methodMark(m.icon)}<span>${esc(m.label)}</span></button>`,
            )
            .join('')}</div>
        </div>
        <div class="field">
          <label for="ret-note">${esc(t('common.note'))}</label>
          <input class="input" id="ret-note" autocomplete="off"/>
        </div>
      </div>`,
    footer: `<button class="btn" data-close>${esc(t('common.cancel'))}</button>
             ${atTill ? `<button class="btn" data-exchange>${icon('refresh')} ${esc(t('ret.and_sell'))}</button>` : ''}
             <button class="btn btn-primary" data-save>${icon('check')} <span data-save-label></span></button>`,
    setup: (root, close) => {
      const label = root.querySelector('[data-save-label]');
      const paint = () => {
        root.querySelectorAll('tr[data-i]').forEach((tr) => {
          const l = lines[Number(tr.dataset.i)];
          tr.querySelector('[data-refund]').textContent = l.qty > 0 ? money(lineRefund(l)) : '—';
        });
        label.textContent = t(method === 'credit' ? 'ret.confirm_credit' : 'ret.confirm', { v: money(refundOf()) });
      };
      root.addEventListener('input', (e) => {
        const input = e.target.closest('[data-qty]');
        if (!input) return;
        const l = lines[Number(input.closest('tr').dataset.i)];
        l.qty = round3(Math.min(l.left, Math.max(0, Number(input.value) || 0)));
        paint();
      });
      root.addEventListener('click', (e) => {
        const shelf = e.target.closest('[data-shelf]');
        if (shelf) {
          const l = lines[Number(shelf.closest('tr').dataset.i)];
          l.restock = shelf.dataset.shelf === '1';
          shelf.parentElement.querySelectorAll('[data-shelf]').forEach((b) => {
            b.classList.toggle('active', b === shelf);
            b.setAttribute('aria-checked', String(b === shelf));
          });
        }
        const m = e.target.closest('[data-method]');
        if (m) {
          method = m.dataset.method;
          root.querySelectorAll('[data-method]').forEach((b) => {
            b.classList.toggle('active', b === m);
            b.setAttribute('aria-checked', String(b === m));
          });
          paint();
        }
      });
      const save = async (exchange) => {
        const items = lines.filter((l) => l.qty > 0).map((l) => ({ item_id: l.item.id, qty: l.qty, restock: l.restock }));
        if (!items.length) return toast(t('ret.nothing'), 'warn');
        try {
          const saved = await api.returnSale(sale.id, { items, method, note: root.querySelector('#ret-note').value.trim() });
          close({ ...saved, exchange });
        } catch (err) {
          toast(errorText(err), 'error');
        }
      };
      root.querySelector('[data-save]').addEventListener('click', () => save(false));
      root.querySelector('[data-exchange]')?.addEventListener('click', () => save(true));
      paint();
    },
  });
}

/** One invoice, as a page: the receipt, what has been paid, and what to do next. */
async function renderSale(root, ctx, id) {
  const back = () => ctx.navigate('sales');
  const admin = store.user.role === 'admin';
  let sale;
  try {
    sale = await api.sale(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return back();
  }

  const paint = () => {
    const owing = sale.balance > 0.004;
    const isReturn = sale.kind === 'return';
    const returnable = !isReturn && sale.items.some((i) => i.qty - (i.returned || 0) > 0.0005);
    const body = docPage(root, {
      title: t(isReturn ? 'ret.doc_title' : 'receipt.title', { doc: sale.doc_no }),
      subtitle: [
        dateText(sale.date),
        sale.original ? t('ret.for', { doc: sale.original.doc_no }) : '',
        sale.customer || t('common.walk_in'),
        sale.username,
      ]
        .filter(Boolean)
        .join(' · '),
      badges: `<span class="badge ${isReturn ? 'danger' : 'accent'}">${isReturn ? `${esc(t('ret.badge'))} · ` : ''}${money(sale.total)}</span> ${payStatus(sale)}`,
      actions: `${admin && sale.customer ? `<button class="btn" data-customer>${icon('users')} ${esc(t('party.open_customer'))}</button>` : ''}
                ${returnable ? `<button class="btn" data-return>${icon('refresh')} ${esc(t('ret.button'))}</button>` : ''}
                ${owing ? `<button class="btn btn-primary" data-pay>${icon('coins')} ${esc(t('pay.record'))}</button>` : ''}
                <button class="btn ${owing ? '' : 'btn-primary'}" data-print>${icon('print')} ${esc(t('common.print'))}</button>
                ${admin ? `<button class="btn btn-ghost" data-void title="${esc(t('sales.void_tip'))}" aria-label="${esc(t('sales.void_tip'))}">${icon('trash')}</button>` : ''}`,
      onBack: back,
    });
    root.querySelector('[data-customer]')?.addEventListener('click', () => openParty(ctx, 'customer', sale.customer));
    const row = (label, value, cls = '') => `<div class="sum-row ${cls}"><span>${esc(label)}</span><span class="v">${value}</span></div>`;
    body.innerHTML = `
      <div class="grid cols-2 sale-grid">
        <div class="card"><div class="card-body receipt-page">${receiptHtml(sale)}</div></div>
        <div class="sale-side">
          <div class="card">
            <div class="card-head"><div><h3>${esc(t('sales.summary'))}</h3></div></div>
            <div class="card-body sale-summary">
              ${row(t('common.subtotal'), money(sale.subtotal))}
              ${sale.discount ? row(t('common.discount'), `−${money(sale.discount)}`) : ''}
              ${sale.tax ? row(t('common.tax'), money(sale.tax)) : ''}
              ${row(t('common.total'), money(sale.total), 'strong')}
              ${row(t('pay.paid'), money(sale.paid))}
              ${row(t('pay.balance'), money(sale.balance), owing ? 'strong money-neg' : 'muted')}
              ${
                second()
                  ? `<div class="sum-sep"></div>
                     ${sale.rate2 ? row(t('sales.total_in', { c: second().symbol }), esc(money2(sale.total, sale.rate2)), 'muted') : ''}
                     ${owing ? row(t('sales.balance_in', { c: second().symbol }), esc(money2(sale.balance)), 'money-neg') : ''}`
                  : ''
              }
              ${
                admin && sale.cogs !== undefined
                  ? `<div class="sum-sep"></div>${row(t('common.cost'), money(sale.cogs), 'muted')}
                     ${row(t('common.profit'), money(sale.profit), signClass(sale.profit))}`
                  : ''
              }
            </div>
          </div>
          ${
            sale.returns?.length
              ? `<div class="card">
                  <div class="card-head"><div><h3>${esc(t('ret.returns'))}</h3></div></div>
                  <div class="card-body flush"><div class="table-wrap"><table class="data"><tbody>${sale.returns
                    .map(
                      (r) => `<tr class="row-click" data-open-doc="${r.id}">
                        <td><div class="cell-title mono">${esc(r.doc_no)}</div>
                            <div class="cell-sub">${dateText(r.date)} · ${esc(methodText(r.method))}</div></td>
                        <td class="right money-neg">${money(r.total)}</td>
                      </tr>`,
                    )
                    .join('')}</tbody></table></div></div>
                </div>`
              : ''
          }
          ${
            sale.original
              ? `<div class="card"><div class="card-body">
                   <button class="btn btn-block" data-open-doc="${sale.original.id}">${icon('receipt')} ${esc(t('receipt.title', { doc: sale.original.doc_no }))}</button>
                 </div></div>`
              : ''
          }
          <div class="card">
            <div class="card-body">${paymentsHtml(sale)}</div>
          </div>
        </div>
      </div>`;

    root.querySelectorAll('[data-open-doc]').forEach((el) => el.addEventListener('click', () => ctx.navigate(`sales/${el.dataset.openDoc}`)));
    root.querySelector('[data-return]')?.addEventListener('click', async () => {
      const saved = await returnDialog(sale);
      if (!saved) return;
      toast(t(saved.method === 'credit' ? 'ret.done_credit' : 'ret.done', { doc: saved.doc_no, v: money(Math.abs(saved.total)) }), 'success', 5000);
      sale = await api.sale(sale.id);
      paint();
    });
    root.querySelector('[data-print]').addEventListener('click', () => window.print());
    root.querySelector('[data-pay]')?.addEventListener('click', async () => {
      const updated = await recordPayment(sale);
      if (updated) {
        sale = updated;
        paint();
      }
    });
    root.querySelector('[data-void]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('sales.void_title'),
        message: t('sales.void_msg'),
        confirmLabel: t('sales.void_confirm'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteSale(sale.id);
        toast(t('sales.voided'), 'success');
        back();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
    root.querySelectorAll('[data-del-pay]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('pay.delete_title'),
          message: t('pay.delete_msg'),
          confirmLabel: t('common.remove'),
          danger: true,
        });
        if (!ok) return;
        try {
          sale = await api.deletePayment(b.dataset.delPay);
          toast(t('pay.removed'), 'success');
          paint();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }),
    );
  };
  paint();
}

/** #/sales, #/sales/new, #/sales/<id> */
export async function render(root, ctx) {
  if (ctx.params[0] === 'new') return renderSaleForm(root, ctx);
  if (/^\d+$/.test(ctx.params[0] || '')) return renderSale(root, ctx, Number(ctx.params[0]));
  const state = { from: monthStart(), to: todayISO(), search: '', status: '', page: 1, per: 50 };
  // Cost and profit are for administrators; the server leaves them out for cashiers.
  const admin = store.user.role === 'admin';

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    refilter();
  });
  bar.classList.add('sticky-bar');
  // Any change of filter starts again at the first page.
  const refilter = () => {
    state.page = 1;
    load();
  };

  const searchWrap = document.createElement('div');
  searchWrap.className = 'input-icon';
  searchWrap.style.minWidth = '240px';
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('sales.search'))}"/>`;
  searchWrap.querySelector('input').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      refilter();
    }, 250),
  );
  bar.appendChild(searchWrap);

  bar.appendChild(
    filterSelect({
      label: t('filter.status'),
      value: state.status,
      options: [
        { value: '', label: t('filter.all') },
        { value: 'paid', label: t('pay.status_paid') },
        { value: 'partial', label: t('pay.status_partial') },
        { value: 'unpaid', label: t('pay.status_unpaid') },
        { value: 'sales', label: t('filter.invoices') },
        { value: 'returns', label: t('filter.returns') },
      ],
      onChange: (v) => {
        state.status = v;
        refilter();
      },
    }),
  );
  bar.appendChild(
    filterSelect({
      label: t('filter.method'),
      value: '',
      options: [
        { value: '', label: t('filter.all') },
        ...store.methods.map((m) => ({ value: m.name, label: methodText(m.name) })),
      ],
      onChange: (v) => {
        state.method = v;
        refilter();
      },
    }),
  );

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export_csv'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('sell.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('sales/new'));

  let rows = [];

  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-sales-${state.from}-to-${state.to}.csv`,
      rows.map((s) => ({
        invoice: s.doc_no,
        date: s.date,
        customer: s.customer,
        items: s.line_count,
        subtotal: s.subtotal,
        discount: s.discount,
        tax: s.tax,
        total: s.total,
        ...(admin ? { cost: s.cogs, profit: s.profit } : {}),
        method: s.method,
        cashier: s.username || '',
      })),
    ),
  );

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const result = await api.sales({
      from: state.from,
      to: state.to,
      search: state.search,
      // Invoices or returns are a kind of document, not a payment status.
      status: ['sales', 'returns'].includes(state.status) ? '' : state.status,
      kind: state.status === 'returns' ? 'return' : state.status === 'sales' ? 'sale' : '',
      method: state.method,
      page: state.page,
      per: state.per,
    });
    rows = result.rows;

    // The badges above the list count every invoice that matches; the row under
    // the table adds up the page you are looking at.
    const sum = { ...result.sums, qty: rows.reduce((a, s) => a + s.total_qty, 0) };
    const page = rows.reduce(
      (a, s) => ({
        total: a.total + s.total,
        profit: a.profit + (s.profit ?? 0),
        cogs: a.cogs + (s.cogs ?? 0),
        balance: a.balance + s.balance,
      }),
      { total: 0, profit: 0, cogs: 0, balance: 0 },
    );

    body.innerHTML = `
      <div class="card">
        <div class="card-body flush">
          ${
            rows.length
              ? `<div class="table-wrap table-scroll"><table class="data">
                  <thead><tr>
                    <th>${esc(t('sales.invoice'))}</th><th>${esc(t('common.date'))}</th>
                    <th>${esc(t('common.customer'))}</th><th class="right">${esc(t('common.items'))}</th>
                    <th class="right">${esc(t('common.total'))}</th>
                    ${admin ? `<th class="right">${esc(t('common.cost'))}</th><th class="right">${esc(t('common.profit'))}</th>` : ''}
                    <th class="right">${esc(t('pay.paid'))}</th>
                    <th class="right">${esc(t('pay.balance'))}</th>
                    <th>${esc(t('pay.status'))}</th>
                    <th>${esc(t('sales.cashier'))}</th><th></th>
                  </tr></thead>
                  <tbody>${rows
                    .map(
                      (s) => `<tr class="row-click" data-open="${s.id}">
                        <td class="mono nowrap">${esc(s.doc_no)}${s.kind === 'return' ? ` <span class="badge danger">${esc(t('ret.badge'))}</span>` : ''}</td>
                        <td class="nowrap">${dateText(s.date)}</td>
                        <td>${esc(s.customer || t('common.walk_in'))}</td>
                        <td class="right">${qtyText(s.total_qty)}</td>
                        <td class="right"><b>${money(s.total)}</b></td>
                        ${
                          admin
                            ? `<td class="right muted">${money(s.cogs)}</td>
                               <td class="right ${signClass(s.profit)}">${money(s.profit)}</td>`
                            : ''
                        }
                        <td class="right muted">${money(s.paid)}</td>
                        <td class="right ${s.balance > 0.004 ? 'money-neg' : 'muted'}">${money(s.balance)}</td>
                        <td>${payStatus(s)}</td>
                        <td class="muted">${esc(s.username || t('common.none'))}</td>
                        <td class="right nowrap">
                          ${
                            s.balance > 0.004
                              ? `<button class="btn btn-sm" data-pay-row="${s.id}" title="${esc(
                                  t('pay.record'),
                                )}">${icon('coins')} ${esc(t('pay.take'))}</button>`
                              : ''
                          }
                          ${
                            store.user.role === 'admin'
                              ? `<button class="btn btn-sm btn-ghost" data-void="${s.id}" title="${esc(
                                  t('sales.void_tip'),
                                )}" aria-label="${esc(
                                  t('sales.void_tip'),
                                )}">${icon('trash')}</button>`
                              : ''
                          }
                        </td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                  <tfoot><tr>
                    <td colspan="4">${esc(t('page.page_total'))}</td>
                    <td class="right">${money(page.total)}</td>
                    ${
                      admin
                        ? `<td class="right">${money(page.cogs)}</td>
                           <td class="right ${signClass(page.profit)}">${money(page.profit)}</td>`
                        : ''
                    }
                    <td class="right">${money(page.total - page.balance)}</td>
                    <td class="right ${page.balance > 0.004 ? 'money-neg' : ''}">${money(page.balance)}</td>
                    <td colspan="3"></td>
                  </tr></tfoot>
                </table></div>`
              : emptyState(t('sales.none'), t('sales.none_sub'), 'receipt')
          }
        </div>
      </div>`;

    if (rows.length) {
      body.querySelector('.card').append(
        pager(result, ({ page: p, per }) => {
          state.page = p;
          state.per = per;
          load();
        }),
      );
    }

    body.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('[data-void]') || e.target.closest('[data-pay-row]')) return;
        ctx.navigate(`sales/${tr.dataset.open}`);
      }),
    );

    // Taking money owed is a one-click job from the list; no need to open the
    // invoice first.
    body.querySelectorAll('[data-pay-row]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sale = await api.sale(btn.dataset.payRow);
        if (await recordPayment(sale)) load();
      }),
    );

    body.querySelectorAll('[data-void]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: t('sales.void_title'),
          message: t('sales.void_msg'),
          confirmLabel: t('sales.void_confirm'),
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deleteSale(btn.dataset.void);
          toast(t('sales.voided'), 'success');
          load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }),
    );
  }

  await load();
}
