import { api } from '../api.js';
import { attachPicker } from '../picker.js';
import { attachNamePicker } from '../name-picker.js';
import { productOption } from '../product-option.js';
import { icon } from '../icons.js';
import { errorText, t } from '../i18n.js';
import {
  debounce,
  emptyState,
  esc,
  money,
  qtyText,
  signClass,
  store,
  suggestions,
  toast,
  todayISO,
} from '../ui.js';

/**
 * Stock count (جردة): count what is really on the shelf and let ABSoft correct
 * the books. Bring in the whole catalogue, one category, or just the items being
 * counted; type what you counted beside what the system thinks, and the
 * difference appears as you type. Saving records one stock adjustment document,
 * so every correction keeps its trail.
 */
export async function render(root, ctx) {
  const admin = store.user?.role === 'admin';
  const state = {
    mode: '', // nothing is loaded until you choose what to count
    category: '',
    search: '',
    rows: [], // the products on the sheet, in the order they appear
    counted: new Map(), // product id -> what was typed (kept while the sheet changes)
    date: todayISO(),
    note: '',
  };
  let catalogue = [];
  const pickers = [];
  const categories = await suggestions('category');

  ctx.actions.innerHTML = `
    <button class="btn" id="count-clear">${icon('refresh')} ${esc(t('cnt.clear'))}</button>
    <button class="btn btn-primary" id="count-save">${icon('check')} ${esc(t('cnt.save'))}</button>`;

  root.innerHTML = `
    <div class="toolbar sticky-bar count-bar">
      <div class="seg" id="count-mode">
        <button data-mode="all">${esc(t('cnt.mode_all'))}</button>
        <button data-mode="category">${esc(t('cnt.mode_category'))}</button>
        <button data-mode="pick">${esc(t('cnt.mode_pick'))}</button>
      </div>
      <div class="combo count-category" id="category-wrap" hidden>
        <input class="input" id="count-category" placeholder="${esc(t('cnt.pick_category'))}" autocomplete="off"/>
      </div>
      <div class="combo count-find" id="find-wrap" hidden>
        <div class="input-icon">${icon('barcode')}
          <input class="input" id="count-find" placeholder="${esc(t('cnt.find'))}" autocomplete="off"/>
        </div>
      </div>
      <div class="input-icon count-search">${icon('search')}
        <input class="input" data-search id="count-search" placeholder="${esc(t('cnt.search'))}"/>
      </div>
      <div class="spacer"></div>
      <div class="muted" id="count-summary" style="font-size:12.5px"></div>
    </div>
    <div id="count-body"></div>`;

  const body = root.querySelector('#count-body');
  const findWrap = root.querySelector('#find-wrap');
  const categoryWrap = root.querySelector('#category-wrap');

  const allProducts = async () => {
    if (!catalogue.length) catalogue = await api.products();
    return catalogue;
  };

  /* --------------------------------------------------------------- sheet -- */

  const changeOf = (row) => {
    const typed = state.counted.get(row.id);
    if (typed === undefined || typed === '') return null;
    return Math.round((Number(typed) - row.stock) * 1000) / 1000;
  };
  const countedRows = () => state.rows.filter((r) => changeOf(r) !== null);

  function summary() {
    const counted = countedRows();
    const differing = counted.filter((r) => changeOf(r) !== 0);
    const value = differing.reduce((s, r) => s + changeOf(r) * r.cost, 0);
    root.querySelector('#count-summary').textContent = state.rows.length
      ? t('cnt.summary', { n: state.rows.length, c: counted.length, d: differing.length })
      : '';
    const foot = body.querySelector('[data-foot]');
    if (foot) {
      foot.innerHTML = `${esc(t('cnt.counted_n', { n: counted.length }))} · ${esc(
        t('cnt.differ_n', { n: differing.length }),
      )}${admin ? ` · <span class="${signClass(value)}">${money(value)}</span>` : ''}`;
    }
  }

  function paintRow(row) {
    const tr = body.querySelector(`tr[data-row="${row.id}"]`);
    if (!tr) return;
    const change = changeOf(row);
    const diff = tr.querySelector('[data-diff]');
    const after = tr.querySelector('[data-after]');
    diff.textContent = change === null ? '' : `${change > 0 ? '+' : ''}${qtyText(change)}`;
    diff.className = `right nowrap ${change ? signClass(change) : 'muted'}`;
    after.textContent = change === null ? '' : `${qtyText(row.stock + change)} ${row.unit}`;
    tr.classList.toggle('counted', change !== null);
    tr.classList.toggle('differs', !!change);
    summary();
  }

  function draw() {
    const words = state.search.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = state.rows.filter((r) =>
      words.every((w) =>
        `${r.name} ${r.barcode || ''} ${(r.barcodes || []).join(' ')} ${r.category || ''} ${r.description || ''}`
          .toLowerCase()
          .includes(w),
      ),
    );

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t('cnt.sheet'))}</h3>
            <div class="sub">${esc(t('cnt.sheet_sub'))}</div></div>
          <div class="spacer"></div>
          <div class="count-head-fields">
            <label class="field-inline"><span>${esc(t('common.date'))}</span>
              <input class="input" type="date" id="count-date" value="${state.date}"/></label>
            <label class="field-inline"><span>${esc(t('common.note'))}</span>
              <input class="input" id="count-note" value="${esc(state.note)}"
                     placeholder="${esc(t('cnt.note_placeholder'))}"/></label>
          </div>
        </div>
        <div class="card-body flush">${
          shown.length
            ? `<div class="table-wrap table-scroll"><table class="data count-table">
                <thead><tr>
                  <th>${esc(t('nav.products'))}</th>
                  <th>${esc(t('common.category'))}</th>
                  <th class="right">${esc(t('cnt.in_system'))}</th>
                  <th class="right">${esc(t('cnt.counted'))}</th>
                  <th class="right">${esc(t('cnt.difference'))}</th>
                  <th class="right">${esc(t('adj.after'))}</th>
                  <th></th>
                </tr></thead>
                <tbody>${shown
                  .map(
                    (r) => `<tr data-row="${r.id}">
                      <td><div class="cell-title">${esc(r.name)}</div>
                          <div class="cell-sub mono">${esc(r.barcode || '')}</div></td>
                      <td>${r.category ? `<span class="badge">${esc(r.category)}</span>` : ''}</td>
                      <td class="right nowrap">${qtyText(r.stock)} ${esc(r.unit)}</td>
                      <td><input class="input" type="number" step="any" min="0" data-counted="${r.id}"
                                 value="${esc(state.counted.get(r.id) ?? '')}" placeholder=""
                                 aria-label="${esc(t('cnt.counted'))}" style="text-align:end"/></td>
                      <td class="right nowrap" data-diff></td>
                      <td class="right nowrap muted" data-after></td>
                      <td class="right"><button type="button" class="cl-remove" data-drop="${r.id}"
                              title="${esc(t('cnt.drop_row'))}">${icon('trash')}</button></td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr><td colspan="7" data-foot></td></tr></tfoot>
              </table></div>`
            : emptyState(
                state.rows.length ? t('cnt.none_match') : state.mode ? t('cnt.empty') : t('cnt.choose'),
                state.rows.length ? t('cnt.none_match_sub') : state.mode ? t('cnt.empty_sub') : t('cnt.choose_sub'),
                'clipboard',
              )
        }</div>
      </div>`;

    const inputs = [...body.querySelectorAll('[data-counted]')];
    inputs.forEach((input, i) => {
      input.addEventListener('input', () => {
        const row = state.rows.find((r) => r.id === Number(input.dataset.counted));
        state.counted.set(row.id, input.value);
        paintRow(row);
      });
      input.addEventListener('focus', () => input.select());
      // Enter walks down the sheet, the way a counter works along a shelf.
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        inputs[i + 1]?.focus();
      });
    });
    body.querySelectorAll('[data-drop]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.drop);
        state.rows = state.rows.filter((r) => r.id !== id);
        state.counted.delete(id);
        draw();
      }),
    );
    body.querySelector('#count-date')?.addEventListener('change', (e) => (state.date = e.target.value));
    body.querySelector('#count-note')?.addEventListener('input', (e) => (state.note = e.target.value));
    state.rows.forEach(paintRow);
    summary();
  }

  /* ---------------------------------------------------------------- load -- */

  const rowFor = (p) => ({
    id: p.id,
    name: p.name,
    barcode: p.barcode || '',
    category: p.category || '',
    description: p.description || '',
    unit: p.unit,
    stock: Number(p.stock) || 0,
    cost: Number(p.cost) || 0,
  });

  const loading = () => {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
  };

  async function loadAll() {
    loading();
    state.rows = (await allProducts()).map(rowFor);
    draw();
  }

  async function loadCategory(name) {
    state.category = name;
    loading();
    const wanted = name.toLowerCase();
    state.rows = (await allProducts()).filter((p) => (p.category || '').toLowerCase() === wanted).map(rowFor);
    draw();
    if (!state.rows.length) toast(t('cnt.category_empty', { name }), 'warn');
  }

  function addProduct(p) {
    if (!state.rows.some((r) => r.id === p.id)) state.rows.unshift(rowFor(p));
    draw();
    const input = body.querySelector(`[data-counted="${p.id}"]`);
    input?.focus();
  }

  root.querySelector('#count-mode').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    root.querySelectorAll('#count-mode [data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    categoryWrap.hidden = state.mode !== 'category';
    findWrap.hidden = state.mode !== 'pick';
    if (state.mode === 'all') return loadAll();
    // Counting a category or a handful of items starts from an empty sheet.
    state.rows = [];
    draw();
    root.querySelector(state.mode === 'category' ? '#count-category' : '#count-find').focus();
  });

  pickers.push(
    attachNamePicker(root.querySelector('#count-category'), {
      kind: 'category',
      extra: categories,
      onPick: (c) => loadCategory(c.name),
    }),
  );

  const find = root.querySelector('#count-find');
  const productPicker = attachPicker(find, {
    search: (q) => (q ? api.products({ search: q, limit: 25 }) : []),
    render: productOption,
    emptyText: t('buy.no_product_match'),
    openOnFocus: false,
    onPick: (p) => {
      find.value = '';
      productPicker.reset();
      addProduct(p);
    },
  });
  pickers.push(productPicker);

  // A scanner types the code and presses Enter before any search answers.
  find.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    e.preventDefault();
    const code = find.value.trim();
    if (!code) return;
    productPicker.reset();
    try {
      const p = await api.lookup(code);
      find.value = '';
      addProduct(p);
    } catch {
      productPicker.refresh();
    }
  });

  root.querySelector('#count-search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      draw();
    }, 200),
  );

  ctx.actions.querySelector('#count-clear').addEventListener('click', () => {
    state.counted.clear();
    draw();
    toast(t('cnt.cleared'), 'info');
  });

  ctx.actions.querySelector('#count-save').addEventListener('click', async () => {
    const counted = countedRows();
    if (!counted.length) return toast(t('cnt.nothing_counted'), 'warn');
    if (!counted.some((r) => changeOf(r) !== 0)) return toast(t('cnt.all_match'), 'success');
    try {
      // The count is applied against the balance at the moment of saving, and
      // kept as an ordinary stock adjustment document.
      const saved = await api.createAdjustment({
        date: state.date,
        reason: t('adj.reason.count'),
        note: state.note.trim(),
        items: counted.map((r) => ({ product_id: r.id, counted: Number(state.counted.get(r.id)) })),
      });
      toast(t('cnt.saved', { doc: saved.doc_no, n: saved.items.length }), 'success');
      ctx.navigate(`adjustments/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  // Nothing is fetched until a choice is made: counting everything is a choice too.
  draw();

  // main.js calls this when navigating away.
  return () => pickers.forEach((p) => p.destroy());
}
