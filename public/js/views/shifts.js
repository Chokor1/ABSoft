import { api } from '../api.js';
import { formatSecond, second } from '../currency.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import { printShiftReport } from './pos-shift.js';
import { dateTimeText, docPage, emptyState, esc, money, pager, signClass, store, toast } from '../ui.js';

/** How a counted drawer compares with what it should hold. */
function differenceBadge(s) {
  if (s.status === 'open') return `<span class="badge success">${esc(t('shift.status.open'))}</span>`;
  const d = Number(s.difference) || 0;
  if (Math.abs(d) < 0.005) return `<span class="badge">${esc(t('shift.balanced'))}</span>`;
  return `<span class="badge ${d > 0 ? 'accent' : 'danger'}">${esc(t(d > 0 ? 'shift.over' : 'shift.short'))} ${money(Math.abs(d))}</span>`;
}

/** #/shifts, #/shifts/<id> */
export async function render(root, ctx) {
  if (/^\d+$/.test(ctx.params[0] || '')) return renderDoc(root, ctx, Number(ctx.params[0]));
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  const state = { page: 1, per: 25 };
  if (store.settings.pos_shifts === '1') {
    ctx.actions.innerHTML = `<button class="btn btn-primary" id="to-pos">${icon('pos')} ${esc(t('nav.pos'))}</button>`;
    ctx.actions.querySelector('#to-pos').addEventListener('click', () => ctx.navigate('pos'));
  }
  const bar = document.createElement('div');
  bar.className = 'toolbar sticky-bar';
  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    const result = await api.shifts({ page: state.page, per: state.per });
    if (!result.rows.length) {
      body.innerHTML = `<div class="card"><div class="card-body">${emptyState(
        t('shift.none'),
        t(store.settings.pos_shifts === '1' ? 'shift.none_sub' : 'shift.off_sub'),
        'history',
      )}</div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="card">
        <div class="card-body flush">
          <div class="table-wrap table-scroll"><table class="data" id="shift-table">
            <thead><tr>
              <th>${esc(t('buy.document'))}</th>
              <th>${esc(t('shift.opened_col'))}</th>
              <th>${esc(t('shift.closed_col'))}</th>
              <th class="right">${esc(t('shift.sales'))}</th>
              <th class="right">${esc(t('shift.expected'))}</th>
              <th class="right">${esc(t('shift.counted_col'))}</th>
              <th>${esc(t('shift.status_col'))}</th>
            </tr></thead>
            <tbody>${result.rows
              .map(
                (s) => `<tr class="row-click" data-id="${s.id}">
                  <td><div class="cell-title mono">${esc(s.doc_no)}</div></td>
                  <td>${esc(dateTimeText(s.opened_at))}<div class="cell-sub">${esc(s.opened_by_name || '')}</div></td>
                  <td>${s.closed_at ? `${esc(dateTimeText(s.closed_at))}<div class="cell-sub">${esc(s.closed_by_name || '')}</div>` : '<span class="muted">—</span>'}</td>
                  <td class="right">${money(s.sales_total)}<div class="cell-sub">${esc(t(s.sales === 1 ? 'shift.sales_one' : 'shift.sales_n', { n: s.sales }))}</div></td>
                  <td class="right">${money(s.expected_cash)}</td>
                  <td class="right">${s.status === 'closed' ? money(s.counted_cash) : '<span class="muted">—</span>'}</td>
                  <td>${differenceBadge(s)}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>
        </div>
      </div>`;
    body.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`shifts/${tr.dataset.id}`)));
    body.appendChild(
      pager(result, (p) => {
        Object.assign(state, p);
        load();
      }),
    );
  }
  await load();
}

async function renderDoc(root, ctx, id) {
  const back = () => ctx.navigate('shifts');
  let s;
  try {
    s = await api.shift(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return back();
  }
  const cur = second();
  const row = (label, value, cls = '') => `<div class="sum-row ${cls}"><span>${esc(label)}</span><span class="v">${value}</span></div>`;
  const body = docPage(root, {
    title: t('shift.doc_title', { doc: s.doc_no }),
    subtitle: [
      t('shift.opened_by', { t: dateTimeText(s.opened_at), u: s.opened_by_name || '' }),
      s.closed_at ? t('shift.closed_by', { t: dateTimeText(s.closed_at), u: s.closed_by_name || '' }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
    badges: differenceBadge(s),
    actions: `<button class="btn" data-print>${icon('print')} ${esc(t('common.print'))}</button>`,
    onBack: back,
  });
  const closed = s.status === 'closed';
  body.innerHTML = `
    <div class="shift-close">
      <section class="card"><div class="card-body pay-summary">
        <div class="pay-card-head">${esc(t('shift.taken'))}</div>
        ${row(t(s.sales === 1 ? 'shift.sales_one' : 'shift.sales_n', { n: s.sales }), `<b>${money(s.sales_total)}</b>`)}
        ${s.payments
          .map((p) =>
            row(
              p.currency === 'second' && cur ? `${methodText(p.method)} · ${cur.symbol}` : methodText(p.method),
              p.currency === 'second' && cur ? esc(formatSecond(p.amount2)) : money(p.amount),
            ),
          )
          .join('')}
        ${s.on_account > 0.004 ? row(t('shift.on_account'), money(s.on_account), 'muted') : ''}
      </div></section>
      <section class="card"><div class="card-body pay-summary">
        <div class="pay-card-head">${esc(t('shift.drawer'))}</div>
        ${row(t('shift.opening'), money(s.opening_cash))}
        ${row(t('shift.cash_in'), money(s.cash_in))}
        ${row(t('shift.expected'), `<b>${money(s.expected_cash)}</b>`, 'total')}
        ${closed ? row(t('shift.counted_col'), money(s.counted_cash)) : ''}
        ${closed ? row(t('shift.difference'), `<span class="${signClass(s.difference)}">${money(s.difference, { sign: true })}</span>`) : ''}
        ${
          cur && (s.opening_cash2 || s.expected_cash2 || s.counted_cash2)
            ? `${row(t('shift.expected_in', { c: cur.symbol }), esc(formatSecond(s.expected_cash2)))}
               ${closed ? row(t('shift.counted', { c: cur.symbol }), esc(formatSecond(s.counted_cash2))) : ''}`
            : ''
        }
        ${(s.others || [])
          .map(
            (o) => `<div class="pay-card-head" style="margin-top:12px">${esc(methodText(o.method))}</div>
              ${row(t('shift.expected'), money(o.expected))}
              ${closed ? row(t('shift.counted_col'), money(o.counted)) : ''}
              ${closed ? row(t('shift.difference'), `<span class="${signClass(o.difference)}">${money(o.difference, { sign: true })}</span>`) : ''}`,
          )
          .join('')}
        ${
          closed && s.others?.length
            ? row(t('shift.total_difference'), `<b class="${signClass(s.difference_total)}">${money(s.difference_total, { sign: true })}</b>`, 'total')
            : ''
        }
      </div></section>
    </div>
    ${
      s.opening_note || s.closing_note
        ? `<div class="card"><div class="card-body doc-note">${[s.opening_note, s.closing_note].filter(Boolean).map(esc).join('<br/>')}</div></div>`
        : ''
    }
    <div class="card">
      <div class="card-head"><div><h3>${esc(t('shift.sales'))}</h3></div></div>
      <div class="card-body flush">${
        s.sale_list.length
          ? `<div class="table-wrap table-scroll"><table class="data">
              <thead><tr><th>${esc(t('buy.document'))}</th><th>${esc(t('common.date'))}</th><th>${esc(t('shift.customer'))}</th>
                <th>${esc(t('shift.method'))}</th><th class="right">${esc(t('common.total'))}</th></tr></thead>
              <tbody>${s.sale_list
                .map(
                  (x) => `<tr class="row-click" data-sale="${x.id}">
                    <td class="mono">${esc(x.doc_no)}</td><td>${esc(dateTimeText(x.created_at))}</td>
                    <td>${esc(x.customer || t('shift.walk_in'))}</td><td>${esc(methodText(x.method))}</td>
                    <td class="right">${money(x.total)}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
          : `<div class="empty"><p>${esc(t('shift.no_sales'))}</p></div>`
      }</div>
    </div>`;
  body.querySelectorAll('[data-sale]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`sales/${tr.dataset.sale}`)));
  root.querySelector('[data-print]').addEventListener('click', () => printShiftReport(s));
}
