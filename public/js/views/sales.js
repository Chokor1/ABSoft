import { api } from '../api.js';
import { formatSecond, money2, second, toSecond } from '../currency.js';
import { icon } from '../icons.js';
import { count, errorText, methodText, t } from '../i18n.js';
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
  store,
  toast,
  todayISO,
} from '../ui.js';
import { listSummary, paymentMethods } from '../ui.js';
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
        ${sale.rate2 && second() ? line('', money2(sale.total, sale.rate2), 'r-second') : ''}
        ${line(t('pay.paid'), money(sale.paid))}
        ${(sale.payments || [])
          .filter((p) => p.currency === 'second' && p.amount2)
          .map((p) => line(t('receipt.paid_in', { c: second()?.symbol || '' }), esc(formatSecond(p.amount2)), 'r-second'))
          .join('')}
        ${change > 0.004 ? line(t('receipt.change'), money(change)) : ''}
        ${change > 0.004 && change2 ? line('', esc(formatSecond(change2)), 'r-second') : ''}
        ${sale.balance > 0.004 ? line(t('pay.balance'), money(sale.balance), 'r-total') : ''}
        <div class="r-rule"></div>
        <div class="r-center">${esc(cfg.receipt_footer || '')}</div>
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
  if (sale.balance <= 0.004) return `<span class="badge success">${esc(t('pay.status_paid'))}</span>`;
  if (sale.paid > 0.004) return `<span class="badge warn">${esc(t('pay.status_partial'))}</span>`;
  return `<span class="badge danger">${esc(t('pay.status_unpaid'))}</span>`;
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
    const body = docPage(root, {
      title: t('receipt.title', { doc: sale.doc_no }),
      subtitle: [dateText(sale.date), sale.customer || t('common.walk_in'), sale.username].filter(Boolean).join(' · '),
      badges: `<span class="badge accent">${money(sale.total)}</span> ${payStatus(sale)}`,
      actions: `${admin && sale.customer ? `<button class="btn" data-customer>${icon('users')} ${esc(t('party.open_customer'))}</button>` : ''}
                ${owing ? `<button class="btn btn-primary" data-pay>${icon('coins')} ${esc(t('pay.record'))}</button>` : ''}
                <button class="btn ${owing ? '' : 'btn-primary'}" data-print>${icon('print')} ${esc(t('common.print'))}</button>
                ${admin ? `<button class="btn btn-ghost" data-void title="${esc(t('sales.void_tip'))}">${icon('trash')}</button>` : ''}`,
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
          <div class="card">
            <div class="card-body">${paymentsHtml(sale)}</div>
          </div>
        </div>
      </div>`;

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

  const summary = listSummary(bar);
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
      status: state.status,
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

    summary.innerHTML = `
      <span class="ls-count">${esc(count('sales', result.total))}</span>
      <span class="badge accent">${esc(t('sales.revenue_badge', { v: money(sum.total) }))}</span>
      ${
        admin
          ? `<span class="badge ${sum.profit >= 0 ? 'success' : 'danger'}">${esc(
              t('sales.profit_badge', { v: money(sum.profit) }),
            )}</span>`
          : ''
      }
      ${sum.balance > 0.004 ? `<span class="badge warn">${esc(t('pay.owed_badge', { v: money(sum.balance) }))}</span>` : ''}`;

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
                        <td class="mono nowrap">${esc(s.doc_no)}</td>
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
