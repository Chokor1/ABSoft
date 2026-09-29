import { api } from '../api.js';
import * as analysis from './analysis.js';
import { icon } from '../icons.js';
import { isRtl, methodText, moveText, t } from '../i18n.js';
import {
  barList,
  chartSvg,
  dateText,
  dateTimeText,
  downloadCsv,
  emptyState,
  esc,
  money,
  monthStart,
  number,
  pct,
  qtyText,
  rangeBar,
  toTop,
  signClass,
  statTile,
  todayISO,
} from '../ui.js';

const TAB_KEYS = ['pnl', 'analysis', 'products', 'stock', 'history', 'staff'];
// Kept while moving between tabs, including a trip through Sales analysis.
const range = { from: monthStart(), to: todayISO() };
const arrow = () => (isRtl() ? '←' : '→');

/** #/reports[/<tab>], #/reports/analysis[/<filter>/<value>…] */
export async function render(root, ctx) {
  const first = ctx.params[0];
  const tabsHtml = (active) =>
    TAB_KEYS.map((key) => `<button data-tab="${key}" class="${key === active ? 'active' : ''}">${esc(t(`rep.tab.${key}`))}</button>`).join('');

  const state = { ...range, tab: TAB_KEYS.includes(first) ? first : 'pnl' };

  /** The report menu, first on the one line every report shares. */
  const reportTabs = (active) => {
    const tabs = document.createElement('div');
    tabs.className = 'seg';
    tabs.id = 'report-tabs';
    tabs.innerHTML = tabsHtml(active);
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || btn.dataset.tab === active) return;
      // Sales analysis is a screen of its own; the rest change in place.
      if (btn.dataset.tab === 'analysis' || active === 'analysis') return ctx.navigate(`reports/${btn.dataset.tab}`);
      state.tab = btn.dataset.tab;
      // The tab is in the address, so reload and Back land on it.
      history.replaceState(null, '', `#/reports/${state.tab}`);
      toTop();
      load();
    });
    return tabs;
  };

  // Sales analysis has filters of its own, and takes the same line for the menu.
  if (first === 'analysis') {
    root.innerHTML = '<div id="analysis-root"></div>';
    return analysis.render(
      root.querySelector('#analysis-root'),
      { ...ctx, params: ctx.params.slice(1) },
      { lead: reportTabs('analysis') },
    );
  }

  let exportRows = () => [];

  ctx.actions.innerHTML = `
    <button class="btn" id="print">${icon('print')} ${esc(t('common.print'))}</button>
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export_csv'))}</button>`;
  ctx.actions.querySelector('#print').addEventListener('click', () => window.print());
  ctx.actions
    .querySelector('#export')
    .addEventListener('click', () => downloadCsv(`absoft-${state.tab}-${state.from}-to-${state.to}.csv`, exportRows()));

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    Object.assign(range, r);
    load();
  });
  // The report menu, the dates and the buttons share one line, which stays in
  // reach while a long report scrolls.
  bar.classList.add('sticky-bar', 'reports-bar');
  bar.insertBefore(reportTabs(state.tab), bar.firstChild);
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  bar.append(spacer, ctx.actions);

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    bar.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const range = { from: state.from, to: state.to };

    if (state.tab === 'pnl') {
      const r = await api.pnl(range);
      exportRows = () => [
        { line: t('rep.net_revenue'), amount: r.revenue },
        { line: t('rep.cogs'), amount: -r.cogs },
        { line: t('rep.gross_profit'), amount: r.gross_profit },
        ...r.expense_breakdown.map((e) => ({ line: `${t('rep.expenses')} · ${e.category}`, amount: -e.amount })),
        { line: t('rep.opex'), amount: -r.expenses },
        { line: t('rep.net_profit'), amount: r.net_profit },
      ];
      body.innerHTML = pnlHtml(r);
      return;
    }

    if (state.tab === 'products') {
      const rows = await api.productReport(range);
      exportRows = () => rows;
      body.innerHTML = tableCard({
        title: t('rep.tab.products'),
        subtitle: t('rep.prod_sub', { n: rows.length, from: dateText(state.from), to: dateText(state.to) }),
        head: `<tr><th>${esc(t('nav.products'))}</th><th>${esc(t('common.category'))}</th>
               <th class="right">${esc(t('rep.qty_sold'))}</th><th class="right">${esc(t('common.revenue'))}</th>
               <th class="right">${esc(t('common.cost'))}</th><th class="right">${esc(t('common.profit'))}</th>
               <th class="right">${esc(t('common.margin'))}</th><th class="right">${esc(t('rep.transactions'))}</th></tr>`,
        rows: rows
          .map(
            (p) => `<tr>
              <td class="cell-title">${esc(p.name)}</td>
              <td>${
                p.category ? `<span class="badge">${esc(p.category)}</span>` : `<span class="muted">${t('common.none')}</span>`
              }</td>
              <td class="right">${qtyText(p.qty)} ${esc(p.unit)}</td>
              <td class="right"><b>${money(p.revenue)}</b></td>
              <td class="right muted">${money(p.cost)}</td>
              <td class="right ${signClass(p.profit)}">${money(p.profit)}</td>
              <td class="right">${pct(p.revenue ? (p.profit / p.revenue) * 100 : 0)}</td>
              <td class="right muted">${number(p.transactions)}</td>
            </tr>`,
          )
          .join(''),
        foot: rows.length
          ? `<tr><td colspan="3">${esc(t('common.totals'))}</td>
             <td class="right">${money(rows.reduce((s, p) => s + p.revenue, 0))}</td>
             <td class="right">${money(rows.reduce((s, p) => s + p.cost, 0))}</td>
             <td class="right">${money(rows.reduce((s, p) => s + p.profit, 0))}</td>
             <td colspan="2"></td></tr>`
          : '',
        empty: [t('rep.prod_none'), t('rep.prod_none_sub'), 'chart'],
      });
      return;
    }

    if (state.tab === 'stock') {
      const rows = await api.stockReport(range);
      exportRows = () => rows;
      const value = rows.reduce((s, p) => s + p.stock_value, 0);
      body.innerHTML = tableCard({
        title: t('rep.tab.stock'),
        subtitle: t('rep.stock_sub', { n: rows.length, v: money(value) }),
        head: `<tr><th>${esc(t('nav.products'))}</th><th>${esc(t('common.barcode'))}</th>
               <th class="right">${esc(t('rep.in'))}</th><th class="right">${esc(t('rep.out'))}</th>
               <th class="right">${esc(t('rep.on_hand'))}</th><th class="right">${esc(t('common.cost'))}</th>
               <th class="right">${esc(t('common.value'))}</th><th class="right">${esc(t('rep.retail'))}</th></tr>`,
        rows: rows
          .map(
            (p) => `<tr>
              <td><div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(p.category || '')}</div></td>
              <td class="mono muted">${esc(p.barcode || t('common.none'))}</td>
              <td class="right money-pos">${qtyText(p.qty_in)}</td>
              <td class="right money-neg">${qtyText(p.qty_out)}</td>
              <td class="right"><span class="badge ${
                p.stock <= 0 ? 'danger' : p.stock <= p.min_stock ? 'warn' : 'success'
              }">${qtyText(p.stock)} ${esc(p.unit)}</span></td>
              <td class="right muted">${money(p.cost)}</td>
              <td class="right"><b>${money(p.stock_value)}</b></td>
              <td class="right muted">${money(p.stock * p.price)}</td>
            </tr>`,
          )
          .join(''),
        foot: rows.length
          ? `<tr><td colspan="6">${esc(t('rep.total_stock_value'))}</td><td class="right">${money(value)}</td>
             <td class="right">${money(rows.reduce((s, p) => s + p.stock * p.price, 0))}</td></tr>`
          : '',
        empty: [t('rep.stock_none'), t('rep.stock_none_sub'), 'box'],
      });
      return;
    }

    if (state.tab === 'history') {
      const rows = await api.stockHistory(range);
      exportRows = () => rows.map(({ id, ref_table, ref_id, ...rest }) => rest);
      body.innerHTML = tableCard({
        title: t('rep.hist_title'),
        subtitle: t('rep.hist_sub', { n: rows.length }),
        head: `<tr><th>${esc(t('prod.hist_when'))}</th><th>${esc(t('nav.products'))}</th>
               <th>${esc(t('prod.hist_type'))}</th><th class="right">${esc(t('prod.hist_change'))}</th>
               <th class="right">${esc(t('prod.hist_unit_cost'))}</th><th>${esc(t('prod.hist_ref'))}</th>
               <th>${esc(t('common.user'))}</th></tr>`,
        rows: rows
          .map(
            (m) => `<tr>
              <td class="nowrap muted">${dateTimeText(m.created_at)}</td>
              <td><div class="cell-title">${esc(m.name)}</div><div class="cell-sub mono">${esc(m.barcode || '')}</div></td>
              <td><span class="badge ${m.qty > 0 ? 'success' : 'danger'}">${esc(moveText(m.kind))}</span></td>
              <td class="right ${m.qty > 0 ? 'money-pos' : 'money-neg'}">${m.qty > 0 ? '+' : ''}${qtyText(m.qty)} ${esc(
                m.unit,
              )}</td>
              <td class="right muted">${money(m.unit_cost)}</td>
              <td class="muted">${esc(m.note || '')}</td>
              <td class="muted">${esc(m.username || t('common.none'))}</td>
            </tr>`,
          )
          .join(''),
        foot: rows.length
          ? `<tr><td colspan="3">${esc(t('common.totals'))}</td>
             <td class="right"><span class="money-pos">+${qtyText(rows.filter((m) => m.qty > 0).reduce((s, m) => s + m.qty, 0))}</span>
               / <span class="money-neg">−${qtyText(rows.filter((m) => m.qty < 0).reduce((s, m) => s - m.qty, 0))}</span></td>
             <td colspan="3"></td></tr>`
          : '',
        empty: [t('rep.hist_none'), t('rep.hist_none_sub'), 'history'],
      });
      return;
    }

    const rows = await api.staffReport(range);
    exportRows = () => rows;
    body.innerHTML = tableCard({
      title: t('rep.staff_title'),
      subtitle: `${dateText(state.from)} ${arrow()} ${dateText(state.to)}`,
      head: `<tr><th>${esc(t('common.user'))}</th><th class="right">${esc(t('users.sales'))}</th>
             <th class="right">${esc(t('common.revenue'))}</th><th class="right">${esc(t('common.profit'))}</th>
             <th class="right">${esc(t('rep.avg_ticket'))}</th></tr>`,
      rows: rows
        .map(
          (s) => `<tr>
            <td><div class="cell-title">${esc(s.full_name || s.username)}</div>
                <div class="cell-sub">${esc(s.username)}</div></td>
            <td class="right">${number(s.sales)}</td>
            <td class="right"><b>${money(s.revenue)}</b></td>
            <td class="right ${signClass(s.profit)}">${money(s.profit)}</td>
            <td class="right muted">${money(s.sales ? s.revenue / s.sales : 0)}</td>
          </tr>`,
        )
        .join(''),
      foot: rows.length
        ? `<tr><td>${esc(t('common.totals'))}</td>
           <td class="right">${number(rows.reduce((a, s) => a + s.sales, 0))}</td>
           <td class="right">${money(rows.reduce((a, s) => a + s.revenue, 0))}</td>
           <td class="right">${money(rows.reduce((a, s) => a + s.profit, 0))}</td><td></td></tr>`
        : '',
      empty: [t('rep.staff_none'), t('rep.staff_none_sub'), 'users'],
    });
  }

  await load();
}

