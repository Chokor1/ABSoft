import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, moveText, t } from '../i18n.js';
import { wireNamePickers } from '../name-picker.js';
import { money2, money2Html, onRateChange, second } from '../currency.js';
import { attachNamePicker } from '../name-picker.js';
import { renderImport } from './product-import.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
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
  modal,
  money,
  filterSelect,
  keepList,
  listScroll,
  pager,
  recallList,
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
  toTop,
  wireBarcodeTables,
  wireTagInputs,
} from '../ui.js';

/** #/products, #/products/restock, #/products/new, #/products/<id>[/<tab>] */
export async function render(root, ctx) {
  const [first, second] = ctx.params;
  if (first === 'new') return renderForm(root, ctx);
  if (first === 'import') return renderImport(root, ctx);
  if (first && /^\d+$/.test(first)) return renderDetail(root, ctx, Number(first), second === 'edit' ? 'details' : second);
  // The menu's restock badge lands here: everything at or below its minimum.
  return renderList(root, ctx, { stock: first === 'restock' ? 'restock' : '' });
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
    { name: 'category', label: t('common.category'), value: product?.category || '', names: 'category', placeholder: t('prod.category_placeholder') },
    {
      name: 'barcodes',
      label: t('prod.barcodes'),
      type: 'barcodes',
      span: 2,
      value: { main: product?.barcode || '', list: product?.barcodes || [] },
      placeholder: t('prod.barcode_placeholder'),
      help: t('prod.barcodes_help'),
    },
    { name: 'cost', label: t('prod.cost_label'), type: 'number', step: '0.01', min: 0, value: product?.cost ?? 0 },
    { name: 'price', label: t('prod.price_label'), type: 'number', step: '0.01', min: 0, value: product?.price ?? 0 },
    // An add-on: added to other items' lines at the till (toppings, extras), never a card of its own.
    ...(product?.has_variants || !addonsOn() ? [] : [{ name: 'is_addon', label: t('addon.is_addon'), type: 'checkbox', span: 2, value: Number(product?.is_addon) === 1, help: t('addon.is_addon_help') }]),
    // Only a shop that switched them on is asked about templates and recipes.
    ...kindFields(product),
    { name: 'unit', label: t('common.unit'), value: product?.unit || 'pcs', placeholder: t('prod.unit_placeholder'), names: 'unit' },
    { name: 'min_stock', label: t('prod.min_stock'), type: 'number', step: 'any', min: 0, value: product?.min_stock ?? 0 },
    ...(isNew
      ? [{ name: 'opening_stock', label: t('prod.opening'), type: 'number', step: 'any', min: 0, value: 0, span: 2, help: t('prod.opening_help') }]
      : [{ name: 'active', label: t('prod.active'), type: 'checkbox', value: !!product.active, span: 2 }]),
  ];
}

const attributesOn = () => store.settings.attributes === '1';
const addonsOn = () => store.settings.addons === '1';
const recipesOn = () => store.settings.recipes === '1';
const isTemplate = (p) => Number(p?.has_variants) === 1;
const isMadeToOrder = (p) => recipesOn() && Number(p?.stocked ?? 1) === 0;

/**
 * Template, made to order, raw material: each asked only while its switch is on.
 * A variant is never a template; a template is never a raw material.
 */
