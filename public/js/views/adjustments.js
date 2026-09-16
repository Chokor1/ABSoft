import { api } from '../api.js';
import { attachPicker } from '../picker.js';
import { attachNamePicker } from '../name-picker.js';
import { productOption } from '../product-option.js';
import { icon } from '../icons.js';
import { count, errorText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  debounce,
  docPage,
  downloadCsv,
  emptyState,
  esc,
  filterSelect,
  pager,
  money,
  monthStart,
  qtyText,
  rangeBar,
  signClass,
  suggestions,
  toast,
  todayISO,
} from '../ui.js';

const REASONS = ['count', 'damaged', 'expired', 'lost', 'return_in', 'return_out', 'use', 'other'];
const reasonChoices = () => REASONS.map((r) => t(`adj.reason.${r}`));

const signed = (n) => `${Number(n) > 0 ? '+' : ''}${qtyText(n)}`;

/** #/adjustments, #/adjustments/new, #/adjustments/opening, #/adjustments/<id> */
export async function render(root, ctx) {
  if (ctx.params[0] === 'new') return renderForm(root, ctx);
  if (ctx.params[0] === 'opening') return renderOpeningForm(root, ctx);
  if (/^\d+$/.test(ctx.params[0] || '')) return renderDoc(root, ctx, Number(ctx.params[0]));
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '', reason: '', type: '', page: 1, per: 50 };
  let rows = [];

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn" id="new-opening">${icon('package')} ${esc(t('opn.new'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('adj.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('adjustments/new'));
  ctx.actions.querySelector('#new-opening').addEventListener('click', () => ctx.navigate('adjustments/opening'));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-adjustments-${state.from}-to-${state.to}.csv`,
      rows.map((a) => ({
        doc_no: a.doc_no,
        date: a.date,
        type: a.type,
        reason: a.reason,
        lines: a.line_count,
        qty_in: a.qty_in,
        qty_out: a.qty_out,
        value: a.value,
        note: a.note,
        user: a.username || '',
      })),
    ),
  );

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    refilter();
  });
  bar.classList.add('sticky-bar');
  const refilter = () => {
    state.page = 1;
    load();
  };
  const searchWrap = document.createElement('div');
  searchWrap.className = 'input-icon';
  searchWrap.style.minWidth = '240px';
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('adj.search'))}"/>`;
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
      label: t('filter.type'),
      value: state.type,
      options: [
        { value: '', label: t('filter.all') },
        { value: 'adjustment', label: t('adj.type.adjustment') },
        { value: 'opening', label: t('adj.type.opening') },
      ],
      onChange: (v) => {
        state.type = v;
        refilter();
      },
    }),
  );

  // Only the reasons actually used are worth offering.
  const reasons = await api.adjustmentReasons().catch(() => []);
  if (reasons.length) {
    bar.appendChild(
      filterSelect({
        label: t('filter.reason'),
        value: state.reason,
        options: [{ value: '', label: t('filter.all') }, ...reasons.map((r) => ({ value: r, label: r }))],
        onChange: (v) => {
          state.reason = v;
          refilter();
        },
      }),
    );
  }

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const result = await api.adjustments({
      from: state.from,
      to: state.to,
      search: state.search,
      reason: state.reason,
      type: state.type,
      page: state.page,
      per: state.per,
    });
    rows = result.rows;
    const value = result.sums.value; // everything that matches, not just this page
    const pageValue = rows.reduce((s, a) => s + a.value, 0);

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(count('adj', result.total))}</h3>
            <div class="sub">${dateText(state.from)} → ${dateText(state.to)}</div></div>
          <div class="spacer"></div>
          <span class="badge ${value < 0 ? 'danger' : 'success'}">${esc(t('adj.value_badge', { v: money(value) }))}</span>
        </div>
        <div class="card-body flush">
          ${
            rows.length
              ? `<div class="table-wrap table-scroll"><table class="data">
                  <thead><tr><th>${esc(t('buy.document'))}</th><th>${esc(t('common.date'))}</th>
                    <th>${esc(t('adj.reason'))}</th><th class="right">${esc(t('common.lines'))}</th>
                    <th class="right">${esc(t('adj.in'))}</th><th class="right">${esc(t('adj.out'))}</th>
                    <th class="right">${esc(t('adj.value'))}</th>
                    <th>${esc(t('common.note'))}</th><th>${esc(t('common.user'))}</th><th></th></tr></thead>
                  <tbody>${rows
                    .map(
                      (a) => `<tr class="row-click" data-open="${a.id}">
                        <td class="nowrap"><span class="mono">${esc(a.doc_no)}</span>${
                          a.type === 'opening' ? ` <span class="badge accent">${esc(t('adj.type.opening'))}</span>` : ''
                        }</td>
                        <td class="nowrap">${dateText(a.date)}</td>
                        <td>${esc(a.reason || t('common.none'))}</td>
                        <td class="right">${a.line_count}</td>
                        <td class="right money-pos">${a.qty_in ? `+${qtyText(a.qty_in)}` : ''}</td>
                        <td class="right money-neg">${a.qty_out ? `−${qtyText(a.qty_out)}` : ''}</td>
                        <td class="right ${signClass(a.value)}"><b>${money(a.value)}</b></td>
                        <td class="muted">${esc(a.note || '')}</td>
                        <td class="muted">${esc(a.username || t('common.none'))}</td>
                        <td class="right"><button class="btn btn-sm btn-ghost" data-del="${a.id}" title="${esc(
                          t('common.delete'),
                        )}">${icon('trash')}</button></td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                  <tfoot><tr><td colspan="6">${esc(t('page.page_total'))}</td>
                    <td class="right ${signClass(pageValue)}">${money(pageValue)}</td><td colspan="3"></td></tr></tfoot>
                </table></div>`
              : emptyState(t('adj.none'), t('adj.none_sub'), 'adjust')
          }
        </div>
      </div>`;

    if (rows.length) {
      body.querySelector('.card').append(
        pager(result, ({ page, per }) => {
          state.page = page;
          state.per = per;
          load();
        }),
      );
    }

    body.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        ctx.navigate(`adjustments/${tr.dataset.open}`);
      }),
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: t('adj.delete_title'),
          message: t('adj.delete_msg'),
          confirmLabel: t('adj.delete_confirm'),
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deleteAdjustment(b.dataset.del);
          toast(t('adj.deleted'), 'success');
          load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }),
    );
  }

  await load();
}

