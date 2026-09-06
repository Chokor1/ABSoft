import { api } from '../api.js';
import { icon } from '../icons.js';
import { methodText, t } from '../i18n.js';
import {
  barList,
  chartSvg,
  dateText,
  emptyState,
  esc,
  money,
  number,
  pct,
  qtyText,
  signClass,
  statTile,
  store,
  toast,
} from '../ui.js';

export async function render(root, ctx) {
  ctx.actions.innerHTML = `<button class="btn btn-primary" id="quick-sell">${icon('pos')} ${esc(
    t('dash.new_sale'),
  )}</button>`;
  ctx.actions.querySelector('#quick-sell').addEventListener('click', () => ctx.navigate('pos'));

  const d = await api.dashboard();
  const { today, month, inventory } = d;

  root.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${statTile({
        label: t('dash.today_sales'),
        value: money(today.gross_sales),
        foot: t('dash.today_sales_foot', { n: number(today.sale_count), v: money(today.avg_ticket) }),
        iconName: 'cart',
        tint: 'info',
      })}
      ${statTile({
        label: t('dash.today_profit'),
        value: `<span class="${signClass(today.net_profit)}">${money(today.net_profit)}</span>`,
        foot: t('dash.profit_foot', { g: money(today.gross_profit), e: money(today.expenses) }),
        iconName: 'trendUp',
        tint: today.net_profit >= 0 ? 'success' : 'danger',
      })}
      ${statTile({
        label: t('dash.month_revenue'),
        value: money(month.revenue),
        foot: t('dash.month_revenue_foot', { n: number(month.sale_count), m: pct(month.gross_margin) }),
        iconName: 'coins',
      })}
      ${statTile({
        label: t('dash.month_profit'),
        value: `<span class="${signClass(month.net_profit)}">${money(month.net_profit)}</span>`,
        foot: t('dash.month_profit_foot', { c: money(month.cogs), e: money(month.expenses) }),
        iconName: month.net_profit >= 0 ? 'trendUp' : 'trendDown',
        tint: month.net_profit >= 0 ? 'success' : 'danger',
      })}
    </div>

    <div class="grid cols-2 split-main" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t('dash.last30'))}</h3><div class="sub">${esc(t('dash.last30_sub'))}</div></div>
          <div class="spacer"></div>
          <div class="chart-legend">
            <span><i style="background:var(--accent)"></i>${esc(t('common.revenue'))}</span>
            <span><i style="background:var(--success)"></i>${esc(t('dash.net_profit'))}</span>
          </div>
        </div>
        <div class="card-body">${chartSvg(d.chart)}</div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>${esc(t('dash.inventory'))}</h3>
          <div class="sub">${esc(t('dash.inventory_sub'))}</div></div></div>
        <div class="card-body">
          <div class="pnl">
            <div class="pnl-row"><span>${esc(t('dash.active_products'))}</span><span class="v">${number(
              inventory.products,
            )}</span></div>
            <div class="pnl-row"><span>${esc(t('dash.stock_value'))}</span><span class="v">${money(
              inventory.stock_value,
            )}</span></div>
            <div class="pnl-row"><span>${esc(t('dash.retail_value'))}</span><span class="v">${money(
              inventory.retail_value,
            )}</span></div>
            <div class="pnl-row"><span>${esc(t('dash.potential_margin'))}</span><span class="v money-pos">${money(
              inventory.retail_value - inventory.stock_value,
            )}</span></div>
            <div class="pnl-row"><span>${esc(t('dash.low_alerts'))}</span><span class="v ${
              inventory.low_stock ? 'money-neg' : 'muted'
            }">${number(inventory.low_stock)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid cols-3">
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('dash.recent_sales'))}</h3></div><div class="spacer"></div>
          ${
            d.receivable?.balance > 0.004
              ? `<span class="badge warn">${esc(t('pay.owed_badge', { v: money(d.receivable.balance) }))}</span>`
              : ''
          }
          <button class="btn btn-sm btn-ghost" data-go="sales">${esc(t('dash.view_all'))}</button></div>
        <div class="card-body flush">
          ${
            d.recent_sales.length
              ? `<div class="table-wrap"><table class="data"><tbody>${d.recent_sales
                  .map(
                    (s) => `<tr class="row-click" data-sale="${s.id}">
                      <td><div class="cell-title mono">${esc(s.doc_no)}</div>
                          <div class="cell-sub">${esc(s.customer || t('common.walk_in'))} · ${dateText(s.date)}</div></td>
                      <td class="right"><div class="cell-title">${money(s.total)}</div>
                          <div class="cell-sub">${esc(methodText(s.method))}</div></td>
                    </tr>`,
                  )
                  .join('')}</tbody></table></div>`
              : emptyState(t('dash.no_sales'), t('dash.no_sales_sub'), 'receipt')
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>${esc(t('dash.low_stock'))}</h3>
            <div class="sub">${esc(t('dash.low_stock_sub'))}</div></div>
          <div class="spacer"></div><button class="btn btn-sm btn-ghost" data-go="products">${esc(
            t('dash.manage'),
          )}</button></div>
        <div class="card-body flush">
          ${
            d.low_stock.length
              ? `<div class="table-wrap"><table class="data"><tbody>${d.low_stock
                  .map(
                    (p) => `<tr>
                      <td><div class="cell-title">${esc(p.name)}</div>
                          <div class="cell-sub">${esc(
                            t('dash.minimum', { q: qtyText(p.min_stock), u: p.unit }),
                          )}</div></td>
                      <td class="right"><span class="badge ${p.stock <= 0 ? 'danger' : 'warn'}">${qtyText(p.stock)} ${esc(
                        p.unit,
                      )}</span></td>
                    </tr>`,
                  )
                  .join('')}</tbody></table></div>`
              : emptyState(t('dash.stocked_up'), t('dash.stocked_up_sub'), 'check')
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>${esc(t('dash.top_sellers'))}</h3>
          <div class="sub">${esc(t('dash.top_sellers_sub'))}</div></div></div>
        <div class="card-body">
          ${
            d.top_products.length
              ? barList(d.top_products.map((p) => ({ label: `${p.name} · ${qtyText(p.qty)}`, value: p.revenue })))
              : emptyState(t('dash.nothing_sold'), t('dash.nothing_sold_sub'), 'chart')
          }
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go)));
  root.querySelectorAll('[data-sale]').forEach((tr) =>
    tr.addEventListener('click', async () => {
      const { showReceipt } = await import('./sales.js');
      showReceipt(await api.sale(tr.dataset.sale));
    }),
  );

  if (store.settings.low_stock_alert === '1' && inventory.low_stock > 0) {
    toast(t('dash.restock_warning', { n: inventory.low_stock }), 'warn');
  }
}
