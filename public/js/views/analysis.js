import { api } from '../api.js';
import { icon } from '../icons.js';
import { locale, t } from '../i18n.js';
import { attachNamePicker } from '../name-picker.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
import {
  dateText,
  downloadCsv,
  emptyState,
  esc,
  money,
  monthStart,
  number,
  pager,
  pct,
  qtyText,
  rangeBar,
  signClass,
  statTile,
  todayISO,
} from '../ui.js';

/**
 * Sales analysis: every sold line with what it cost and earned, filtered by
 * dates, customer, item and category, and rolled up by invoice, item, category,
 * customer, day or month. Clicking a row looks inside it.
 *
 *   #/analysis
 *   #/analysis/customer/<name>/group/item      (filters and grouping can be linked to)
 */

const GROUPS = ['lines', 'invoice', 'item', 'category', 'customer', 'day', 'month'];
const SAVED = 'absoft-analysis';

const remembered = () => {
  try {
    return JSON.parse(sessionStorage.getItem(SAVED) || 'null');
  } catch {
    return null;
  }
};
const remember = (state) => {
  try {
    sessionStorage.setItem(SAVED, JSON.stringify(state));
  } catch {
    /* private window: the report simply starts fresh next time */
  }
};

const monthText = (ym) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString(locale(), { year: 'numeric', month: 'long' });
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const customerText = (name) => name || t('common.walk_in');
const categoryText = (name) => name || t('an.no_category');
const muted = (text) => `<span class="muted">${esc(text)}</span>`;

/* ---------------------------------------------------------------- columns -- */

// Each column: its heading, the server field it sorts by, how a row and the totals show, and its CSV value.
const num = (key, label, fmt, extra = {}) => ({
  key,
  label,
  sort: key,
  num: true,
  cell: (r) => fmt(r[key], r),
  foot: (tot) => fmt(tot[key], tot),
  csv: (r) => r[key],
  ...extra,
});

const COL = {
  qty: () =>
    num('qty', t('common.qty'), (v, r) => (r.unit ? `${qtyText(v)} ${muted(r.unit)}` : qtyText(v)), {
      foot: (tot) => qtyText(tot.qty),
    }),
  price: () => num('unit_price', t('common.price'), (v) => money(v), { foot: () => '' }),
  avgPrice: () => ({
    key: 'avg_price',
    label: t('an.avg_price'),
    num: true,
    cell: (r) => (r.qty ? money(r.sales / r.qty) : ''),
    foot: () => '',
    csv: (r) => (r.qty ? Math.round((r.sales / r.qty) * 100) / 100 : ''),
  }),
  discount: () => num('discount', t('common.discount'), (v) => (Number(v) ? money(v) : muted(t('common.none')))),
  sales: () => num('sales', t('an.sales'), (v) => `<b>${money(v)}</b>`),
  cost: () => num('cost', t('common.cost'), (v) => `<span class="muted">${money(v)}</span>`),
  profit: () => num('profit', t('common.profit'), (v) => `<span class="${signClass(v)}">${money(v)}</span>`),
  margin: () => num('margin', t('common.margin'), (v) => pct(v)),
  invoices: () => num('invoices', t('an.invoices'), (v) => number(v)),
  lines: () => num('lines', t('common.lines'), (v) => number(v)),
  items: () => num('items', t('common.items'), (v) => number(v)),
  share: () => ({
    key: 'share',
    label: t('an.share'),
    num: true,
    cell: (r, tot) => {
      const share = tot.sales > 0 ? (r.sales / tot.sales) * 100 : 0;
      return `<span class="an-share"><span class="an-share-bar"><i style="width:${Math.max(0, Math.min(100, share)).toFixed(1)}%"></i></span>${pct(share)}</span>`;
    },
    foot: () => '',
    csv: () => undefined,
  }),
};

const MONEY_TAIL = () => [COL.discount(), COL.sales(), COL.cost(), COL.profit(), COL.margin()];