/** One adjustment, as a page. */
async function renderDoc(root, ctx, id) {
  const back = () => ctx.navigate('adjustments');
  let a;
  try {
    a = await api.adjustment(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return back();
  }
  const body = docPage(root, {
    title: t('adj.view_title', { doc: a.doc_no }),
    subtitle: [dateText(a.date), a.full_name || a.username].filter(Boolean).join(' · '),
    badges: `${a.type === 'opening' ? `<span class="badge accent">${esc(t('adj.type.opening'))}</span>` : a.reason ? `<span class="badge">${esc(a.reason)}</span>` : ''}
             <span class="badge ${signClass(a.value) === 'money-neg' ? 'danger' : 'success'}">${esc(t('adj.value_badge', { v: money(a.value) }))}</span>`,
    actions: `<button class="btn" data-print>${icon('print')} ${esc(t('common.print'))}</button>
              <button class="btn btn-ghost" data-del title="${esc(t('common.delete'))}">${icon('trash')}</button>`,
    onBack: back,
  });
  body.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>${esc(t('adj.lines_title'))}</h3>
        <div class="sub">${esc(t('adj.lines_sub', { n: a.items.length, i: qtyText(a.qty_in), o: qtyText(a.qty_out) }))}</div></div></div>
      <div class="card-body flush">
        <div class="table-wrap table-scroll"><table class="data">
          <thead><tr><th>${esc(t('nav.products'))}</th><th class="right">${esc(t('adj.before'))}</th>
            <th class="right">${esc(t('adj.change'))}</th><th class="right">${esc(t('adj.after'))}</th>
            ${a.type === 'opening' ? `<th class="right">${esc(t('buy.unit_cost'))}</th>` : ''}
            <th class="right">${esc(t('adj.value'))}</th></tr></thead>
          <tbody>${a.items
            .map(
              (i) => `<tr class="row-click" data-product="${i.product_id}">
                <td><div class="cell-title">${esc(i.name)}</div>
                    <div class="cell-sub mono">${esc(i.barcode || '')}</div></td>
                <td class="right">${qtyText(i.stock_before)} ${esc(i.unit)}</td>
                <td class="right ${signClass(i.qty)}"><b>${signed(i.qty)}</b></td>
                <td class="right">${qtyText(i.stock_before + i.qty)} ${esc(i.unit)}</td>
                ${a.type === 'opening' ? `<td class="right">${money(i.unit_cost)}</td>` : ''}
                <td class="right ${signClass(i.value)}">${money(i.value)}</td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="2">${esc(t('common.total'))}</td>
            <td class="right"><span class="money-pos">+${qtyText(a.qty_in)}</span> / <span class="money-neg">−${qtyText(a.qty_out)}</span></td>
            <td></td>${a.type === 'opening' ? '<td></td>' : ''}
            <td class="right ${signClass(a.value)}">${money(a.value)}</td></tr></tfoot>
        </table></div>
      </div>
      ${a.note ? `<div class="card-body doc-note">${esc(a.note)}</div>` : ''}
    </div>`;

  body.querySelectorAll('[data-product]').forEach((tr) =>
    tr.addEventListener('click', () => ctx.navigate(`products/${tr.dataset.product}`)),
  );
  root.querySelector('[data-print]').addEventListener('click', () => window.print());
  root.querySelector('[data-del]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('adj.delete_title'),
      message: t('adj.delete_msg'),
      confirmLabel: t('adj.delete_confirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAdjustment(a.id);
      toast(t('adj.deleted'), 'success');
      back();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

/** The adjustment document builder: find products, then say what was counted or how much changed. */
async function renderForm(root, ctx) {
  const back = () => ctx.navigate('adjustments');
  const lines = [];
  const categories = await suggestions('category');

  root.innerHTML = `
    <form id="adj-form" class="card form-page" novalidate>
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" data-cancel
                aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(t('adj.title'))}</h3><div class="sub">${esc(t('adj.sub'))}</div></div>
      </div>
      <div class="card-body">
        <div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="field"><label>${esc(t('common.date'))}</label>
            <input class="input" type="date" name="date" value="${todayISO()}"/></div>
          <div class="field"><label>${esc(t('adj.reason'))}</label>
            <div class="combo"><input class="input" name="reason" value="${esc(t('adj.reason.count'))}" autocomplete="off"/></div></div>
          <div class="field"><label>${esc(t('common.note'))}</label>
            <input class="input" name="note" placeholder="${esc(t('adj.note_placeholder'))}" autocomplete="off"/></div>
        </div>
      </div>
      <div class="card-head adj-add" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div class="combo adj-find">
          <div class="input-icon">${icon('barcode')}
            <input class="input" id="adj-find" placeholder="${esc(t('adj.find'))}" autocomplete="off"/>
          </div>
        </div>
        ${
          categories.length
            ? `<div class="combo adj-category"><input class="input" id="adj-category" placeholder="${esc(
                t('adj.add_category'),
              )}" autocomplete="off"/></div>`
            : ''
        }
      </div>
      <div class="table-wrap" id="adj-lines"></div>
      <div class="card-head form-actions">
        <div class="muted" id="adj-summary" style="font-size:13px"></div>
        <div class="spacer"></div>
        <button type="button" class="btn" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="save-adj">${icon('check')} ${esc(t('adj.save'))}</button>
      </div>
    </form>`;

  const form = root.querySelector('#adj-form');
  const linesEl = root.querySelector('#adj-lines');
  const find = root.querySelector('#adj-find');
  const pickers = [attachNamePicker(form.reason, { extra: reasonChoices() })];

  const changeOf = (l) => (l.mode === 'counted' ? (l.counted === '' ? 0 : Number(l.counted) - l.stock) : Number(l.change) || 0);
  const round = (n) => Math.round(n * 1000) / 1000;

  function summary() {
    const moving = lines.filter((l) => round(changeOf(l)) !== 0);
    const value = moving.reduce((s, l) => s + changeOf(l) * l.cost, 0);
    root.querySelector('#adj-summary').textContent = lines.length
      ? t('adj.summary', { n: lines.length, m: moving.length, v: money(value) })
      : '';
    const foot = linesEl.querySelector('[data-foot-value]');
    if (foot) {
      foot.textContent = money(value);
      foot.className = `right ${signClass(value)}`;
    }
  }

  function paintLine(i) {
    const l = lines[i];
    const row = linesEl.querySelector(`tr[data-line="${i}"]`);
    if (!row) return;
    const change = round(changeOf(l));
    if (l.mode === 'counted') row.querySelector('[data-change]').value = l.counted === '' ? '' : change;
    else row.querySelector('[data-counted]').value = l.change === '' ? '' : round(l.stock + change);
    const after = row.querySelector('[data-after]');
    after.textContent = `${qtyText(l.stock + change)} ${l.unit}`;
    after.className = `right ${change ? signClass(change) : 'muted'}`;
    const val = row.querySelector('[data-value]');
    val.textContent = change ? money(change * l.cost) : '';
    val.className = `right ${signClass(change)}`;
    summary();
  }

  function draw() {
    linesEl.innerHTML = lines.length
      ? `<table class="data adj-table">
          <thead><tr><th>${esc(t('nav.products'))}</th>
            <th class="right">${esc(t('adj.in_stock'))}</th>
            <th class="right" style="width:130px">${esc(t('adj.counted'))}</th>
            <th class="right" style="width:130px">${esc(t('adj.change'))}</th>
            <th class="right">${esc(t('adj.after'))}</th>
            <th class="right">${esc(t('adj.value'))}</th><th style="width:40px"></th></tr></thead>
          <tbody>${lines
            .map(
              (l, i) => `<tr data-line="${i}">
                <td><div class="cell-title">${esc(l.name)}</div><div class="cell-sub mono">${esc(l.barcode || '')}</div></td>
                <td class="right nowrap">${qtyText(l.stock)} ${esc(l.unit)}</td>
                <td><input class="input" type="number" step="any" min="0" data-counted="${i}" style="text-align:end"
                      value="${l.mode === 'counted' ? esc(l.counted) : ''}" placeholder="${esc(qtyText(l.stock))}"/></td>
                <td><input class="input" type="number" step="any" data-change="${i}" style="text-align:end"
                      value="${l.mode === 'change' ? esc(l.change) : ''}" placeholder="±0"/></td>
                <td class="right nowrap" data-after></td>
                <td class="right" data-value></td>
                <td class="right"><button type="button" class="cl-remove" data-remove="${i}">${icon('trash')}</button></td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="5">${esc(t('adj.value_total'))}</td><td class="right" data-foot-value></td><td></td></tr></tfoot>
        </table>`
      : emptyState(t('adj.no_lines'), t('adj.no_lines_sub'), 'package');

    linesEl.querySelectorAll('[data-counted]').forEach((input) =>
      input.addEventListener('input', () => {
        const l = lines[+input.dataset.counted];
        l.mode = 'counted';
        l.counted = input.value;
        paintLine(+input.dataset.counted);
      }),
    );
    linesEl.querySelectorAll('[data-change]').forEach((input) =>
      input.addEventListener('input', () => {
        const l = lines[+input.dataset.change];
        l.mode = 'change';
        l.change = input.value;
        paintLine(+input.dataset.change);
      }),
    );
    // Enter on a line jumps back to the product search, ready for the next scan.
    linesEl.querySelectorAll('input').forEach((input) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          find.focus();
        }
      }),
    );
    linesEl.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        lines.splice(+btn.dataset.remove, 1);
        draw();
      }),
    );
    lines.forEach((_, i) => paintLine(i));
    summary();
  }

  /** Add a product (or return to its line) and put the cursor on its count. */
  function addProduct(p, { focus = true } = {}) {
    let i = lines.findIndex((l) => l.product_id === p.id);
    if (i < 0) {
      lines.unshift({
        product_id: p.id,
        name: p.name,
        barcode: p.barcode || '',
        unit: p.unit,
        stock: Number(p.stock) || 0,
        cost: Number(p.cost) || 0,
        mode: 'counted',
        counted: '',
        change: '',
      });
      i = 0;
      draw();
    }
    if (focus) {
      const input = linesEl.querySelector(`[data-counted="${i}"]`);
      input?.focus();
      input?.select();
    }
    return i;
  }

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

  // A scanner types the code and presses Enter before any search returns.
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

  const categoryInput = root.querySelector('#adj-category');
  if (categoryInput) {
    pickers.push(
      attachNamePicker(categoryInput, {
        kind: 'category',
        onPick: async (c) => {
          const found = (await api.products({ search: c.name })).filter(
            (p) => (p.category || '').toLowerCase() === c.name.toLowerCase(),
          );
          categoryInput.value = '';
          if (!found.length) return toast(t('adj.category_empty', { name: c.name }), 'warn');
          [...found].reverse().forEach((p) => addProduct(p, { focus: false }));
          toast(t('adj.category_added', { n: found.length, name: c.name }), 'success');
          linesEl.querySelector('[data-counted="0"]')?.focus();
        },
      }),
    );
  }

  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', back));

  root.querySelector('#save-adj').addEventListener('click', async () => {
    const moving = lines.filter((l) => round(changeOf(l)) !== 0);
    if (!moving.length) return toast(t('adj.need_change'), 'warn');
    try {
      const saved = await api.createAdjustment({
        date: form.date.value,
        reason: form.reason.value.trim(),
        note: form.note.value.trim(),
        items: moving.map((l) =>
          l.mode === 'counted'
            ? { product_id: l.product_id, counted: Number(l.counted) }
            : { product_id: l.product_id, qty: Number(l.change) },
        ),
      });
      toast(t('adj.saved', { doc: saved.doc_no, n: saved.items.length }), 'success');
      back();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  draw();
  find.focus();
  return () => pickers.forEach((p) => p.destroy());
}

/* ------------------------------------------------- opening stock builder -- */

/** Opening stock: a stock adjustment of type "opening", with a quantity and a cost per product. */
async function renderOpeningForm(root, ctx) {
  const back = () => ctx.navigate('adjustments');
  const lines = [];

  root.innerHTML = `
    <div class="card form-page" id="opn-form">
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" data-cancel aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(t('opn.title'))}</h3><div class="sub">${esc(t('opn.sub'))}</div></div>
      </div>
      <div class="card-body">
        <div class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          <div class="field"><label>${esc(t('common.date'))}</label>
            <input class="input" type="date" id="opn-date" value="${todayISO()}"/></div>
          <div class="field"><label>${esc(t('common.note'))}</label>
            <input class="input" id="opn-note" placeholder="${esc(t('opn.note_placeholder'))}" autocomplete="off"/></div>
        </div>
      </div>
      <div class="card-head" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div class="combo" style="flex:1">
          <div class="input-icon">${icon('barcode')}
            <input class="input" id="opn-find" placeholder="${esc(t('opn.find'))}" autocomplete="off"/>
          </div>
        </div>
      </div>
      <div class="table-wrap" id="opn-lines"></div>
      <div class="card-head form-actions">
        <div class="muted" id="opn-summary" style="font-size:13px"></div>
        <div class="spacer"></div>
        <button type="button" class="btn" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="opn-save">${icon('check')} ${esc(t('opn.save'))}</button>
      </div>
    </div>`;

  const linesEl = root.querySelector('#opn-lines');
  const find = root.querySelector('#opn-find');

  const summary = () => {
    const filled = lines.filter((l) => Number(l.qty) > 0);
    const value = filled.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost), 0);
    root.querySelector('#opn-summary').textContent = lines.length
      ? t('opn.summary', { n: filled.length, v: money(value) })
      : '';
    const foot = linesEl.querySelector('[data-foot]');
    if (foot) foot.textContent = money(value);
  };

  function draw() {
    linesEl.innerHTML = lines.length
      ? `<table class="data">
          <thead><tr><th>${esc(t('nav.products'))}</th><th class="right">${esc(t('adj.in_stock'))}</th>
            <th class="right" style="width:140px">${esc(t('common.quantity'))}</th>
            <th class="right" style="width:140px">${esc(t('buy.unit_cost'))}</th>
            <th class="right">${esc(t('adj.value'))}</th><th style="width:40px"></th></tr></thead>
          <tbody>${lines
            .map(
              (l, i) => `<tr data-line="${i}">
                <td><div class="cell-title">${esc(l.name)}</div><div class="cell-sub mono">${esc(l.barcode || '')}</div></td>
                <td class="right nowrap muted">${qtyText(l.stock)} ${esc(l.unit)}</td>
                <td><input class="input" type="number" step="any" min="0" data-qty="${i}" value="${esc(l.qty)}" style="text-align:end"/></td>
                <td><input class="input" type="number" step="0.01" min="0" data-cost="${i}" value="${esc(l.unit_cost)}" style="text-align:end"/></td>
                <td class="right" data-value="${i}">${money(Number(l.qty) * Number(l.unit_cost))}</td>
                <td class="right"><button type="button" class="cl-remove" data-remove="${i}">${icon('trash')}</button></td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="4">${esc(t('adj.value'))}</td><td class="right" data-foot></td><td></td></tr></tfoot>
        </table>`
      : emptyState(t('opn.no_lines'), t('opn.no_lines_sub'), 'package');

    const repaint = (i) => {
      const l = lines[i];
      linesEl.querySelector(`[data-value="${i}"]`).textContent = money(Number(l.qty) * Number(l.unit_cost));
      summary();
    };
    linesEl.querySelectorAll('[data-qty]').forEach((input) =>
      input.addEventListener('input', () => {
        lines[+input.dataset.qty].qty = input.value;
        repaint(+input.dataset.qty);
      }),
    );
    linesEl.querySelectorAll('[data-cost]').forEach((input) =>
      input.addEventListener('input', () => {
        lines[+input.dataset.cost].unit_cost = input.value;
        repaint(+input.dataset.cost);
      }),
    );
    linesEl.querySelectorAll('input').forEach((input) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          find.focus();
        }
      }),
    );
    linesEl.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        lines.splice(+btn.dataset.remove, 1);
        draw();
      }),
    );
    summary();
  }

  function addProduct(p) {
    let i = lines.findIndex((l) => l.product_id === p.id);
    if (i < 0) {
      lines.unshift({
        product_id: p.id,
        name: p.name,
        barcode: p.barcode || '',
        unit: p.unit,
        stock: Number(p.stock) || 0,
        qty: '',
        unit_cost: Number(p.cost) || 0,
      });
      i = 0;
      draw();
    }
    const input = linesEl.querySelector(`[data-qty="${i}"]`);
    input?.focus();
    input?.select();
  }

  const picker = attachPicker(find, {
    search: (q) => (q ? api.products({ search: q, limit: 25 }) : []),
    render: productOption,
    emptyText: t('buy.no_product_match'),
    openOnFocus: false,
    onPick: (p) => {
      find.value = '';
      picker.reset();
      addProduct(p);
    },
  });
  // A scanner types the code and presses Enter before any search answers.
  find.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    e.preventDefault();
    const code = find.value.trim();
    if (!code) return;
    picker.reset();
    try {
      const p = await api.lookup(code);
      find.value = '';
      addProduct(p);
    } catch {
      picker.refresh();
    }
  });

  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', back));
  root.querySelector('#opn-save').addEventListener('click', async () => {
    const items = lines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({ product_id: l.product_id, qty: Number(l.qty), unit_cost: Number(l.unit_cost) || 0 }));
    if (!items.length) return toast(t('opn.need_line'), 'warn');
    try {
      const saved = await api.createAdjustment({
        type: 'opening',
        date: root.querySelector('#opn-date').value,
        note: root.querySelector('#opn-note').value.trim(),
        items,
      });
      toast(t('opn.saved', { doc: saved.doc_no, n: saved.items.length }), 'success');
      ctx.navigate(`adjustments/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  draw();
  find.focus();
  return () => picker.destroy();
}