function kindFields(product) {
  const out = [];
  if (attributesOn() && !product?.variant_of) {
    out.push({ name: 'has_variants', label: t('variant.is_template'), type: 'checkbox', span: 2, value: isTemplate(product), help: t('variant.is_template_help') });
  }
  if (recipesOn()) {
    out.push({ name: 'made_to_order', label: t('recipe.made_to_order'), type: 'checkbox', span: 2, value: Number(product?.stocked ?? 1) === 0, help: t('recipe.made_to_order_help') });
    if (!isTemplate(product)) {
      out.push({ name: 'raw', label: t('recipe.raw'), type: 'checkbox', span: 2, value: Number(product?.raw) === 1, help: t('recipe.raw_help') });
    }
  }
  return out;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The main barcode and the others, as the server takes them. */
const withBarcodes = (data) => {
  const codes = data.barcodes && typeof data.barcodes === 'object' && !Array.isArray(data.barcodes) ? data.barcodes : null;
  return codes ? { ...data, barcode: codes.main, barcodes: codes.list } : data;
};

/**
 * The same thing entered twice: choose what this product should become part of,
 * and everything it holds moves there. Resolves with the product merged into.
 */
async function mergeProduct(product) {
  let target = null;
  const picked = await formModal({
    title: t('prod.merge_title', { name: product.name }),
    subtitle: t('prod.merge_sub'),
    submitLabel: t('prod.merge_apply'),
    fields: [
      {
        name: 'into',
        label: t('prod.merge_into'),
        span: 2,
        placeholder: t('buy.find_product'),
        autofocus: true,
        combo: true,
      },
      { type: 'static', span: 2, html: `<div class="help">${esc(t('prod.merge_warning'))}</div>` },
    ],
    setup: (root) => {
      const input = root.querySelector('input[name=into]');
      return attachPicker(input, {
        // Anything but this product itself, which cannot absorb itself.
        search: async (q) => (await api.products({ search: q, limit: 25, all: '1' })).filter((p) => p.id !== product.id),
        render: productOption,
        emptyText: t('buy.no_product_match'),
        onPick: (p) => {
          target = p;
          input.value = p.name;
        },
      });
    },
  });
  if (!picked || !target) return null;

  const ok = await confirmDialog({
    title: t('prod.merge_confirm_title', { from: product.name, into: target.name }),
    message: t('prod.merge_confirm_msg', { from: product.name, into: target.name }),
    confirmLabel: t('prod.merge_apply'),
    danger: true,
  });
  if (!ok) return null;
  try {
    const saved = await api.mergeProduct(product.id, target.id);
    toast(t('prod.merged', { from: product.name, into: saved.name }), 'success');
    return saved;
  } catch (err) {
    toast(errorText(err), 'error');
    return null;
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

async function renderList(root, ctx, { stock = '' } = {}) {
  // Where this list was last left, so opening a product and coming back lands
  // on the same page with the same filters.
  const state = {
    ...recallList('products', { search: '', showInactive: false, category: '', filters: [], page: 1, per: 50 }),
    rows: [],
    result: null,
    // A badge's link (…/restock) asks for its own filter, whatever was kept.
    ...(stock ? { stock, page: 1 } : {}),
  };
  if (state.stock === undefined) state.stock = '';
  if (!Array.isArray(state.filters)) state.filters = [];
  const keep = () => keepList('products', state, ['search', 'showInactive', 'stock', 'category', 'filters', 'page', 'per']);
  const scroll = listScroll('products', root);
  let dropPicker = () => {};

  ctx.actions.innerHTML = `
    <button class="btn" id="labels">${icon('barcode')} ${esc(t('nav.labels'))}</button>
    <button class="btn" id="import">${icon('upload')} ${esc(t('imp.button'))}</button>
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('prod.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('products/new'));
  ctx.actions.querySelector('#import').addEventListener('click', () => ctx.navigate('products/import'));
  ctx.actions.querySelector('#labels').addEventListener('click', () => ctx.navigate('labels'));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      'absoft-products.csv',
      // What is on screen: the filters you set, this page of them.
      state.rows.map((p) => ({
        name: p.name,
        description: p.description || '',
        barcode: p.barcode || '',
        other_barcodes: (p.barcodes || []).join(' | '),
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
    <div class="toolbar sticky-bar">
      <div class="input-icon">${icon('search')}
        <input class="input" data-search id="search" value="${esc(state.search)}" placeholder="${esc(t('prod.search'))}"/>
      </div>
      <div class="filter-select"><span>${esc(t('filter.category'))}</span>
        <div class="combo"><input class="input" id="filter-category" value="${esc(state.category)}"
          placeholder="${esc(t('filter.all'))}" autocomplete="off"/></div>
      </div>
      <div id="stock-filter"></div>
      <label class="check"><input type="checkbox" id="inactive" ${state.showInactive ? 'checked' : ''}/> ${esc(t('prod.include_archived'))}</label>
      <button type="button" class="btn" id="filter-btn">${icon('sliders')} ${esc(t('flt.button'))} <span class="badge accent" id="filter-count" hidden></span></button>
      <div class="spacer"></div>
      <div id="summary" class="muted" style="font-size:12.5px"></div>
    </div>
    <div class="flt-chips" id="filter-chips" hidden></div>
    <div id="list"></div>`;

  const list = root.querySelector('#list');
  /** The filters in use, as chips under the bar: each says what it does and can be taken off. */
  const paintFilters = () => {
    const n = state.filters.length;
    const count = root.querySelector('#filter-count');
    count.hidden = !n;
    count.textContent = String(n);
    const chips = root.querySelector('#filter-chips');
    chips.hidden = !n;
    chips.innerHTML = n
      ? state.filters
          .map(
            (f, i) => `<span class="flt-chip">${esc(filterText(f))}
              <button type="button" class="chip-x" data-unfilter="${i}" aria-label="${esc(t('common.delete'))}">×</button></span>`,
          )
          .join('') + `<button type="button" class="btn btn-ghost btn-sm" data-unfilter="all">${esc(t('flt.clear'))}</button>`
      : '';
  };
  root.querySelector('#filter-btn').addEventListener('click', async () => {
    const next = await buildFilters(state.filters);
    if (!next) return;
    state.filters = next;
    paintFilters();
    refilter();
  });
  root.querySelector('#filter-chips').addEventListener('click', (e) => {
    const x = e.target.closest('[data-unfilter]');
    if (!x) return;
    if (x.dataset.unfilter === 'all') state.filters = [];
    else state.filters.splice(Number(x.dataset.unfilter), 1);
    paintFilters();
    refilter();
  });
  paintFilters();
  // Any change of filter starts again at the first page.
  const refilter = () => {
    state.page = 1;
    scroll.forget();
    load();
  };
  root.querySelector('#search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      refilter();
    }, 220),
  );
  root.querySelector('#inactive').addEventListener('change', (e) => {
    state.showInactive = e.target.checked;
    refilter();
  });
  root.querySelector('#stock-filter').append(
    filterSelect({
      label: t('filter.stock'),
      value: state.stock,
      options: [
        { value: '', label: t('filter.all') },
        { value: 'in', label: t('filter.in_stock') },
        { value: 'low', label: t('filter.low_stock') },
        { value: 'out', label: t('filter.out_of_stock') },
        { value: 'restock', label: t('filter.restock') },
      ],
      onChange: (v) => {
        state.stock = v;
        // Leaving the badge's list: the address goes back to the plain list.
        if (location.hash === '#/products/restock') history.replaceState(null, '', '#/products');
        refilter();
      },
    }),
  );
  // Typing a category narrows to it; clearing the box brings everything back.
  const categoryInput = root.querySelector('#filter-category');
  const categoryPicker = attachNamePicker(categoryInput, {
    kind: 'category',
    onPick: (c) => {
      state.category = c.name;
      refilter();
    },
  });
  dropPicker = () => categoryPicker.destroy();
  categoryInput.addEventListener('change', () => {
    if (!categoryInput.value.trim() && state.category) {
      state.category = '';
      refilter();
    }
  });

  async function load() {
    keep(); // the page and the filters, for when you come back
    list.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const result = await api.products({
      search: state.search,
      all: state.showInactive ? '1' : '',
      category: state.category,
      stock: state.stock,
      ...(state.filters.length ? { filters: JSON.stringify(state.filters) } : {}),
      page: state.page,
      per: state.per,
    }).catch((err) => {
      toast(errorText(err), 'error');
      return { rows: [], total: 0, page: 1, pages: 1, per: state.per };
    });
    state.result = result;
    const rows = result.rows;
    state.rows = rows;

    const stockValue = rows.reduce((s, p) => s + p.stock_value, 0);
    root.querySelector('#summary').textContent = t('prod.summary', {
      n: result.total,
      v: money(result.sums?.stock_value ?? stockValue),
    });

    list.innerHTML = `
      <div class="card"><div class="card-body flush">
        ${
          rows.length
            ? `<div class="table-wrap table-scroll"><table class="data compact product-list">
                <thead><tr>
                  <th>${esc(t('nav.products'))}</th><th>${esc(t('common.barcode'))}</th>
                  <th>${esc(t('common.category'))}</th>
                  <th class="right">${esc(t('common.cost'))}</th><th class="right">${esc(t('common.price'))}</th>
                  ${second() ? `<th class="right">${esc(t('prod.price_in', { c: second().symbol }))}</th>` : ''}
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
                      <td class="mono muted nowrap">${esc(p.barcode || t('common.none'))}${
                        p.barcodes?.length
                          ? ` <span class="badge" title="${esc(p.barcodes.join(' · '))}">+${p.barcodes.length}</span>`
                          : ''
                      }</td>
                      <td>${
                        p.category
                          ? `<span class="badge">${esc(p.category)}</span>`
                          : `<span class="muted">${t('common.none')}</span>`
                      }</td>
                      <td class="right muted">${money(p.cost)}</td>
                      <td class="right"><b>${money(p.price)}</b></td>
                      ${second() ? `<td class="right">${money2Html(p.price)}</td>` : ''}
                      <td class="right ${p.margin >= 0 ? 'money-pos' : 'money-neg'}">${pct(p.margin)}</td>
                      <td class="right">${
                        // No shelf of its own: a template's stock is its variants', and what is made to order has none.
                        isTemplate(p)
                          ? `<span class="badge">${esc(t(Number(p.variants) === 1 ? 'variant.count_one' : 'variant.count', { n: Number(p.variants) || 0 }))}</span>`
                          : isMadeToOrder(p)
                            ? `<span class="badge">${esc(t('recipe.made_to_order_badge'))}</span>`
                            : `<span class="badge ${p.stock <= 0 ? 'danger' : p.stock <= p.min_stock ? 'warn' : 'success'}">
                          ${qtyText(p.stock)} ${esc(p.unit)}
                        </span>`
                      }</td>
                      <td class="right muted">${money(p.stock_value)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr>
                  <td colspan="${second() ? 8 : 7}">${esc(t('page.page_total'))} · ${esc(t('prod.totals', { n: rows.length }))}</td>
                  <td class="right">${money(stockValue)}</td>
                </tr></tfoot>
              </table></div>`
            : emptyState(
                state.search || state.filters.length ? t('prod.none_match') : t('prod.none'),
                state.search || state.filters.length ? t('prod.none_match_sub') : t('prod.none_sub'),
                'box',
              )
        }
      </div></div>`;

    // Everything else (edit, adjust, picture, delete) lives on the product's own page.
    list.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`products/${tr.dataset.open}`)),
    );

    if (rows.length) {
      list.querySelector('.card').append(
        pager(result, ({ page, per }) => {
          state.page = page;
          state.per = per;
          load();
        }),
      );
    }
    // Back where you were, now the rows are on screen.
    scroll.restore();
  }

  await load();

  // main.js calls this when navigating away.
  return () => dropPicker();
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
        const saved = await api.saveProduct(withBarcodes(data));
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

