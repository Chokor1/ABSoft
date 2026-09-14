import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, moveText, t } from '../i18n.js';
import { wireNamePickers } from '../name-picker.js';
import {
  chartSvg,
  confirmDialog,
  dateText,
  dateTimeText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  forgetSuggestions,
  formModal,
  formPage,
  money,
  pct,
  productThumb,
  qtyText,
  rangeBar,
  readFields,
  renderFields,
  shiftDays,
  shrinkImage,
  signClass,
  statTile,
  store,
  toast,
  todayISO,
} from '../ui.js';

/** #/products, #/products/new, #/products/<id>[/<tab>] */
export async function render(root, ctx) {
  const [first, second] = ctx.params;
  if (first === 'new') return renderForm(root, ctx);
  if (first && /^\d+$/.test(first)) return renderDetail(root, ctx, Number(first), second === 'edit' ? 'details' : second);
  return renderList(root, ctx);
}

/** The editable fields of a product, shared by the new-product page and the details tab. */
function productFields(product) {
  const isNew = !product;
  return [
    { name: 'name', label: t('prod.name'), required: true, span: 2, value: product?.name, autofocus: isNew },
    {
      name: 'description',
      label: t('common.description'),
      type: 'textarea',
      span: 2,
      value: product?.description || '',
      placeholder: t('prod.description_placeholder'),
      help: t('prod.description_help'),
    },
    { name: 'barcode', label: t('common.barcode'), value: product?.barcode || '', placeholder: t('prod.barcode_placeholder') },
    { name: 'category', label: t('common.category'), value: product?.category || '', names: 'category', placeholder: t('prod.category_placeholder') },
    { name: 'cost', label: t('prod.cost_label'), type: 'number', step: '0.01', min: 0, value: product?.cost ?? 0 },
    { name: 'price', label: t('prod.price_label'), type: 'number', step: '0.01', min: 0, value: product?.price ?? 0 },
    { name: 'unit', label: t('common.unit'), value: product?.unit || 'pcs', placeholder: t('prod.unit_placeholder'), names: 'unit' },
    { name: 'min_stock', label: t('prod.min_stock'), type: 'number', step: 'any', min: 0, value: product?.min_stock ?? 0 },
    ...(isNew
      ? [{ name: 'opening_stock', label: t('prod.opening'), type: 'number', step: 'any', min: 0, value: 0, span: 2, help: t('prod.opening_help') }]
      : [{ name: 'active', label: t('prod.active'), type: 'checkbox', value: !!product.active, span: 2 }]),
  ];
}

/** Ask how to change the stock, then record it. Resolves true when stock moved. */
async function adjustStock(product) {
  const data = await formModal({
    title: t('prod.adjust'),
    subtitle: t('prod.adjust_sub', { name: product.name, q: qtyText(product.stock), u: product.unit }),
    submitLabel: t('prod.adjust_apply'),
    fields: [
      {
        name: 'mode',
        label: t('prod.adjust_type'),
        type: 'select',
        value: 'set',
        options: [
          { value: 'set', label: t('prod.adjust_set') },
          { value: 'add', label: t('prod.adjust_add') },
          { value: 'remove', label: t('prod.adjust_remove') },
        ],
      },
      { name: 'qty', label: t('common.quantity'), type: 'number', step: 'any', min: 0, value: 0, autofocus: true },
      { name: 'note', label: t('prod.adjust_reason'), span: 2, placeholder: t('prod.adjust_reason_placeholder') },
    ],
  });
  if (!data) return false;
  const amount = Number(data.qty) || 0;
  const delta = data.mode === 'set' ? amount - Number(product.stock) : data.mode === 'remove' ? -amount : amount;
  if (!delta) {
    toast(t('prod.adjust_none'), 'warn');
    return false;
  }
  try {
    const res = await api.adjustStock(product.id, delta, data.note);
    toast(res.adjustment ? t('prod.adjusted_doc', { doc: res.adjustment.doc_no }) : t('prod.adjusted'), 'success');
    return true;
  } catch (err) {
    toast(errorText(err), 'error');
    return false;
  }
}