function pnlHtml(r) {
  const expenseRows = r.expense_breakdown.length
    ? r.expense_breakdown
        .map(
          (e) =>
            `<div class="pnl-row sub"><span>${esc(e.category)} <span class="muted">(${e.count})</span></span>
             <span class="v">${money(e.amount)}</span></div>`,
        )
        .join('')
    : `<div class="pnl-row sub"><span class="muted">${esc(t('rep.no_expenses_row'))}</span><span class="v">${money(
        0,
      )}</span></div>`;

  return `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${statTile({
        label: t('common.revenue'),
        value: money(r.revenue),
        foot: t('rep.sales_avg', { n: number(r.sale_count), v: money(r.avg_ticket) }),
        iconName: 'coins',
        tint: 'info',
      })}
      ${statTile({
        label: t('rep.gross_profit'),
        value: `<span class="${signClass(r.gross_profit)}">${money(r.gross_profit)}</span>`,
        foot: t('rep.margin_foot', { m: pct(r.gross_margin) }),
        iconName: 'trendUp',
        tint: 'success',
      })}
      ${statTile({
        label: t('rep.expenses'),
        value: money(r.expenses),
        foot: t('rep.entries', { n: number(r.expense_count) }),
        iconName: 'wallet',
        tint: 'warn',
      })}
      ${statTile({
        label: t('rep.net_profit'),
        value: `<span class="${signClass(r.net_profit)}">${money(r.net_profit)}</span>`,
        foot: t('rep.net_margin_foot', { m: pct(r.net_margin) }),
        iconName: r.net_profit >= 0 ? 'trendUp' : 'trendDown',
        tint: r.net_profit >= 0 ? 'success' : 'danger',
      })}
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('rep.statement'))}</h3>
          <div class="sub">${dateText(r.from)} ${arrow()} ${dateText(r.to)}</div></div></div>
        <div class="card-body">
          <div class="pnl">
            <div class="pnl-row strong"><span>${esc(t('rep.gross_sales'))}</span><span class="v">${money(
              r.gross_sales,
            )}</span></div>
            ${
              r.tax_collected
                ? `<div class="pnl-row sub"><span>${esc(t('rep.less_tax'))}</span><span class="v">−${money(
                    r.tax_collected,
                  )}</span></div>`
                : ''
            }
            ${
              r.discounts
                ? `<div class="pnl-row sub"><span>${esc(t('rep.discounts'))}</span><span class="v">${money(
                    r.discounts,
                  )}</span></div>`
                : ''
            }
            <div class="pnl-row"><span><b>${esc(t('rep.net_revenue'))}</b></span><span class="v">${money(
              r.revenue,
            )}</span></div>
            <div class="pnl-row"><span>${esc(t('rep.cogs'))}</span><span class="v money-neg">−${money(
              r.cogs,
            )}</span></div>
            <div class="pnl-row strong"><span>${esc(t('rep.gross_profit'))}</span>
              <span class="v ${signClass(r.gross_profit)}">${money(r.gross_profit)}
              <span class="muted" style="font-weight:500">(${pct(r.gross_margin)})</span></span></div>
            <div class="pnl-row"><span><b>${esc(t('rep.opex'))}</b></span><span class="v money-neg">−${money(
              r.expenses,
            )}</span></div>
            ${expenseRows}
            <div class="pnl-row final"><span>${esc(t('rep.net_profit'))}</span><span class="v">${money(
              r.net_profit,
            )}</span></div>
          </div>
          <p class="muted" style="margin-top:14px;font-size:12px">
            ${esc(t('rep.purchases_note', { v: money(r.purchases) }))}
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t('rep.daily_trend'))}</h3><div class="sub">${esc(t('rep.daily_trend_sub'))}</div></div>
          <div class="spacer"></div>
          <div class="chart-legend">
            <span><i style="background:var(--accent)"></i>${esc(t('common.revenue'))}</span>
            <span><i style="background:var(--success)"></i>${esc(t('rep.gross_profit'))}</span>
            <span><i style="background:var(--warn)"></i>${esc(t('rep.expenses'))}</span>
          </div>
        </div>
        <div class="card-body">${chartSvg(r.series, { markKey: 'expenses' })}</div>
      </div>
    </div>

    <div class="grid cols-3">
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('rep.exp_by_cat'))}</h3></div></div>
        <div class="card-body">${
          r.expense_breakdown.length
            ? barList(r.expense_breakdown.map((e) => ({ label: e.category, value: e.amount })))
            : emptyState(t('rep.no_expenses'), t('rep.nothing_period'), 'wallet')
        }</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('rep.payment_methods'))}</h3></div></div>
        <div class="card-body">${
          r.payment_breakdown.length
            ? barList(r.payment_breakdown.map((p) => ({ label: methodText(p.method), value: p.amount })))
            : emptyState(t('rep.no_sales'), t('rep.nothing_period'), 'receipt')
        }</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('rep.most_profitable'))}</h3></div></div>
        <div class="card-body">${
          r.top_products.length
            ? barList(r.top_products.slice(0, 8).map((p) => ({ label: p.name, value: p.profit })))
            : emptyState(t('rep.no_sales'), t('rep.nothing_period'), 'box')
        }</div>
      </div>
    </div>`;
}

function tableCard({ title, subtitle, head, rows, foot = '', empty }) {
  return `<div class="card">
    <div class="card-head"><div><h3>${esc(title)}</h3><div class="sub">${esc(subtitle)}</div></div></div>
    <div class="card-body flush">
      ${
        rows
          ? `<div class="table-wrap table-scroll"><table class="data"><thead>${head}</thead><tbody>${rows}</tbody>
             ${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`
          : emptyState(...empty)
      }
    </div>
  </div>`;
}