/* -------------------------------------------------------- filter builder -- */

/**
 * The fields a product can be filtered on, with what kind of value each takes.
 * Fields that belong to a switched-off feature are not offered.
 */
const filterFields = () => [
  { key: 'name', label: t('prod.name'), type: 'text' },
  { key: 'description', label: t('common.description'), type: 'text' },
  { key: 'barcode', label: t('common.barcode'), type: 'text' },
  { key: 'category', label: t('common.category'), type: 'text' },
  { key: 'unit', label: t('common.unit'), type: 'text' },
  { key: 'price', label: t('common.price'), type: 'number' },
  { key: 'cost', label: t('common.cost'), type: 'number' },
  { key: 'margin', label: `${t('common.margin')} %`, type: 'number' },
  { key: 'stock', label: t('common.stock'), type: 'number' },
  { key: 'stock_value', label: t('common.value'), type: 'number' },
  { key: 'min_stock', label: t('prod.min_stock'), type: 'number' },
  { key: 'active', label: t('flt.active'), type: 'bool' },
  ...(addonsOn() ? [{ key: 'is_addon', label: t('addon.badge'), type: 'bool' }] : []),
  ...(recipesOn()
    ? [
        { key: 'made_to_order', label: t('recipe.made_to_order_badge'), type: 'bool' },
        { key: 'raw', label: t('recipe.raw_badge'), type: 'bool' },
      ]
    : []),
  ...(attributesOn()
    ? [
        { key: 'template', label: t('variant.template'), type: 'bool' },
        { key: 'variant', label: t('flt.variant'), type: 'bool' },
      ]
    : []),
];
const OPS = {
  text: ['like', 'eq', 'neq', 'starts', 'not_like', 'set', 'not_set'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  bool: ['is'],
};
const noValue = (op) => op === 'set' || op === 'not_set';

/** One filter, said briefly: "Price > 5", "Category contains juice", "Add-on: yes". */
function filterText(f) {
  const field = filterFields().find((x) => x.key === f.field);
  if (!field) return '';
  if (field.type === 'bool') return `${field.label}: ${t(f.value === '0' ? 'flt.no' : 'flt.yes')}`;
  return `${field.label} ${t(`flt.op.${f.op}`)}${noValue(f.op) ? '' : ` ${f.value}`}`;
}

/** The filter builder: rows of field, operator and value, all of which must hold. Resolves the list, or null. */
function buildFilters(current) {
  const fields = filterFields();
  const rows = current.length ? current.map((f) => ({ ...f })) : [{ field: 'name', op: 'like', value: '' }];
  const rowHtml = (f, i) => {
    const field = fields.find((x) => x.key === f.field) || fields[0];
    const ops = OPS[field.type];
    const op = ops.includes(f.op) ? f.op : ops[0];
    const value =
      field.type === 'bool'
        ? `<select class="select" data-value="${i}"><option value="1" ${f.value !== '0' ? 'selected' : ''}>${esc(t('flt.yes'))}</option>
             <option value="0" ${f.value === '0' ? 'selected' : ''}>${esc(t('flt.no'))}</option></select>`
        : `<input class="input" data-value="${i}" ${field.type === 'number' ? 'type="number" step="any"' : ''} value="${esc(f.value ?? '')}"
             ${noValue(op) ? 'disabled' : ''} placeholder="${esc(t('flt.value'))}" autocomplete="off"/>`;
    return `<div class="flt-row" data-row="${i}">
      <select class="select" data-field="${i}">${fields
        .map((x) => `<option value="${x.key}" ${x.key === field.key ? 'selected' : ''}>${esc(x.label)}</option>`)
        .join('')}</select>
      <select class="select" data-op="${i}" ${ops.length === 1 ? 'disabled' : ''}>${ops
        .map((o) => `<option value="${o}" ${o === op ? 'selected' : ''}>${esc(t(`flt.op.${o}`))}</option>`)
        .join('')}</select>
      ${value}
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-drop="${i}" aria-label="${esc(t('common.delete'))}">${icon('trash')}</button>
    </div>`;
  };
  return modal({
    title: t('flt.title'),
    subtitle: t('flt.sub'),
    wide: true,
    body: `<div class="flt-rows" id="flt-rows"></div>
      <button type="button" class="btn btn-sm" id="flt-add">${icon('plus')} ${esc(t('flt.add'))}</button>`,
    footer: `<button class="btn btn-ghost" id="flt-clear">${esc(t('flt.clear'))}</button>
      <div class="spacer"></div>
      <button class="btn" data-close>${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="flt-apply">${icon('check')} ${esc(t('flt.apply'))}</button>`,
    setup: (dialog, close) => {
      const box = dialog.querySelector('#flt-rows');
      // What is typed is read back into the rows before they are drawn again.
      const read = () =>
        rows.forEach((f, i) => {
          const field = fields.find((x) => x.key === dialog.querySelector(`[data-field="${i}"]`).value);
          f.field = field.key;
          const ops = OPS[field.type];
          const op = dialog.querySelector(`[data-op="${i}"]`).value;
          f.op = ops.includes(op) ? op : ops[0];
          f.value = dialog.querySelector(`[data-value="${i}"]`).value.trim();
        });
      const paint = () => {
        box.innerHTML = rows.length ? rows.map(rowHtml).join('') : `<p class="muted">${esc(t('flt.none'))}</p>`;
      };
      box.addEventListener('change', (e) => {
        const i = e.target.dataset.field;
        read();
        // A different field: its first operator, and a value of its own kind.
        if (i !== undefined) {
          const field = fields.find((x) => x.key === rows[i].field);
          rows[i].op = OPS[field.type][0];
          rows[i].value = field.type === 'bool' ? '1' : '';
        }
        paint();
      });
      box.addEventListener('click', (e) => {
        const drop = e.target.closest('[data-drop]');
        if (!drop) return;
        read();
        rows.splice(Number(drop.dataset.drop), 1);
        paint();
      });
      dialog.querySelector('#flt-add').addEventListener('click', () => {
        read();
        rows.push({ field: 'price', op: 'gt', value: '' });
        paint();
        dialog.querySelector(`[data-value="${rows.length - 1}"]`)?.focus();
      });
      dialog.querySelector('#flt-clear').addEventListener('click', () => close([]));
      const apply = () => {
        read();
        // A row with nothing to compare with is left out, rather than matching nothing.
        close(rows.filter((f) => noValue(f.op) || f.value !== '' || fields.find((x) => x.key === f.field)?.type === 'bool'));
      };
      dialog.querySelector('#flt-apply').addEventListener('click', apply);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) {
          e.preventDefault();
          apply();
        }
      });
      paint();
      dialog.querySelector('[data-value="0"]')?.focus();
    },
  });
}