/** Delete, or archive when it already has history. Resolves with the server's answer. */
async function removeProduct(product) {
  const ok = await confirmDialog({
    title: t('prod.delete_title', { name: product.name }),
    message: t('prod.delete_msg'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return null;
  try {
    const res = await api.deleteProduct(product.id);
    toast(res.archived ? t('prod.archived_toast') : t('prod.deleted_toast'), 'success');
    return res;
  } catch (err) {
    toast(errorText(err), 'error');
    return null;
  }
}

/* ------------------------------------------------------------------ list -- */

async function renderList(root, ctx) {
  const state = { search: '', showInactive: false, lowOnly: false, rows: [] };

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('prod.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('products/new'));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      'absoft-products.csv',
      state.rows.map((p) => ({
        name: p.name,
        description: p.description || '',
        barcode: p.barcode || '',
        category: p.category,
        unit: p.unit,
        cost: p.cost,
        price: p.price,
        stock: p.stock,
        stock_value: p.stock_value,
        min_stock: p.min_stock,
        active: p.active ? 'yes' : 'no',
      })),
    ),
  );

  root.innerHTML = `
    <div class="toolbar">
      <div class="input-icon">${icon('search')}
        <input class="input" data-search id="search" placeholder="${esc(t('prod.search'))}"/>
      </div>
      <label class="check"><input type="checkbox" id="low"/> ${esc(t('prod.low_only'))}</label>
      <label class="check"><input type="checkbox" id="inactive"/> ${esc(t('prod.include_archived'))}</label>
      <div class="spacer"></div>
      <div id="summary" class="muted" style="font-size:12.5px"></div>
    </div>
    <div id="list"></div>`;

  const list = root.querySelector('#list');
  root.querySelector('#search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      load();
    }, 220),
  );
  root.querySelector('#low').addEventListener('change', (e) => {
    state.lowOnly = e.target.checked;
    load();
  });
  root.querySelector('#inactive').addEventListener('change', (e) => {
    state.showInactive = e.target.checked;
    load();
  });

  async function load() {
    list.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const rows = await api.products({
      search: state.search,
      all: state.showInactive ? '1' : '',
      low: state.lowOnly ? '1' : '',
    });
    state.rows = rows;

    const stockValue = rows.reduce((s, p) => s + p.stock_value, 0);
    root.querySelector('#summary').textContent = t('prod.summary', { n: rows.length, v: money(stockValue) });

    list.innerHTML = `
      <div class="card"><div class="card-body flush">
        ${
          rows.length
            ? `<div class="table-wrap table-scroll"><table class="data compact product-list">
                <thead><tr>
                  <th>${esc(t('nav.products'))}</th><th>${esc(t('common.barcode'))}</th>
                  <th>${esc(t('common.category'))}</th>
                  <th class="right">${esc(t('common.cost'))}</th><th class="right">${esc(t('common.price'))}</th>
                  <th class="right">${esc(t('common.margin'))}</th>
                  <th class="right">${esc(t('common.stock'))}</th><th class="right">${esc(t('common.value'))}</th>
                </tr></thead>
                <tbody>${rows
                  .map(
                    (p) => `<tr class="row-click" data-open="${p.id}">
                      <td>
                        <span class="cell-title">${esc(p.name)}</span>
                        ${p.active ? '' : `<span class="badge">${esc(t('prod.archived'))}</span>`}
                        ${p.description ? `<span class="cell-inline-sub">${esc(p.description)}</span>` : ''}
                      </td>
                      <td class="mono muted">${esc(p.barcode || t('common.none'))}</td>
                      <td>${
                        p.category
                          ? `<span class="badge">${esc(p.category)}</span>`
                          : `<span class="muted">${t('common.none')}</span>`
                      }</td>
                      <td class="right muted">${money(p.cost)}</td>
                      <td class="right"><b>${money(p.price)}</b></td>
                      <td class="right ${p.margin >= 0 ? 'money-pos' : 'money-neg'}">${pct(p.margin)}</td>
                      <td class="right">
                        <span class="badge ${p.stock <= 0 ? 'danger' : p.stock <= p.min_stock ? 'warn' : 'success'}">
                          ${qtyText(p.stock)} ${esc(p.unit)}
                        </span>
                      </td>
                      <td class="right muted">${money(p.stock_value)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>
                  <td colspan="7">${esc(t('prod.totals', { n: rows.length }))}</td>
                  <td class="right">${money(stockValue)}</td>
                </tr></tfoot>
              </table></div>`
            : emptyState(
                state.search ? t('prod.none_match') : t('prod.none'),
                state.search ? t('prod.none_match_sub') : t('prod.none_sub'),
                'box',
              )
        }
      </div></div>`;

    // Everything else (edit, adjust, picture, delete) lives on the product's own page.
    list.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`products/${tr.dataset.open}`)),
    );
  }

  await load();
}

/* ------------------------------------------------------------- new page -- */

async function renderForm(root, ctx) {
  const back = () => ctx.navigate('products');
  formPage(root, {
    title: t('prod.new'),
    subtitle: t('prod.new_sub'),
    submitLabel: t('prod.create'),
    fields: productFields(null),
    onCancel: back,
    onSubmit: async (data) => {
      try {
        const saved = await api.saveProduct(data);
        toast(t('prod.created'), 'success');
        forgetSuggestions('category');
        forgetSuggestions('unit');
        // Straight to the new product's page, where a picture can be added.
        ctx.navigate(`products/${saved.id}`);
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}

/* ----------------------------------------------------------- detail page -- */

const TABS = ['overview', 'details', 'movements', 'sales', 'purchases'];

async function renderDetail(root, ctx, id, initialTab) {
  const admin = store.user?.role === 'admin';
  let product;
  try {
    product = await api.product(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.navigate('products');
  }
  const state = { tab: TABS.includes(initialTab) ? initialTab : 'overview', from: shiftDays(todayISO(), -29), to: todayISO() };
  let dropPickers = () => {};

  ctx.actions.innerHTML = `
    <button class="btn" id="adjust">${icon('adjust')} ${esc(t('prod.tip_adjust'))}</button>
    <button class="btn btn-ghost" id="remove" title="${esc(t('common.delete'))}">${icon('trash')}</button>`;
  ctx.actions.querySelector('#adjust').addEventListener('click', async () => {
    if (await adjustStock(product)) reload();
  });
  ctx.actions.querySelector('#remove').addEventListener('click', async () => {
    const res = await removeProduct(product);
    if (res?.deleted) ctx.navigate('products');
    else if (res) reload();
  });

  root.innerHTML = `
    <div class="card product-hero" id="hero"></div>
    <div class="tabs-bar sticky-bar">
      <div class="seg" id="tabs">${TABS.map((k) => `<button data-tab="${k}">${esc(t(`prod.tab.${k}`))}</button>`).join('')}</div>
    </div>
    <div id="tab-body"></div>`;

  const hero = root.querySelector('#hero');
  const body = root.querySelector('#tab-body');

  root.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    // Keep the tab in the address, so reload and Back land on the same view.
    history.replaceState(null, '', `#/products/${id}/${state.tab}`);
    showTab();
  });

  async function reload() {
    product = await api.product(id);
    paintHero();
    showTab();
  }

  function paintHero() {
    const low = product.stock <= product.min_stock;
    hero.innerHTML = `
      <div class="ph-main">
        <button type="button" class="btn btn-ghost btn-icon" id="back" aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div class="ph-image ${product.image_at ? 'has-image' : ''}">
          ${productThumb(product, 'lg')}
          <div class="ph-image-actions">
            <label class="btn btn-sm" title="${esc(t('prod.image_upload'))}">
              ${icon('camera')} <span>${esc(product.image_at ? t('prod.image_change') : t('prod.image_add'))}</span>
              <input type="file" id="image-file" accept="image/png,image/jpeg,image/webp" hidden/>
            </label>
            ${
              product.image_at
                ? `<button class="btn btn-sm btn-ghost" id="image-remove" title="${esc(t('prod.image_remove'))}">${icon('trash')}</button>`
                : ''
            }
          </div>
        </div>
        <div class="ph-text">
          <h2>${esc(product.name)}</h2>
          <div class="ph-badges">
            ${product.category ? `<span class="badge">${esc(product.category)}</span>` : ''}
            ${product.barcode ? `<span class="badge mono">${icon('barcode')} ${esc(product.barcode)}</span>` : ''}
            ${product.active ? '' : `<span class="badge">${esc(t('prod.archived'))}</span>`}
            ${product.stock <= 0 ? `<span class="badge danger">${esc(t('prod.out_of_stock'))}</span>` : low ? `<span class="badge warn">${esc(t('prod.low'))}</span>` : ''}
          </div>
          ${product.description ? `<p class="muted">${esc(product.description)}</p>` : ''}
        </div>
      </div>
      <div class="stats ph-stats">
        ${statTile({
          label: t('common.stock'),
          value: `${qtyText(product.stock)} <small>${esc(product.unit)}</small>`,
          foot: t('prod.min_level', { q: qtyText(product.min_stock) }),
          tint: product.stock <= 0 ? 'danger' : low ? 'warn' : 'success',
          iconName: 'box',
        })}
        ${statTile({ label: t('common.price'), value: money(product.price), foot: t('prod.per_unit', { u: product.unit }), iconName: 'coins' })}
        ${statTile({ label: t('common.cost'), value: money(product.cost), foot: `${t('common.margin')} ${pct(product.margin)}`, iconName: 'truck' })}
        ${statTile({ label: t('common.value'), value: money(product.stock_value), foot: t('prod.stock_value_foot'), iconName: 'wallet' })}
        ${statTile({
          label: t('prod.sold_30'),
          value: `${qtyText(product.sold_30)} <small>${esc(product.unit)}</small>`,
          foot: money(product.revenue_30),
          tint: 'info',
          iconName: 'trendUp',
        })}
      </div>`;

    hero.querySelector('#back').addEventListener('click', () => ctx.navigate('products'));
    hero.querySelector('#image-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = await shrinkImage(file);
        // The image routes answer with the bare product; keep the history already loaded.
        product = { ...product, ...(await api.uploadProductImage(id, data)) };
        toast(t('prod.image_saved'), 'success');
        paintHero();
      } catch (err) {
        toast(err.code || err.status ? errorText(err) : t('prod.image_unreadable'), 'error');
      }
    });
    hero.querySelector('#image-remove')?.addEventListener('click', async () => {
      product = { ...product, ...(await api.deleteProductImage(id)) };
      toast(t('prod.image_removed'), 'success');
      paintHero();
    });
  }

  function showTab() {
    dropPickers();
    dropPickers = () => {};
    root.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('common.loading'))}</p></div></div></div>`;
    ({ overview: tabOverview, details: tabDetails, movements: tabMovements, sales: tabSales, purchases: tabPurchases })[state.tab]();
  }

  /* Overview: the last 30 days of selling and the latest movements, at a glance. */
  async function tabOverview() {
    const report = await api.productSales(id, { from: shiftDays(todayISO(), -29), to: todayISO() });
    if (state.tab !== 'overview') return;
    const s = report.summary;
    body.innerHTML = `
      <div class="grid cols-2 split-wide" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h3>${esc(t('prod.sales_30'))}</h3>
            <div class="sub">${esc(t('prod.sales_30_sub', { n: s.invoices, q: qtyText(s.qty), u: product.unit }))}</div></div>
            <div class="spacer"></div>
            <span class="badge accent">${money(s.revenue)}</span>
            ${admin ? `<span class="badge ${s.profit >= 0 ? 'success' : 'danger'}">${esc(t('sales.profit_badge', { v: money(s.profit) }))}</span>` : ''}
          </div>
          <div class="card-body">${chartSvg(filledSeries(report.byDay, report.from, report.to), { barKey: 'revenue', lineKey: 'profit' })}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>${esc(t('prod.latest_moves'))}</h3></div>
            <div class="spacer"></div>
            <button class="btn btn-sm btn-ghost" data-goto="movements">${esc(t('prod.see_all'))}</button></div>
          <div class="card-body flush">${
            product.history.length
              ? `<table class="data compact"><tbody>${product.history
                  .slice(0, 8)
                  .map(
                    (m) => `<tr>
                      <td class="nowrap muted">${dateText(m.created_at)}</td>
                      <td><span class="badge ${m.qty > 0 ? 'success' : 'danger'}">${esc(moveText(m.kind))}</span></td>
                      <td class="right ${m.qty > 0 ? 'money-pos' : 'money-neg'}"><b>${m.qty > 0 ? '+' : ''}${qtyText(m.qty)}</b></td>
                    </tr>`,
                  )
                  .join('')}</tbody></table>`
              : emptyState(t('prod.hist_none'), t('prod.hist_none_sub'), 'history')
          }</div>
        </div>
      </div>`;
    body.querySelector('[data-goto]')?.addEventListener('click', (e) => {
      state.tab = e.currentTarget.dataset.goto;
      history.replaceState(null, '', `#/products/${id}/${state.tab}`);
      showTab();
    });
  }

  /* Details: the product's fields, edited right here. */
  function tabDetails() {
    const fields = productFields(product);
    body.innerHTML = `
      <form class="card form-page" id="page-form" novalidate>
        <div class="card-head"><div><h3>${esc(t('prod.edit'))}</h3><div class="sub">${esc(t('prod.edit_sub'))}</div></div></div>
        <div class="card-body"><div class="form-grid">${renderFields(fields)}</div></div>
        <div class="card-head form-actions">
          <div class="spacer"></div>
          <button type="submit" class="btn btn-primary">${icon('check')} ${esc(t('common.save_changes'))}</button>
        </div>
      </form>`;
    const form = body.querySelector('#page-form');
    dropPickers = wireNamePickers(form, fields);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) return form.reportValidity();
      try {
        await api.saveProduct({ ...readFields(form, fields), id });
        forgetSuggestions('category');
        forgetSuggestions('unit');
        toast(t('prod.updated'), 'success');
        product = await api.product(id);
        paintHero();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
  }

  /* Movements: every stock change, with the balance after each. */
  function tabMovements() {
    let running = Number(product.stock);
    const rows = product.history.map((m) => {
      const after = running;
      running -= Number(m.qty);
      return { ...m, after };
    });
    const moved = (sign) => rows.filter((m) => Math.sign(m.qty) === sign).reduce((a, m) => a + Math.abs(m.qty), 0);
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('prod.tab.movements'))}</h3>
          <div class="sub">${esc(t('prod.moves_sub', { n: rows.length }))}</div></div></div>
        <div class="card-body flush">${
          rows.length
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('prod.hist_when'))}</th><th>${esc(t('prod.hist_type'))}</th>
                  <th class="right">${esc(t('prod.hist_change'))}</th><th class="right">${esc(t('prod.hist_balance'))}</th>
                  ${admin ? `<th class="right">${esc(t('prod.hist_unit_cost'))}</th>` : ''}
                  <th>${esc(t('prod.hist_ref'))}</th><th>${esc(t('common.user'))}</th></tr></thead>
                <tbody>${rows
                  .map(
                    (m) => `<tr>
                      <td class="nowrap">${dateTimeText(m.created_at)}</td>
                      <td><span class="badge ${m.qty > 0 ? 'success' : 'danger'}">${esc(moveText(m.kind))}</span></td>
                      <td class="right ${m.qty > 0 ? 'money-pos' : 'money-neg'}">${m.qty > 0 ? '+' : ''}${qtyText(m.qty)}</td>
                      <td class="right">${qtyText(m.after)}</td>
                      ${admin ? `<td class="right muted">${money(m.unit_cost)}</td>` : ''}
                      <td class="muted">${esc(m.note || '')}</td>
                      <td class="muted">${esc(m.username || t('common.none'))}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>
                  <td colspan="2">${esc(t('common.totals'))}</td>
                  <td class="right"><span class="money-pos">+${qtyText(moved(1))}</span> / <span class="money-neg">−${qtyText(moved(-1))}</span></td>
                  <td class="right">${qtyText(product.stock)}</td>
                  <td colspan="${admin ? 3 : 2}"></td>
                </tr></tfoot>
              </table></div>`
            : emptyState(t('prod.hist_none'), t('prod.hist_none_sub'), 'history')
        }</div>
      </div>`;
  }

  /* Sales: a report for any period, with every line that sold it. */
  async function tabSales() {
    const bar = rangeBar(state, (r) => {
      Object.assign(state, r);
      tabSales();
    });
    const report = await api.productSales(id, { from: state.from, to: state.to });
    if (state.tab !== 'sales') return;
    const s = report.summary;
    body.innerHTML = '';
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `
      ${statTile({ label: t('prod.qty_sold'), value: `${qtyText(s.qty)} <small>${esc(product.unit)}</small>`, foot: t('prod.invoices_n', { n: s.invoices }), iconName: 'cart' })}
      ${statTile({ label: t('common.revenue'), value: money(s.revenue), tint: 'info', iconName: 'receipt' })}
      ${admin ? statTile({ label: t('common.cost'), value: money(s.cost), iconName: 'truck' }) : ''}
      ${admin ? statTile({ label: t('common.profit'), value: money(s.profit), foot: `${t('common.margin')} ${pct(s.margin)}`, tint: s.profit >= 0 ? 'success' : 'danger', iconName: 'trendUp' }) : ''}`;
    const table = document.createElement('div');
    table.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('prod.sale_lines'))}</h3>
          <div class="sub">${dateText(report.from)} → ${dateText(report.to)}</div></div></div>
        <div class="card-body flush">${
          report.lines.length
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('common.date'))}</th><th>${esc(t('sales.invoice'))}</th><th>${esc(t('common.customer'))}</th>
                  <th class="right">${esc(t('common.qty'))}</th><th class="right">${esc(t('common.price'))}</th>
                  <th class="right">${esc(t('common.discount'))}</th><th class="right">${esc(t('common.total'))}</th>
                  ${admin ? `<th class="right">${esc(t('common.profit'))}</th>` : ''}</tr></thead>
                <tbody>${report.lines
                  .map(
                    (l) => `<tr class="row-click" data-sale="${l.sale_id}">
                      <td class="nowrap">${dateText(l.date)}</td>
                      <td class="mono">${esc(l.doc_no)}</td>
                      <td>${esc(l.customer || t('common.walk_in'))}</td>
                      <td class="right">${qtyText(l.qty)}</td>
                      <td class="right">${money(l.unit_price)}</td>
                      <td class="right muted">${l.discount ? money(l.discount) : ''}</td>
                      <td class="right"><b>${money(l.total)}</b></td>
                      ${admin ? `<td class="right ${signClass(l.profit)}">${money(l.profit)}</td>` : ''}
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>
                  <td colspan="3">${esc(t('common.totals'))}</td>
                  <td class="right">${qtyText(s.qty)}</td><td></td><td></td>
                  <td class="right">${money(s.revenue)}</td>
                  ${admin ? `<td class="right ${signClass(s.profit)}">${money(s.profit)}</td>` : ''}
                </tr></tfoot>
              </table></div>`
            : emptyState(t('prod.no_sales'), t('prod.no_sales_sub'), 'receipt')
        }</div>
      </div>`;
    body.append(bar, stats, table);
    body.querySelectorAll('[data-sale]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`sales/${tr.dataset.sale}`)),
    );
  }

  /* Purchases: what it was bought at, from whom. */
  async function tabPurchases() {
    const lines = await api.productPurchases(id);
    if (state.tab !== 'purchases') return;
    const totalQty = lines.reduce((a, l) => a + l.qty, 0);
    const totalValue = lines.reduce((a, l) => a + l.total, 0);
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('prod.tab.purchases'))}</h3>
          <div class="sub">${esc(t('prod.purchases_sub', { n: lines.length }))}</div></div></div>
        <div class="card-body flush">${
          lines.length
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('common.date'))}</th><th>${esc(t('buy.document'))}</th><th>${esc(t('common.supplier'))}</th>
                  <th class="right">${esc(t('common.qty'))}</th><th class="right">${esc(t('buy.unit_cost'))}</th>
                  <th class="right">${esc(t('common.total'))}</th></tr></thead>
                <tbody>${lines
                  .map(
                    (l) => `<tr class="row-click" data-purchase="${l.purchase_id}">
                      <td class="nowrap">${dateText(l.date)}</td>
                      <td class="mono">${esc(l.doc_no)}</td>
                      <td>${esc(l.supplier || t('common.none'))}</td>
                      <td class="right">${qtyText(l.qty)}</td>
                      <td class="right">${money(l.unit_cost)}</td>
                      <td class="right"><b>${money(l.total)}</b></td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>
                  <td colspan="3">${esc(t('common.totals'))}</td>
                  <td class="right">${qtyText(totalQty)}</td>
                  <td class="right muted">${totalQty ? money(totalValue / totalQty) : ''}</td>
                  <td class="right">${money(totalValue)}</td>
                </tr></tfoot>
              </table></div>`
            : emptyState(t('prod.no_purchases'), t('prod.no_purchases_sub'), 'truck')
        }</div>
      </div>`;
    body.querySelectorAll('[data-purchase]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`purchases/${tr.dataset.purchase}`)),
    );
  }

  paintHero();
  showTab();
  return () => dropPickers();
}

/** One point per day across the range, so quiet days show as gaps rather than vanish. */
function filledSeries(byDay, from, to) {
  const map = new Map(byDay.map((d) => [d.date, d]));
  const out = [];
  for (let day = from; day <= to && out.length < 400; day = shiftDays(day, 1)) {
    out.push(map.get(day) || { date: day, revenue: 0, profit: 0, qty: 0 });
  }
  return out;
}