function columnsFor(group) {
  const date = { key: 'date', label: t('common.date'), sort: 'date', cell: (r) => `<span class="nowrap">${dateText(r.date)}</span>`, csv: (r) => r.date };
  const invoice = { key: 'doc_no', label: t('sales.invoice'), sort: 'doc_no', cell: (r) => `<span class="mono nowrap">${esc(r.doc_no)}</span>`, csv: (r) => r.doc_no };
  const customer = { key: 'customer', label: t('common.customer'), sort: 'customer', cell: (r) => (r.customer ? esc(r.customer) : muted(t('common.walk_in'))), csv: (r) => r.customer };
  switch (group) {
    case 'invoice':
      return [invoice, date, customer, COL.lines(), COL.qty(), ...MONEY_TAIL()];
    case 'item':
      return [
        {
          key: 'name',
          label: t('an.item'),
          sort: 'name',
          cell: (r) => `<div class="cell-title">${esc(r.name)}</div><div class="cell-sub">${esc([r.barcode, r.category].filter(Boolean).join(' · '))}</div>`,
          csv: (r) => r.name,
        },
        { key: 'category', label: t('common.category'), csv: (r) => r.category, hidden: true },
        COL.qty(),
        COL.invoices(),
        COL.avgPrice(),
        ...MONEY_TAIL(),
        COL.share(),
      ];
    case 'category':
      return [
        { key: 'label', label: t('common.category'), sort: 'label', cell: (r) => (r.label ? `<span class="badge">${esc(r.label)}</span>` : muted(t('an.no_category'))), csv: (r) => r.label },
        COL.items(),
        COL.qty(),
        COL.invoices(),
        ...MONEY_TAIL(),
        COL.share(),
      ];
    case 'customer':
      return [
        { key: 'label', label: t('common.customer'), sort: 'label', cell: (r) => (r.label ? `<span class="cell-title">${esc(r.label)}</span>` : muted(t('common.walk_in'))), csv: (r) => r.label },
        COL.invoices(),
        COL.items(),
        ...MONEY_TAIL(),
        COL.share(),
      ];
    case 'day':
      return [
        { key: 'label', label: t('common.date'), sort: 'label', cell: (r) => `<span class="nowrap">${dateText(r.label)}</span>`, csv: (r) => r.label },
        COL.invoices(),
        COL.qty(),
        ...MONEY_TAIL(),
      ];
    case 'month':
      return [
        { key: 'label', label: t('an.month'), sort: 'label', cell: (r) => `<span class="nowrap">${esc(monthText(r.label))}</span>`, csv: (r) => r.label },
        COL.invoices(),
        COL.qty(),
        ...MONEY_TAIL(),
      ];
    default:
      return [
        date,
        invoice,
        customer,
        {
          key: 'name',
          label: t('an.item'),
          sort: 'name',
          cell: (r) => `<div class="cell-title">${esc(r.name)}</div>${r.barcode ? `<div class="cell-sub mono">${esc(r.barcode)}</div>` : ''}`,
          csv: (r) => r.name,
        },
        { key: 'category', label: t('common.category'), csv: (r) => r.category, hidden: true },
        COL.qty(),
        COL.price(),
        ...MONEY_TAIL(),
      ];
  }
}

/* ------------------------------------------------------------------- view -- */