/* ----------------------------------------------------------- detail page -- */

const TABS = ['details', 'pricing', 'overview', 'movements', 'sales', 'purchases'];

/**
 * The tabs a product shows. A template: its details and its variants, since
 * the variants are what is priced, stocked and sold. Made to order: its recipe
 * beside its prices.
 */
function tabsFor(product) {
  if (isTemplate(product)) return ['details', 'variants'];
  // An add-on says, beside its details, what it is offered with.
  const addon = addonsOn() && Number(product.is_addon) === 1 ? ['addon'] : [];
  if (isMadeToOrder(product)) return ['details', ...addon, 'pricing', 'recipe', 'overview', 'sales'];
  return ['details', ...addon, ...TABS.slice(1)];
}

async function renderDetail(root, ctx, id, initialTab) {
  const admin = store.user?.role === 'admin';
  let product;
  try {
    product = await api.product(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.navigate('products');
  }
  const state = { tab: tabsFor(product).includes(initialTab) ? initialTab : 'details', from: shiftDays(todayISO(), -29), to: todayISO() };
  let dropPickers = () => {};

  ctx.actions.innerHTML = `
    <button class="btn" id="labels">${icon('barcode')} ${esc(t('label.print_this'))}</button>
    <button class="btn" id="merge">${icon('package')} ${esc(t('prod.merge'))}</button>
    <button class="btn btn-ghost" id="remove" title="${esc(t('common.delete'))}" aria-label="${esc(t('common.delete'))}">${icon('trash')}</button>`;
  ctx.actions.querySelector('#labels').addEventListener('click', () => ctx.navigate(`labels/${id}`));
  ctx.actions.querySelector('#merge').addEventListener('click', async () => {
    const into = await mergeProduct(product);
    if (into) ctx.navigate(`products/${into.id}`);
  });
  ctx.actions.querySelector('#remove').addEventListener('click', async () => {
    const res = await removeProduct(product);
    if (res?.deleted) ctx.navigate('products');
    else if (res) reload();
  });

  // The menu comes first: the product's name and its tabs sit together at the top.
  root.innerHTML = `
    <div class="card product-hero sticky-bar" id="hero"></div>
    <div id="tab-body"></div>`;

  const hero = root.querySelector('#hero');
  const body = root.querySelector('#tab-body');

  async function reload() {
    product = await api.product(id);
    paintHero();
    showTab();
  }

  function go(tab) {
    state.tab = tab;
    toTop();
    // Keep the tab in the address, so reload and Back land on the same view.
    history.replaceState(null, '', `#/products/${id}/${state.tab}`);
    showTab();
  }

  function paintHero() {
    const low = product.stock <= product.min_stock;
    hero.innerHTML = `
      <div class="ph-row">
        <button type="button" class="btn btn-ghost btn-icon" id="back" aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        ${productThumb(product, 'xs')}
        <div class="ph-text">
          <h2>${esc(product.name)}</h2>
          ${heroBadges()}
        </div>
        <div class="spacer"></div>
        <div class="seg" id="tabs">${tabsFor(product).map(
          (k) => `<button data-tab="${k}" class="${k === state.tab ? 'active' : ''}">${esc(t(`prod.tab.${k}`))}</button>`,
        ).join('')}</div>
      </div>`;
    hero.querySelector('#back').addEventListener('click', () => ctx.navigate('products'));
    hero.querySelector('[data-template]')?.addEventListener('click', () => ctx.navigate(`products/${product.variant_of}/variants`));
    hero.querySelector('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (btn) go(btn.dataset.tab);
    });
  }

  /** Archived, a template, a variant of one, made to order, a raw material. */
  function heroBadges() {
    const badges = [];
    if (!product.active) badges.push(`<span class="badge warn">${esc(t('prod.archived'))}</span>`);
    if (isTemplate(product)) badges.push(`<span class="badge">${esc(t('variant.template'))}</span>`);
    if (product.variant_of) {
      badges.push(`<button type="button" class="badge badge-link" data-template>${esc(t('variant.of', { name: product.template_name || '' }))}</button>`);
    }
    if (addonsOn() && Number(product.is_addon) === 1) badges.push(`<span class="badge">${esc(t('addon.badge'))}</span>`);
    if (!isTemplate(product) && isMadeToOrder(product)) badges.push(`<span class="badge">${esc(t('recipe.made_to_order_badge'))}</span>`);
    if (recipesOn() && Number(product.raw) === 1) badges.push(`<span class="badge">${esc(t('recipe.raw_badge'))}</span>`);
    return badges.length ? `<div class="ph-badges">${badges.join('')}</div>` : '';
  }

  function showTab() {
    // A change on Details can add or take away tabs: land on one that is there.
    if (!tabsFor(product).includes(state.tab)) state.tab = 'details';
    dropPickers();
    dropPickers = () => {};
    hero.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('common.loading'))}</p></div></div></div>`;
    ({
      details: tabDetails,
      pricing: tabPricing,
      overview: tabOverview,
      movements: tabMovements,
      sales: tabSales,
      purchases: tabPurchases,
      variants: tabVariants,
      recipe: tabRecipe,
      addon: tabAddon,
    })[
      state.tab
    ]();
  }

  /* Details: the picture, with the product's properties beside and under it. */
  function tabDetails() {
    // Laid out to fill the grid: the editable fields, what the product holds
    // (read only), then the active switch.
    const fields = productFields(product).map((f) => (f.name === 'active' ? { ...f, span: undefined } : f));
    const editable = fields.filter((f) => f.name !== 'active');
    const active = fields.filter((f) => f.name === 'active');
    const readOnly = (label, value) =>
      `<div class="field"><label>${esc(label)}</label><div class="input readonly">${value}</div></div>`;
    body.innerHTML = `
      <form class="card" id="page-form" novalidate>
        <div class="card-body">
          <div class="pd-grid">
            <div class="pd-image">
              ${productThumb(product, 'lg')}
              <div class="pd-image-actions">
                <label class="btn btn-sm" title="${esc(t('prod.image_upload'))}">
                  ${icon('camera')} <span>${esc(product.image_at ? t('prod.image_change') : t('prod.image_add'))}</span>
                  <input type="file" id="image-file" accept="image/png,image/jpeg,image/webp" hidden/>
                </label>
                ${
                  product.image_at
                    ? `<button type="button" class="btn btn-sm btn-ghost" id="image-remove" title="${esc(t('prod.image_remove'))}" aria-label="${esc(t('prod.image_remove'))}">${icon('trash')}</button>`
                    : ''
                }
              </div>
            </div>
            ${renderFields(editable)}
            ${second() ? readOnly(t('prod.price_in', { c: second().symbol }), `<span id="price2">${esc(money2(product.price))}</span>`) : ''}
            ${readOnly(t('common.stock'), `${qtyText(product.stock)} ${esc(product.unit)}`)}
            ${admin ? readOnly(t('common.value'), money(product.stock_value)) : ''}
            ${admin ? readOnly(t('common.margin'), pct(product.margin)) : ''}
            <div class="pd-active">${renderFields(active)}</div>
          </div>
        </div>
        <div class="card-head form-actions">
          <div class="muted" style="font-size:12.5px">${esc(t('prod.edit_sub'))}</div>
          <div class="spacer"></div>
          <button type="submit" class="btn btn-primary">${icon('check')} ${esc(t('common.save_changes'))}</button>
        </div>
      </form>`;
    const form = body.querySelector('#page-form');
    dropPickers = wireNamePickers(form, fields);
    wireTagInputs(form);
    wireBarcodeTables(form);
    const paintPrice2 = () => {
      const el = body.querySelector('#price2');
      if (el) el.textContent = money2(form.price.value);
    };
    form.price.addEventListener('input', paintPrice2);
    const stopRate = onRateChange(paintPrice2);
    const dropNames = dropPickers;
    dropPickers = () => {
      dropNames();
      stopRate();
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) return form.reportValidity();
      try {
        await api.saveProduct({ ...withBarcodes(readFields(form, fields)), id });
        forgetSuggestions('category');
        forgetSuggestions('unit');
        toast(t('prod.updated'), 'success');
        product = await api.product(id);
        paintHero();
        showTab();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });

    body.querySelector('#image-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = await shrinkImage(file);
        // The image routes answer with the bare product; keep the history already loaded.
        product = { ...product, ...(await api.uploadProductImage(id, data)) };
        toast(t('prod.image_saved'), 'success');
        paintHero();
        tabDetails();
      } catch (err) {
        toast(err.code || err.status ? errorText(err) : t('prod.image_unreadable'), 'error');
      }
    });
    body.querySelector('#image-remove')?.addEventListener('click', async () => {
      product = { ...product, ...(await api.deleteProductImage(id)) };
      toast(t('prod.image_removed'), 'success');
      paintHero();
      tabDetails();
    });
  }

  /**
   * Pricing: what this product sells and is bought for on every list the shop
   * keeps, and every change those prices have been through.
   */
  async function tabPricing() {
    const data = await api.productPrices(id).catch(() => null);
    if (state.tab !== 'pricing') return;
    if (!data) {
      body.innerHTML = `<div class="card"><div class="card-body">${emptyState(t('common.page_error'), '', 'tag')}</div></div>`;
      return;
    }
    const buys = (l) => l.use_for === 'buy';
    const row = (l) => `
      <tr data-row="${l.id}">
        <td>
          <div class="cell-title"><span class="pl-name">${esc(l.name)}</span>${
            l.is_default ? ` <span class="badge">${esc(t('price.main'))}</span>` : ''
          }${l.active ? '' : ` <span class="badge">${esc(t('price.not_in_use'))}</span>`}</div>
          <div class="cell-sub">${esc(t(`price.use.${l.use_for}`))}</div>
        </td>
        <td class="right">
          <input class="input price-input" type="number" step="0.01" min="0" data-price-list="${l.id}"
                 value="${l.price === null ? '' : l.price}" placeholder="${esc(
                   l.is_default ? '' : buys(l) ? money(data.cost) : money(product.price),
                 )}" aria-label="${esc(l.name)}" ${admin ? '' : 'disabled'}/>
        </td>
        <td class="right prices-foot">${
          l.falls_back
            ? `<span class="muted">${esc(buys(l) ? t('price.falls_back_cost') : t('price.falls_back'))}</span>`
            : second()
              ? money2Html(l.price)
              : ''
        }</td>
      </tr>`;

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t('price.on_lists'))}</h3><div class="sub">${esc(t('price.on_lists_sub'))}</div></div>
        </div>
        <div class="card-body flush">
          <div class="table-wrap"><table class="data" id="pricing-table">
            <thead><tr><th>${esc(t('price.list'))}</th><th class="right">${esc(t('common.price'))}</th><th></th></tr></thead>
            <tbody>${data.rows.map(row).join('')}</tbody>
          </table></div>
        </div>
        ${
          admin
            ? `<div class="card-head set-foot"><div class="help">${esc(t('price.tab_help'))}</div><div class="spacer"></div>
                 <button class="btn btn-primary" id="save-prices">${icon('check')} ${esc(t('common.save'))}</button></div>`
            : ''
        }
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('price.history'))}</h3>
          <div class="sub">${esc(t('price.history_sub'))}</div></div></div>
        <div class="card-body flush">${
          data.history.length
            ? `<div class="table-wrap table-scroll"><table class="data" id="price-history">
                <thead><tr><th>${esc(t('common.date'))}</th><th>${esc(t('price.list'))}</th>
                  <th class="right">${esc(t('price.from'))}</th><th class="right">${esc(t('price.to'))}</th>
                  <th class="right">${esc(t('price.change'))}</th><th>${esc(t('common.by'))}</th></tr></thead>
                <tbody>${data.history
                  .map((h) => {
                    const was = h.old_price;
                    const now = h.new_price;
                    const diff = was === null || now === null ? null : round2(now - was);
                    return `<tr>
                      <td>${esc(dateTimeText(h.changed_at))}</td>
                      <td>${esc(h.list_name || t('price.main'))}${
                        h.field === 'cost' ? ` · <span class="muted">${esc(t('common.cost'))}</span>` : ''
                      }</td>
                      <td class="right">${was === null ? `<span class="muted">${esc(t('price.unpriced'))}</span>` : money(was)}</td>
                      <td class="right"><b>${
                        now === null ? `<span class="muted">${esc(t('price.unpriced'))}</span>` : money(now)
                      }</b></td>
                      <td class="right ${diff === null ? 'muted' : signClass(diff)}">${
                        diff === null ? '—' : money(diff, { sign: true })
                      }</td>
                      <td>${esc(h.username || '')}</td>
                    </tr>`;
                  })
                  .join('')}</tbody>
              </table></div>`
            : `<div class="empty"><p>${esc(t('price.no_history'))}</p></div>`
        }</div>
      </div>`;

    body.querySelector('#save-prices')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      // The main list is the product's own price; the others are its list prices.
      const prices = {};
      let own = product.price;
      body.querySelectorAll('[data-price-list]').forEach((input) => {
        const list = data.rows.find((l) => String(l.id) === input.dataset.priceList);
        if (list?.is_default) own = Number(input.value) || 0;
        else prices[input.dataset.priceList] = input.value.trim();
      });
      try {
        product = await api.saveProduct({ id, price: own, prices });
        toast(t('price.saved_prices'), 'success');
        showTab();
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
      }
    });
  }

  /**
   * Variants: which values of the shop's attributes this template comes in, a
   * button that makes every combination not made yet, and each variant with its
   * price, typed in place.
   */
  async function tabVariants() {
    const [attrs, data] = await Promise.all([api.attributes().catch(() => []), api.productVariants(id).catch(() => null)]);
    if (state.tab !== 'variants') return;
    if (!data) {
      body.innerHTML = `<div class="card"><div class="card-body">${emptyState(t('common.page_error'), '', 'tag')}</div></div>`;
      return;
    }
    const chosen = new Set(data.value_ids);
    const canEdit = admin && attributesOn();
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('variant.values'))}</h3>
          <div class="sub">${esc(t('variant.values_sub'))}</div></div></div>
        <div class="card-body">${
          attrs.length
            ? `<div class="attr-pick">${attrs
                .map(
                  (a) => `<div class="attr-group"><div class="attr-name">${esc(a.name)}</div><div class="attr-values">${a.values
                    .map(
                      (v) => `<label class="attr-chip"><input type="checkbox" data-value="${v.id}" ${chosen.has(v.id) ? 'checked' : ''} ${
                        canEdit ? '' : 'disabled'
                      }/><span>${esc(v.name)}</span></label>`,
                    )
                    .join('')}</div></div>`,
                )
                .join('')}</div>`
            : emptyState(t('variant.no_attributes'), t('variant.no_attributes_sub'), 'tag')
        }</div>
        ${
          canEdit && attrs.length
            ? `<div class="card-head set-foot"><div class="help" id="variant-count"></div><div class="spacer"></div>
                 <button class="btn btn-primary" id="generate">${icon('plus')} ${esc(t('variant.generate'))}</button></div>`
            : ''
        }
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('variant.list'))}</h3>
          <div class="sub">${esc(t('variant.list_sub', { n: data.variants.length }))}</div></div></div>
        <div class="card-body flush">${
          data.variants.length
            ? `<div class="table-wrap"><table class="data" id="variants-table">
                <thead><tr><th>${esc(t('common.name'))}</th><th>${esc(t('variant.values_col'))}</th>
                  <th class="right">${esc(t('common.price'))}</th><th class="right">${esc(t('common.stock'))}</th><th></th></tr></thead>
                <tbody>${data.variants
                  .map(
                    (v) => `<tr data-variant-row="${v.id}">
                      <td><div class="cell-title">${esc(v.name)}${v.active ? '' : ` <span class="badge warn">${esc(t('prod.archived'))}</span>`}</div>
                        ${v.barcode ? `<div class="cell-sub">${esc(v.barcode)}</div>` : ''}</td>
                      <td>${esc(v.label)}</td>
                      <td class="right"><input class="input price-input" type="number" step="0.01" min="0" data-variant-price="${v.id}"
                        value="${v.price}" aria-label="${esc(v.name)}" ${admin ? '' : 'disabled'}/></td>
                      <td class="right">${isMadeToOrder(v) ? `<span class="muted">${esc(t('recipe.made_to_order_badge'))}</span>` : `${qtyText(v.stock)} ${esc(v.unit)}`}</td>
                      <td class="right"><button class="btn btn-sm" data-open="${v.id}">${esc(t('variant.open'))}</button></td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>`
            : `<div class="empty"><p>${esc(t('variant.none'))}</p></div>`
        }</div>
        ${
          admin && data.variants.length
            ? `<div class="card-head set-foot"><div class="help">${esc(t('variant.prices_help'))}</div><div class="spacer"></div>
                 <button class="btn btn-primary" id="save-variant-prices">${icon('check')} ${esc(t('common.save'))}</button></div>`
            : ''
        }
      </div>`;

    // How many variants the ticked values make, and how many of them are new.
    const picked = () => [...body.querySelectorAll('[data-value]:checked')].map((el) => Number(el.dataset.value));
    const paintCount = () => {
      const el = body.querySelector('#variant-count');
      if (!el) return;
      const ids = new Set(picked());
      const groups = attrs.map((a) => a.values.filter((v) => ids.has(v.id)).length).filter(Boolean);
      const n = groups.length ? groups.reduce((a, b) => a * b, 1) : 0;
      el.textContent = n ? t('variant.will_make', { n }) : t('variant.pick_values');
      body.querySelector('#generate').disabled = !n;
    };
    body.querySelectorAll('[data-value]').forEach((el) => el.addEventListener('change', paintCount));
    paintCount();

    body.querySelector('#generate')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const res = await api.generateVariants(id, picked());
        toast(res.created ? t('variant.generated', { n: res.created }) : t('variant.generated_none'), 'success');
        product = await api.product(id);
        showTab();
      } catch (err) {
        toast(errorText(err), 'error');
        paintCount();
      }
    });
    body.querySelector('#save-variant-prices')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const prices = {};
      body.querySelectorAll('[data-variant-price]').forEach((el) => (prices[el.dataset.variantPrice] = el.value.trim()));
      try {
        await api.saveVariantPrices(id, prices);
        toast(t('price.saved_prices'), 'success');
        showTab();
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
      }
    });
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => ctx.navigate(`products/${b.dataset.open}`)));
  }

  /**
   * Offered with: which items' lines this add-on can be added to at the till —
   * every item, the items of some categories, or some items (a template's
   * variants with it).
   */
  async function tabAddon() {
    const [data, cats] = await Promise.all([api.addonFor(id).catch(() => null), api.categoriesInUse().catch(() => [])]);
    if (state.tab !== 'addon') return;
    if (!data) {
      body.innerHTML = `<div class="card"><div class="card-body">${emptyState(t('common.page_error'), '', 'tag')}</div></div>`;
      return;
    }
    let scope = data.scope;
    const chosenCats = new Set(data.categories.map((c) => c.toLowerCase()));
    const items = [...data.products];
    // Every category in use, and any chosen one no item is filed under any more.
    const allCats = [...cats.map((c) => c.name), ...data.categories.filter((c) => !cats.some((x) => x.name.toLowerCase() === c.toLowerCase()))];
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('addon.offered_with'))}</h3>
          <div class="sub">${esc(t('addon.offered_sub'))}</div></div></div>
        <div class="card-body" style="display:grid;gap:14px">
          <div class="seg" id="addon-scope" role="radiogroup">${['all', 'categories', 'products']
            .map((k) => `<button type="button" data-scope="${k}" role="radio">${esc(t(`addon.scope.${k}`))}</button>`)
            .join('')}</div>
          <div id="scope-categories" class="attr-values">${
            allCats.length
              ? allCats
                  .map(
                    (c) => `<label class="attr-chip"><input type="checkbox" data-cat="${esc(c)}" ${chosenCats.has(c.toLowerCase()) ? 'checked' : ''} ${admin ? '' : 'disabled'}/><span>${esc(c)}</span></label>`,
                  )
                  .join('')
              : `<p class="muted">${esc(t('addon.no_categories'))}</p>`
          }</div>
          <div id="scope-products" style="display:grid;gap:10px">
            ${admin ? `<div class="combo"><input class="input" id="addon-find" placeholder="${esc(t('addon.find_item'))}" autocomplete="off"/></div>` : ''}
            <div class="attr-values" id="addon-items"></div>
          </div>
        </div>
        ${
          admin
            ? `<div class="card-head set-foot"><div class="help" id="scope-help"></div><div class="spacer"></div>
                 <button class="btn btn-primary" id="save-addon-for">${icon('check')} ${esc(t('common.save'))}</button></div>`
            : ''
        }
      </div>`;
    const paintItems = () => {
      body.querySelector('#addon-items').innerHTML = items.length
        ? items
            .map(
              (p) => `<span class="addon-chip">${esc(p.name)}${
                admin ? ` <button type="button" class="chip-x" data-drop="${p.id}" aria-label="${esc(t('common.delete'))}">×</button>` : ''
              }</span>`,
            )
            .join('')
        : `<span class="muted">${esc(t('addon.no_items'))}</span>`;
    };
    const paintScope = () => {
      body.querySelectorAll('[data-scope]').forEach((b) => {
        b.classList.toggle('active', b.dataset.scope === scope);
        b.setAttribute('aria-checked', String(b.dataset.scope === scope));
      });
      // Only what applies to the choice shows: the categories, or the items, or neither.
      body.querySelector('#scope-categories').style.display = scope === 'categories' ? '' : 'none';
      body.querySelector('#scope-products').style.display = scope === 'products' ? 'grid' : 'none';
      const help = body.querySelector('#scope-help');
      if (help) help.textContent = t(`addon.scope_help.${scope}`);
    };
    body.querySelector('#addon-scope').addEventListener('click', (e) => {
      const b = e.target.closest('[data-scope]');
      if (!b || !admin) return;
      scope = b.dataset.scope;
      paintScope();
    });
    body.querySelector('#addon-items').addEventListener('click', (e) => {
      const x = e.target.closest('[data-drop]');
      if (!x) return;
      items.splice(items.findIndex((p) => p.id === Number(x.dataset.drop)), 1);
      paintItems();
    });
    const find = body.querySelector('#addon-find');
    if (find) {
      const picker = attachPicker(find, {
        // Items sold as they are: no other add-on, no raw material.
        search: (q) => (q ? api.products({ search: q, limit: 25, templates: '1' }).then((rows) => rows.filter((p) => p.id !== id && !Number(p.is_addon) && !Number(p.raw))) : []),
        render: productOption,
        emptyText: t('buy.no_product_match'),
        openOnFocus: false,
        onPick: (p) => {
          find.value = '';
          picker.reset();
          if (!items.some((x) => x.id === p.id)) items.push({ id: p.id, name: p.name });
          paintItems();
        },
      });
      dropPickers = () => picker.destroy();
    }
    paintItems();
    paintScope();
    body.querySelector('#save-addon-for')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.saveAddonFor(id, {
          scope,
          categories: [...body.querySelectorAll('[data-cat]:checked')].map((el) => el.dataset.cat),
          product_ids: items.map((p) => p.id),
        });
        toast(t('addon.saved_for'), 'success');
      } catch (err) {
        toast(errorText(err), 'error');
      }
      btn.disabled = false;
    });
  }

  /**
   * Recipe: what one of this product usually takes, as an estimate. Each sale
   * writes this down; the ingredients' stock moves when they are reconciled.
   */
  async function tabRecipe() {
    const data = await api.recipe(id).catch(() => null);
    if (state.tab !== 'recipe') return;
    if (!data) {
      body.innerHTML = `<div class="card"><div class="card-body">${emptyState(t('common.page_error'), '', 'tag')}</div></div>`;
      return;
    }
    const lines = data.lines.map((l) => ({ ...l.ingredient, qty: l.qty }));
    const cost = () => round2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0));
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('recipe.title'))}</h3>
          <div class="sub">${esc(t('recipe.sub'))}</div></div></div>
        <div class="card-body flush"><div class="table-wrap"><table class="data" id="recipe-table">
          <thead><tr><th>${esc(t('recipe.ingredient'))}</th><th class="right" style="width:170px">${esc(t('recipe.qty'))}</th>
            ${admin ? `<th class="right">${esc(t('common.cost'))}</th>` : ''}<th style="width:44px"></th></tr></thead>
          <tbody id="recipe-lines"></tbody>
          ${admin ? `<tfoot><tr><td colspan="2">${esc(t('recipe.cost'))}</td><td class="right"><b id="recipe-cost"></b></td><td></td></tr></tfoot>` : ''}
        </table></div></div>
        ${
          admin
            ? `<div class="card-body"><div class="combo"><input class="input" id="recipe-find" placeholder="${esc(t('recipe.add_placeholder'))}" autocomplete="off"/></div></div>
               <div class="card-head set-foot"><div class="help">${esc(t('recipe.help'))}</div><div class="spacer"></div>
                 <button class="btn btn-primary" id="save-recipe">${icon('check')} ${esc(t('common.save'))}</button></div>`
            : ''
        }
      </div>`;
    const tbody = body.querySelector('#recipe-lines');
    const paintCost = () => {
      const el = body.querySelector('#recipe-cost');
      if (el) el.textContent = money(cost());
    };
    const paint = () => {
      tbody.innerHTML = lines.length
        ? lines
            .map(
              (l, i) => `<tr data-recipe-row="${l.id}">
                <td><div class="cell-title">${esc(l.name)}</div></td>
                <td class="right"><span class="qty-unit"><input class="input price-input" type="number" step="any" min="0" data-recipe-qty="${i}"
                  value="${l.qty}" aria-label="${esc(l.name)}" ${admin ? '' : 'disabled'}/><span class="muted">${esc(l.unit || '')}</span></span></td>
                ${admin ? `<td class="right" data-recipe-cost="${i}">${money((Number(l.qty) || 0) * (Number(l.cost) || 0))}</td>` : ''}
                <td>${admin ? `<button class="btn btn-ghost btn-icon btn-sm" data-recipe-remove="${i}" aria-label="${esc(t('common.delete'))}">${icon('trash')}</button>` : ''}</td>
              </tr>`,
            )
            .join('')
        : `<tr><td colspan="4"><div class="empty"><p>${esc(t('recipe.empty'))}</p></div></td></tr>`;
      tbody.querySelectorAll('[data-recipe-qty]').forEach((el) =>
        el.addEventListener('input', () => {
          const l = lines[+el.dataset.recipeQty];
          l.qty = Number(el.value) || 0;
          const c = tbody.querySelector(`[data-recipe-cost="${el.dataset.recipeQty}"]`);
          if (c) c.textContent = money(l.qty * (Number(l.cost) || 0));
          paintCost();
        }),
      );
      tbody.querySelectorAll('[data-recipe-remove]').forEach((b) =>
        b.addEventListener('click', () => {
          lines.splice(+b.dataset.recipeRemove, 1);
          paint();
        }),
      );
      paintCost();
    };
    paint();

    const find = body.querySelector('#recipe-find');
    if (find) {
      const picker = attachPicker(find, {
        // Any stocked item can go into a recipe; raw materials are the usual ones.
        search: (q) => (q ? api.products({ search: q, limit: 25, leaf: '1' }).then((rows) => rows.filter((p) => p.id !== id)) : []),
        render: productOption,
        emptyText: t('buy.no_product_match'),
        openOnFocus: false,
        onPick: (p) => {
          find.value = '';
          picker.reset();
          if (!lines.some((l) => l.id === p.id)) lines.push({ id: p.id, name: p.name, unit: p.unit, cost: Number(p.cost) || 0, qty: 0 });
          paint();
          tbody.querySelector(`[data-recipe-row="${p.id}"] [data-recipe-qty]`)?.focus();
        },
      });
      dropPickers = () => picker.destroy();
    }
    body.querySelector('#save-recipe')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.saveRecipe(id, lines.map((l) => ({ ingredient_id: l.id, qty: Number(l.qty) || 0 })));
        toast(t('recipe.saved'), 'success');
        showTab();
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
      }
    });
  }

  /* Overview: the key numbers, the last 30 days of selling and the latest movements. */
  async function tabOverview() {
    const report = await api.productSales(id, { from: shiftDays(todayISO(), -29), to: todayISO() });
    if (state.tab !== 'overview') return;
    const s = report.summary;
    const low = product.stock <= product.min_stock;
    body.innerHTML = `
      <div class="stats">
        ${statTile({
          label: t('common.stock'),
          value: `${qtyText(product.stock)} <small>${esc(product.unit)}</small>`,
          foot: t('prod.min_level', { q: qtyText(product.min_stock) }),
          tint: product.stock <= 0 ? 'danger' : low ? 'warn' : 'success',
          iconName: 'box',
        })}
        ${statTile({
          label: t('common.price'),
          value: money(product.price),
          foot: second() ? money2Html(product.price) : t('prod.per_unit', { u: product.unit }),
          iconName: 'coins',
        })}
        ${admin ? statTile({ label: t('common.cost'), value: money(product.cost), foot: `${t('common.margin')} ${pct(product.margin)}`, iconName: 'truck' }) : ''}
        ${admin ? statTile({ label: t('common.value'), value: money(product.stock_value), foot: t('prod.stock_value_foot'), iconName: 'wallet' }) : ''}
        ${statTile({
          label: t('prod.sold_30'),
          value: `${qtyText(product.sold_30)} <small>${esc(product.unit)}</small>`,
          foot: money(product.revenue_30),
          tint: 'info',
          iconName: 'trendUp',
        })}
      </div>
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
    body.querySelector('[data-goto]')?.addEventListener('click', (e) => go(e.currentTarget.dataset.goto));
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
