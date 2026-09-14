import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, moveText, t } from '../i18n.js';
import {
  confirmDialog,
  dateTimeText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  forgetSuggestions,
  formModal,
  formPage,
  modal,
  money,
  pct,
  qtyText,
  suggestions,
  toast,
} from '../ui.js';

/** #/products, #/products/new, #/products/<id>/edit */
export async function render(root, ctx) {
  const [first, second] = ctx.params;
  if (first === 'new') return renderForm(root, ctx, null);
  if (second === 'edit') return renderForm(root, ctx, Number(first));
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  const state = { search: '', showInactive: false, lowOnly: false, rows: [] };
  let categories = [];
  let units = [];

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
    const [rows, cats, unitNames] = await Promise.all([
      api.products({ search: state.search, all: state.showInactive ? '1' : '', low: state.lowOnly ? '1' : '' }),
      suggestions('category'),
      suggestions('unit'),
    ]);
    state.rows = rows;
    categories = cats;
    units = unitNames;

    const stockValue = rows.reduce((s, p) => s + p.stock_value, 0);
    root.querySelector('#summary').textContent = t('prod.summary', { n: rows.length, v: money(stockValue) });

    list.innerHTML = `
      <div class="card"><div class="card-body flush">
        ${
          rows.length
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr>
                  <th>${esc(t('nav.products'))}</th><th>${esc(t('common.barcode'))}</th>
                  <th>${esc(t('common.category'))}</th>
                  <th class="right">${esc(t('common.cost'))}</th><th class="right">${esc(t('common.price'))}</th>
                  <th class="right">${esc(t('common.margin'))}</th>
                  <th class="right">${esc(t('common.stock'))}</th><th class="right">${esc(t('common.value'))}</th><th></th>
                </tr></thead>
                <tbody>${rows
                  .map(
                    (p) => `<tr class="row-click" data-open="${p.id}">
                      <td>
                        <div class="cell-title">${esc(p.name)} ${
                          p.active ? '' : `<span class="badge">${esc(t('prod.archived'))}</span>`
                        }</div>
                        <div class="cell-sub">${
                          p.description ? esc(p.description) : esc(t('prod.per_unit', { u: p.unit }))
                        }</div>
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
                      <td class="right nowrap">
                        <button class="btn btn-sm btn-ghost" data-adjust="${p.id}" title="${esc(
                          t('prod.tip_adjust'),
                        )}">${icon('refresh')}</button>
                        <button class="btn btn-sm btn-ghost" data-edit="${p.id}" title="${esc(t('common.edit'))}">${icon(
                          'edit',
                        )}</button>
                        <button class="btn btn-sm btn-ghost" data-del="${p.id}" title="${esc(
                          t('common.delete'),
                        )}">${icon('trash')}</button>
                      </td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>`
            : emptyState(
                state.search ? t('prod.none_match') : t('prod.none'),
                state.search ? t('prod.none_match_sub') : t('prod.none_sub'),
                'box',
              )
        }
      </div></div>`;

    list.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        showHistory(tr.dataset.open);
      }),
    );
    list.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => ctx.navigate(`products/${b.dataset.edit}/edit`)),
    );
    list.querySelectorAll('[data-adjust]').forEach((b) =>
      b.addEventListener('click', () => adjustStock(rows.find((p) => p.id === Number(b.dataset.adjust)))),
    );
    list.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => removeProduct(rows.find((p) => p.id === Number(b.dataset.del)))),
    );
  }

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
    if (!data) return;
    const amount = Number(data.qty) || 0;
    const delta = data.mode === 'set' ? amount - Number(product.stock) : data.mode === 'remove' ? -amount : amount;
    if (!delta) return toast(t('prod.adjust_none'), 'warn');
    try {
      await api.adjustStock(product.id, delta, data.note);
      toast(t('prod.adjusted'), 'success');
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function removeProduct(product) {
    const ok = await confirmDialog({
      title: t('prod.delete_title', { name: product.name }),
      message: t('prod.delete_msg'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.deleteProduct(product.id);
      toast(res.archived ? t('prod.archived_toast') : t('prod.deleted_toast'), 'success');
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function showHistory(id) {
    const p = await api.product(id);
    let running = Number(p.stock);
    const rowsHtml = p.history
      .map((m) => {
        const after = running;
        running -= Number(m.qty);
        return `<tr>
          <td class="nowrap">${dateTimeText(m.created_at)}</td>
          <td><span class="badge ${m.qty > 0 ? 'success' : 'danger'}">${esc(moveText(m.kind))}</span></td>
          <td class="right ${m.qty > 0 ? 'money-pos' : 'money-neg'}">${m.qty > 0 ? '+' : ''}${qtyText(m.qty)}</td>
          <td class="right">${qtyText(after)}</td>
          <td class="right muted">${money(m.unit_cost)}</td>
          <td class="muted">${esc(m.note || '')}</td>
          <td class="muted">${esc(m.username || t('common.none'))}</td>
        </tr>`;
      })
      .join('');

    const subtitle = p.barcode
      ? t('prod.detail_sub_barcode', {
          b: p.barcode,
          q: qtyText(p.stock),
          u: p.unit,
          c: money(p.cost),
          p: money(p.price),
        })
      : t('prod.detail_sub', { q: qtyText(p.stock), u: p.unit, c: money(p.cost), p: money(p.price) });

    modal({
      title: p.name,
      subtitle,
      wide: true,
      body: `${
        p.description
          ? `<p class="muted" style="padding:2px 2px 14px;font-size:13px">${esc(p.description)}</p>`
          : ''
      }${
        p.history.length
          ? `<div class="table-wrap" style="max-height:56vh;overflow:auto">
             <table class="data">
               <thead><tr><th>${esc(t('prod.hist_when'))}</th><th>${esc(t('prod.hist_type'))}</th>
                 <th class="right">${esc(t('prod.hist_change'))}</th><th class="right">${esc(t('prod.hist_balance'))}</th>
                 <th class="right">${esc(t('prod.hist_unit_cost'))}</th><th>${esc(t('prod.hist_ref'))}</th>
                 <th>${esc(t('common.user'))}</th></tr></thead>
               <tbody>${rowsHtml}</tbody>
             </table></div>`
          : emptyState(t('prod.hist_none'), t('prod.hist_none_sub'), 'history')
      }`,
      footer: `<button class="btn" data-close>${esc(t('common.close'))}</button>`,
    });
  }

  await load();
}

/** The product form on its own page, so the sidebar and context stay visible. */
async function renderForm(root, ctx, id) {
  const [product, categories, units] = await Promise.all([
    id ? api.product(id) : null,
    suggestions('category'),
    suggestions('unit'),
  ]);
  const isNew = !product;
  const back = () => ctx.navigate('products');

  formPage(root, {
    title: isNew ? t('prod.new') : t('prod.edit'),
    subtitle: isNew ? t('prod.new_sub') : product.name,
    submitLabel: isNew ? t('prod.create') : t('common.save_changes'),
    fields: [
      { name: 'name', label: t('prod.name'), required: true, span: 2, value: product?.name, autofocus: true },
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
      {
        name: 'category',
        label: t('common.category'),
        value: product?.category || '',
        list: 'cat-list',
        datalist: categories,
        placeholder: t('prod.category_placeholder'),
      },
      { name: 'cost', label: t('prod.cost_label'), type: 'number', step: '0.01', min: 0, value: product?.cost ?? 0 },
      { name: 'price', label: t('prod.price_label'), type: 'number', step: '0.01', min: 0, value: product?.price ?? 0 },
      {
        name: 'unit',
        label: t('common.unit'),
        value: product?.unit || 'pcs',
        placeholder: t('prod.unit_placeholder'),
        list: 'unit-list',
        datalist: units,
      },
      { name: 'min_stock', label: t('prod.min_stock'), type: 'number', step: 'any', min: 0, value: product?.min_stock ?? 0 },
      ...(isNew
        ? [{ name: 'opening_stock', label: t('prod.opening'), type: 'number', step: 'any', min: 0, value: 0, span: 2, help: t('prod.opening_help') }]
        : [{ name: 'active', label: t('prod.active'), type: 'checkbox', value: !!product.active, span: 2 }]),
    ],
    onCancel: back,
    onSubmit: async (data) => {
      try {
        await api.saveProduct({ ...data, id: product?.id });
        toast(isNew ? t('prod.created') : t('prod.updated'), 'success');
        forgetSuggestions('category');
        forgetSuggestions('unit');
        back();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}