export async function render(root, ctx) {
  const fresh = { from: monthStart(), to: todayISO(), group: 'lines', customer: '', product: null, category: '', sort: '', dir: 'desc' };
  const state = { ...fresh, ...(remembered() || {}), page: 1, per: 50 };

  // A link can set filters: #/analysis/customer/<name>/group/item/…
  const params = ctx.params.map((p) => decodeURIComponent(p));
  if (params.length) {
    Object.assign(state, fresh);
    for (let i = 0; i + 1 < params.length; i += 2) {
      const [key, value] = [params[i], params[i + 1]];
      if (key === 'customer' || key === 'category') state[key] = value;
      if (key === 'group' && GROUPS.includes(value)) state.group = value;
      if ((key === 'from' || key === 'to') && /^\d{4}-\d{2}-\d{2}$/.test(value)) state[key] = value;
      if (key === 'product' && /^\d+$/.test(value)) state.product = { id: Number(value), name: '' };
    }
    if (state.product && !state.product.name) {
      state.product.name = await api.product(state.product.id).then((p) => p.name, () => '');
    }
  }

  const pickers = [];

  ctx.actions.innerHTML = `
    <button class="btn" id="print">${icon('print')} ${esc(t('common.print'))}</button>
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export_csv'))}</button>`;
  ctx.actions.querySelector('#print').addEventListener('click', () => window.print());
  ctx.actions.querySelector('#export').addEventListener('click', exportAll);

  root.innerHTML = `
    <div class="sticky-bar an-bar">
      <div id="an-range"></div>
      <div class="toolbar an-filters">
        <div class="filter-select"><span>${esc(t('common.customer'))}</span>
          <div class="combo"><input class="input" id="f-customer" placeholder="${esc(t('filter.all'))}" autocomplete="off"/></div></div>
        <div class="filter-select"><span>${esc(t('an.item'))}</span>
          <div class="combo"><input class="input" id="f-product" placeholder="${esc(t('filter.all'))}" autocomplete="off"/></div></div>
        <div class="filter-select"><span>${esc(t('common.category'))}</span>
          <div class="combo"><input class="input" id="f-category" placeholder="${esc(t('filter.all'))}" autocomplete="off"/></div></div>
        <button class="btn btn-ghost btn-sm" id="f-clear" hidden>${icon('close')} ${esc(t('an.clear'))}</button>
      </div>
    </div>
    <div class="stats an-stats" id="an-stats"></div>
    <div id="an-table"></div>`;

  const statsEl = root.querySelector('#an-stats');
  const tableEl = root.querySelector('#an-table');
  const customerInput = root.querySelector('#f-customer');
  const productInput = root.querySelector('#f-product');
  const categoryInput = root.querySelector('#f-category');
  const clearBtn = root.querySelector('#f-clear');

  const range = rangeBar(state, (r) => {
    Object.assign(state, r);
    refilter();
  });
  range.classList.add('an-range');
  // How the lines are rolled up sits at the end of the dates row.
  range.insertAdjacentHTML(
    'beforeend',
    `<div class="spacer"></div>
     <div class="an-group"><span class="muted">${esc(t('an.show'))}</span>
       <div class="seg" id="groups">${GROUPS.map((g) => `<button data-group="${g}">${esc(t(`an.group.${g}`))}</button>`).join('')}</div>
     </div>`,
  );
  root.querySelector('#an-range').replaceWith(range);

  const refilter = () => {
    state.page = 1;
    load();
  };

  /* Filters. Each box shows the filter it holds; emptying a box lifts it. */
  const paintFilters = () => {
    customerInput.value = state.customer === '-' ? t('common.walk_in') : state.customer;
    productInput.value = state.product?.name || '';
    categoryInput.value = state.category === '-' ? t('an.no_category') : state.category;
    range.querySelector('[name=from]').value = state.from;
    range.querySelector('[name=to]').value = state.to;
    clearBtn.hidden = !(state.customer || state.product || state.category);
    root.querySelectorAll('#groups [data-group]').forEach((b) => b.classList.toggle('active', b.dataset.group === state.group));
    [customerInput, productInput, categoryInput].forEach((el) => el.closest('.filter-select').classList.toggle('is-set', !!el.value));
  };

  pickers.push(
    attachNamePicker(customerInput, {
      kind: 'customer',
      extra: [t('common.walk_in')],
      onPick: (c) => {
        state.customer = c.name === t('common.walk_in') ? '-' : c.name;
        refilter();
      },
    }),
    attachNamePicker(categoryInput, {
      kind: 'category',
      extra: [t('an.no_category')],
      onPick: (c) => {
        state.category = c.name === t('an.no_category') ? '-' : c.name;
        refilter();
      },
    }),
    attachPicker(productInput, {
      search: (q) => api.products({ search: q, limit: 25, all: '1' }),
      render: productOption,
      emptyText: t('buy.no_product_match'),
      onPick: (p) => {
        state.product = { id: p.id, name: p.name };
        productInput.value = p.name;
        refilter();
      },
    }),
  );
  const liftWhenEmptied = (input, clear) =>
    input.addEventListener('change', () => {
      if (!input.value.trim() && clear()) refilter();
    });
  liftWhenEmptied(customerInput, () => state.customer && ((state.customer = ''), true));
  liftWhenEmptied(categoryInput, () => state.category && ((state.category = ''), true));
  productInput.addEventListener('input', () => {
    if (!productInput.value.trim() && state.product) {
      state.product = null;
      refilter();
    }
  });
  clearBtn.addEventListener('click', () => {
    Object.assign(state, { customer: '', product: null, category: '' });
    refilter();
  });

  root.querySelector('#groups').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn || btn.dataset.group === state.group) return;
    state.group = btn.dataset.group;
    state.sort = '';
    refilter();
  });

  const query = (extra = {}) => ({
    from: state.from,
    to: state.to,
    group: state.group,
    customer: state.customer,
    product_id: state.product?.id || '',
    category: state.category,
    sort: state.sort,
    dir: state.dir,
    ...extra,
  });

  async function load() {
    paintFilters();
    const { page, per, ...keep } = state;
    remember(keep);
    tableEl.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('common.loading'))}</p></div></div></div>`;
    const asked = JSON.stringify(query({ page: state.page, per: state.per }));
    const result = await api.salesAnalysis(query({ page: state.page, per: state.per }));
    // A slower answer to an older filter must not paint over a newer one.
    if (asked !== JSON.stringify(query({ page: state.page, per: state.per }))) return;
    paintStats(result.totals);
    paintTable(result);
  }

  function paintStats(tot) {
    statsEl.innerHTML = `
      ${statTile({
        label: t('an.sales'),
        value: money(tot.sales),
        foot: t('an.sales_foot', { n: number(tot.invoices), v: money(tot.invoices ? tot.sales / tot.invoices : 0) }),
        iconName: 'receipt',
        tint: 'info',
      })}
      ${statTile({ label: t('common.cost'), value: money(tot.cost), foot: t('an.cost_foot', { q: qtyText(tot.qty), n: number(tot.items) }), iconName: 'truck' })}
      ${statTile({
        label: t('common.profit'),
        value: `<span class="${signClass(tot.profit)}">${money(tot.profit)}</span>`,
        foot: `${t('common.margin')} ${pct(tot.margin)}`,
        iconName: tot.profit >= 0 ? 'trendUp' : 'trendDown',
        tint: tot.profit >= 0 ? 'success' : 'danger',
      })}
      ${statTile({ label: t('common.discount'), value: money(tot.discount), foot: t('an.discount_foot', { v: money(tot.gross) }), iconName: 'coins', tint: 'warn' })}`;
  }

  function paintTable(result) {
    const cols = columnsFor(state.group).filter((c) => !c.hidden);
    const tot = result.totals;
    const drills = state.group !== 'lines' && state.group !== 'invoice';
    const arrow = (c) => (state.sort === c.sort ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '');
    tableEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t(`an.title.${state.group}`))}</h3>
            <div class="sub">${esc(t('an.sub', { n: number(result.total), from: dateText(result.from), to: dateText(result.to) }))}${
              result.rows.length ? ` · ${esc(t(drills ? 'an.hint_drill' : 'an.hint_open'))}` : ''
            }</div></div>
        </div>
        <div class="card-body flush">${
          result.rows.length
            ? `<div class="table-wrap table-scroll"><table class="data compact an-table">
                <thead><tr>${cols
                  .map(
                    (c) =>
                      `<th class="${c.num ? 'right' : ''} ${c.sort ? 'sortable' : ''}" ${c.sort ? `data-sort="${c.sort}"` : ''}>${esc(c.label)}${arrow(c)}</th>`,
                  )
                  .join('')}</tr></thead>
                <tbody>${result.rows
                  .map(
                    (r, i) =>
                      `<tr class="row-click" data-row="${i}">${cols
                        .map((c) => `<td class="${c.num ? 'right nowrap' : ''}">${c.cell(r, tot)}</td>`)
                        .join('')}</tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>${cols
                  .map((c, i) =>
                    i === 0
                      ? `<td class="nowrap">${esc(result.pages > 1 ? t('an.totals_all') : t('common.totals'))}</td>`
                      : `<td class="${c.num ? 'right nowrap' : ''}">${c.foot ? c.foot(tot) : ''}</td>`,
                  )
                  .join('')}</tr></tfoot>
              </table></div>`
            : emptyState(t('an.none'), t('an.none_sub'), 'chart')
        }</div>
      </div>`;

    tableEl.querySelectorAll('[data-sort]').forEach((th) =>
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        // Names and dates start A→Z / oldest; amounts start biggest.
        const textual = ['date', 'doc_no', 'customer', 'name', 'label'].includes(key);
        state.dir = state.sort === key ? (state.dir === 'asc' ? 'desc' : 'asc') : textual ? 'asc' : 'desc';
        state.sort = key;
        refilter();
      }),
    );
    tableEl.querySelectorAll('[data-row]').forEach((tr) =>
      tr.addEventListener('click', () => drill(result.rows[Number(tr.dataset.row)])),
    );
    if (result.rows.length) {
      tableEl.querySelector('.card').append(
        pager(result, ({ page, per }) => {
          state.page = page;
          state.per = per;
          load();
        }),
      );
    }
  }

  /** One level down: a month into its days, a day or an item into its lines, a customer or category into items. */
  function drill(r) {
    const into = (changes) => {
      Object.assign(state, changes, { sort: '' });
      refilter();
    };
    switch (state.group) {
      case 'lines':
      case 'invoice':
        return ctx.navigate(`sales/${r.sale_id}`);
      case 'item':
        return into({ product: { id: r.product_id, name: r.name }, group: 'invoice' });
      case 'category':
        return into({ category: r.label || '-', group: 'item' });
      case 'customer':
        return into({ customer: r.label || '-', group: 'item' });
      case 'day':
        return into({ from: r.label, to: r.label, group: 'lines' });
      case 'month':
        return into({ from: `${r.label}-01`, to: lastDay(r.label), group: 'day' });
    }
  }

  async function exportAll() {
    const all = await api.salesAnalysis(query({ all: '1' }));
    const cols = columnsFor(state.group).filter((c) => c.csv && c.key !== 'share');
    downloadCsv(
      `absoft-sales-analysis-${state.group}-${state.from}-to-${state.to}.csv`,
      all.rows.map((r) => {
        const row = {};
        for (const c of cols) {
          let value = c.csv(r);
          if (c.key === 'customer' || (state.group === 'customer' && c.key === 'label')) value = customerText(value);
          if (state.group === 'category' && c.key === 'label') value = categoryText(value);
          row[c.key === 'label' ? state.group : c.key] = value;
        }
        return row;
      }),
    );
  }

  await load();
  return () => pickers.forEach((p) => p.destroy());
}
