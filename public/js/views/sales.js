import { api } from '../api.js';
import { icon } from '../icons.js';
import { PAYMENT_METHODS, count, errorText, methodText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  dateTimeText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  formModal,
  modal,
  money,
  monthStart,
  qtyText,
  rangeBar,
  signClass,
  store,
  toast,
  todayISO,
} from '../ui.js';

/**
 * Printable receipt / invoice for a completed sale.
 *
 * `afterSale` is the receipt shown the moment a sale is saved at the till. It is
 * just the document, to print or close: taking the rest of a balance is a later
 * visit's business, and it stays available from Sales History for that.
 */
export function showReceipt(sale, { change = 0, onChanged, afterSale = false } = {}) {
  const cfg = sale.settings || store.settings;
  const line = (label, value, cls = '') =>
    `<div class="r-line ${cls}"><span>${esc(label)}</span><span>${value}</span></div>`;
  const owing = !afterSale && sale.balance > 0.004;

  return modal({
    title: t('receipt.title', { doc: sale.doc_no }),
    subtitle: `${dateText(sale.date)} · ${sale.customer || t('common.walk_in')}`,
    body: `<div class="receipt" id="receipt-print">
        <div class="r-center"><b>${esc(cfg.store_name || t('app.name'))}</b></div>
        <div class="r-center">${esc(sale.doc_no)} · ${dateTimeText(sale.created_at || sale.date)}</div>
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
        ${line(t('pay.paid'), money(sale.paid))}
        ${change > 0.004 ? line(t('receipt.change'), money(change)) : ''}
        ${sale.balance > 0.004 ? line(t('pay.balance'), money(sale.balance), 'r-total') : ''}
        <div class="r-rule"></div>
        <div class="r-center">${esc(cfg.receipt_footer || '')}</div>
      </div>
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
                <td class="right"><b>${money(r.amount)}</b></td>
                <td class="right">${
                  store.user.role === 'admin'
                    ? `<button class="btn btn-sm btn-ghost" data-del-pay="${r.id}" title="${esc(
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
  const data = await formModal({
    title: t('pay.record_title', { doc: sale.doc_no }),
    subtitle: t('pay.record_sub', { balance: money(sale.balance), total: money(sale.total) }),
    submitLabel: t('pay.record'),
    fields: [
      {
        name: 'amount',
        label: t('pay.amount'),
        type: 'number',
        step: '0.01',
        min: 0,
        // Pre-filled with the whole balance: settling in full is the common case,
        // and anything less is just a smaller number typed over it.
        value: sale.balance.toFixed(2),
        required: true,
        autofocus: true,
        help: t('pay.amount_help'),
      },
      {
        name: 'method',
        label: t('pos.payment_method'),
        type: 'select',
        value: 'cash',
        options: PAYMENT_METHODS.map((m) => ({ value: m, label: methodText(m) })),
      },
      { name: 'date', label: t('common.date'), type: 'date', value: todayISO() },
      { name: 'note', label: t('common.note'), span: 2 },
    ],
  });
  if (!data) return null;
  try {
    const updated = await api.addPayment(sale.id, data);
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
  if (sale.balance <= 0.004) return `<span class="badge success">${esc(t('pay.status_paid'))}</span>`;
  if (sale.paid > 0.004) return `<span class="badge warn">${esc(t('pay.status_partial'))}</span>`;
  return `<span class="badge danger">${esc(t('pay.status_unpaid'))}</span>`;
}

export async function render(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '', unpaid: false };

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    load();
  });

  const searchWrap = document.createElement('div');
  searchWrap.className = 'input-icon';
  searchWrap.style.minWidth = '240px';
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('sales.search'))}"/>`;
  searchWrap.querySelector('input').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      load();
    }, 250),
  );
  bar.appendChild(searchWrap);

  const unpaidWrap = document.createElement('label');
  unpaidWrap.className = 'check';
  unpaidWrap.innerHTML = `<input type="checkbox" id="unpaid-only"/> ${esc(t('pay.unpaid_only'))}`;
  unpaidWrap.querySelector('input').addEventListener('change', (e) => {
    state.unpaid = e.target.checked;
    load();
  });
  bar.appendChild(unpaidWrap);

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  ctx.actions.innerHTML = `<button class="btn" id="export">${icon('download')} ${esc(t('common.export_csv'))}</button>`;

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
        cost: s.cogs,
        profit: s.profit,
        method: s.method,
        cashier: s.username || '',
      })),
    ),
  );

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    rows = await api.sales({ from: state.from, to: state.to, search: state.search, unpaid: state.unpaid ? '1' : '' });

    const sum = rows.reduce(
      (a, s) => ({
        total: a.total + s.total,
        profit: a.profit + s.profit,
        cogs: a.cogs + s.cogs,
        qty: a.qty + s.total_qty,
        balance: a.balance + s.balance,
      }),
      { total: 0, profit: 0, cogs: 0, qty: 0, balance: 0 },
    );

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(count('sales', rows.length))}</h3>
          <div class="sub">${dateText(state.from)} → ${dateText(state.to)}</div></div>
          <div class="spacer"></div>
          <span class="badge accent">${esc(t('sales.revenue_badge', { v: money(sum.total) }))}</span>
          <span class="badge ${sum.profit >= 0 ? 'success' : 'danger'}">${esc(
            t('sales.profit_badge', { v: money(sum.profit) }),
          )}</span>
          ${
            sum.balance > 0.004
              ? `<span class="badge warn">${esc(t('pay.owed_badge', { v: money(sum.balance) }))}</span>`
              : ''
          }
        </div>
        <div class="card-body flush">
          ${
            rows.length
              ? `<div class="table-wrap"><table class="data">
                  <thead><tr>
                    <th>${esc(t('sales.invoice'))}</th><th>${esc(t('common.date'))}</th>
                    <th>${esc(t('common.customer'))}</th><th class="right">${esc(t('common.items'))}</th>
                    <th class="right">${esc(t('common.total'))}</th><th class="right">${esc(t('common.cost'))}</th>
                    <th class="right">${esc(t('common.profit'))}</th>
                    <th class="right">${esc(t('pay.paid'))}</th>
                    <th class="right">${esc(t('pay.balance'))}</th>
                    <th>${esc(t('pay.status'))}</th>
                    <th>${esc(t('sales.cashier'))}</th><th></th>
                  </tr></thead>
                  <tbody>${rows
                    .map(
                      (s) => `<tr class="row-click" data-open="${s.id}">
                        <td class="mono">${esc(s.doc_no)}</td>
                        <td class="nowrap">${dateText(s.date)}</td>
                        <td>${esc(s.customer || t('common.walk_in'))}</td>
                        <td class="right">${qtyText(s.total_qty)}</td>
                        <td class="right"><b>${money(s.total)}</b></td>
                        <td class="right muted">${money(s.cogs)}</td>
                        <td class="right ${signClass(s.profit)}">${money(s.profit)}</td>
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
                                )}">${icon('trash')}</button>`
                              : ''
                          }
                        </td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                  <tfoot><tr>
                    <td colspan="4">${esc(t('common.totals'))}</td>
                    <td class="right">${money(sum.total)}</td>
                    <td class="right">${money(sum.cogs)}</td>
                    <td class="right ${signClass(sum.profit)}">${money(sum.profit)}</td>
                    <td class="right">${money(sum.total - sum.balance)}</td>
                    <td class="right ${sum.balance > 0.004 ? 'money-neg' : ''}">${money(sum.balance)}</td>
                    <td colspan="3"></td>
                  </tr></tfoot>
                </table></div>`
              : emptyState(t('sales.none'), t('sales.none_sub'), 'receipt')
          }
        </div>
      </div>`;

    body.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('[data-void]') || e.target.closest('[data-pay-row]')) return;
        showReceipt(await api.sale(tr.dataset.open), { onChanged: load });
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
