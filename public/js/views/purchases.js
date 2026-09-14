import { api } from '../api.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
import { icon } from '../icons.js';
import { count, errorText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  dateTimeText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  forgetSuggestions,
  modal,
  money,
  monthStart,
  qtyText,
  rangeBar,
  store,
  suggestions,
  toast,
  todayISO,
} from '../ui.js';

/** #/purchases, #/purchases/new, #/purchases/:id/edit */
export async function render(root, ctx) {
  if (ctx.params[0] === 'new') return renderForm(root, ctx);
  if (ctx.params[1] === 'edit' && ctx.params[0]) return renderForm(root, ctx, ctx.params[0]);
  return renderList(root, ctx);
}

const isAdmin = () => store.user?.role === 'admin';

async function renderList(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '' };
  let rows = [];

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('buy.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('purchases/new'));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-purchases-${state.from}-to-${state.to}.csv`,
      rows.map((p) => ({
        doc_no: p.doc_no,
        date: p.date,
        supplier: p.supplier,
        lines: p.line_count,
        quantity: p.total_qty,
        total: p.total,
        note: p.note,
        user: p.username || '',
      })),
    ),
  );

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    load();
  });
  const searchWrap = document.createElement('div');
  searchWrap.className = 'input-icon';
  searchWrap.style.minWidth = '240px';
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('buy.search'))}"/>`;
  searchWrap.querySelector('input').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      load();
    }, 250),
  );
  bar.appendChild(searchWrap);

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    rows = await api.purchases({ from: state.from, to: state.to, search: state.search });
    const total = rows.reduce((s, p) => s + p.total, 0);

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(count('buy', rows.length))}</h3>
            <div class="sub">${dateText(state.from)} → ${dateText(state.to)}</div></div>
          <div class="spacer"></div>
          <span class="badge accent">${esc(t('buy.spent', { v: money(total) }))}</span>
        </div>
        <div class="card-body flush">
          ${
            rows.length
              ? `<div class="table-wrap table-scroll"><table class="data">
                  <thead><tr><th>${esc(t('buy.document'))}</th><th>${esc(t('common.date'))}</th>
                    <th>${esc(t('common.supplier'))}</th><th class="right">${esc(t('common.lines'))}</th>
                    <th class="right">${esc(t('common.quantity'))}</th><th class="right">${esc(t('common.total'))}</th>
                    <th>${esc(t('common.note'))}</th><th>${esc(t('common.user'))}</th><th></th></tr></thead>
                  <tbody>${rows
                    .map(
                      (p) => `<tr class="row-click" data-open="${p.id}">
                        <td class="nowrap"><span class="mono">${esc(p.doc_no)}</span>${
                          p.edit_count
                            ? ` <span class="badge warn" title="${esc(t('buy.edited_times', { n: p.edit_count }))}">${esc(
                                t('buy.edited'),
                              )}</span>`
                            : ''
                        }</td>
                        <td class="nowrap">${dateText(p.date)}</td>
                        <td>${esc(p.supplier || t('common.none'))}</td>
                        <td class="right">${p.line_count}</td>
                        <td class="right">${qtyText(p.total_qty)}</td>
                        <td class="right"><b>${money(p.total)}</b></td>
                        <td class="muted">${esc(p.note || '')}</td>
                        <td class="muted">${esc(p.username || t('common.none'))}</td>
                        <td class="right nowrap">${
                          isAdmin()
                            ? `<button class="btn btn-sm btn-ghost" data-edit="${p.id}" title="${esc(
                                t('common.edit'),
                              )}">${icon('edit')}</button><button class="btn btn-sm btn-ghost" data-del="${p.id}" title="${esc(
                                t('common.delete'),
                              )}">${icon('trash')}</button>`
                            : ''
                        }</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                  <tfoot><tr><td colspan="5">${esc(t('common.total'))}</td>
                    <td class="right">${money(total)}</td><td colspan="3"></td></tr></tfoot>
                </table></div>`
              : emptyState(t('buy.none'), t('buy.none_sub'), 'truck')
          }
        </div>
      </div>`;

    body.querySelectorAll('[data-open]').forEach((tr) =>
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        showPurchase(await api.purchase(tr.dataset.open), ctx);
      }),
    );
    body.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.navigate(`purchases/${b.dataset.edit}/edit`);
      }),
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: t('buy.delete_title'),
          message: t('buy.delete_msg'),
          confirmLabel: t('buy.delete_confirm'),
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deletePurchase(b.dataset.del);
          toast(t('buy.deleted'), 'success');
          load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }),
    );
  }

  await load();
}

function showPurchase(p, ctx) {
  modal({
    title: t('buy.view_title', { doc: p.doc_no }),
    subtitle: `${dateText(p.date)}${p.supplier ? ` · ${p.supplier}` : ''}`,
    wide: true,
    body: `<div class="table-wrap"><table class="data">
        <thead><tr><th>${esc(t('nav.products'))}</th><th class="right">${esc(t('common.quantity'))}</th>
          <th class="right">${esc(t('buy.unit_cost'))}</th><th class="right">${esc(t('common.total'))}</th></tr></thead>
        <tbody>${p.items
          .map(
            (i) => `<tr>
              <td><div class="cell-title">${esc(i.name)}</div>
                  <div class="cell-sub mono">${esc(i.barcode || '')}</div></td>
              <td class="right">${qtyText(i.qty)} ${esc(i.unit)}</td>
              <td class="right">${money(i.unit_cost)}</td>
              <td class="right"><b>${money(i.total)}</b></td>
            </tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr><td colspan="3">${esc(t('common.total'))}</td><td class="right">${money(p.total)}</td></tr></tfoot>
      </table></div>
      ${p.note ? `<p class="muted" style="padding:12px 2px">${esc(p.note)}</p>` : ''}
      ${logHtml(p.log || [])}`,
    footer: `<button class="btn" data-close>${esc(t('common.close'))}</button>
             ${isAdmin() ? `<button class="btn btn-primary" data-edit>${icon('edit')} ${esc(t('common.edit'))}</button>` : ''}`,
    setup: (root, close) => {
      root.querySelector('[data-edit]')?.addEventListener('click', () => {
        close();
        ctx.navigate(`purchases/${p.id}/edit`);
      });
    },
  });
}

const FIELD_KEYS = { supplier: 'common.supplier', date: 'common.date', note: 'buy.ref' };
const fieldValue = (field, v) => (field === 'date' ? dateText(v) : v) || t('common.none');
const lineText = (x) => `${qtyText(x.qty)} × ${money(x.unit_cost)}`;

/** One entry of the purchase log, as a list of plain sentences. */
function logChangesHtml(entry) {
  const c = entry.changes || {};
  if (entry.action !== 'edited') {
    return c.total !== undefined
      ? `<li>${esc(t('buy.log_total', { v: money(c.total) }))}${
          c.lines !== undefined ? ` · ${esc(count('buy.lines', c.lines))}` : ''
        }</li>`
      : '';
  }
  const items = [];
  for (const f of c.fields || []) {
    items.push(
      `<li><b>${esc(t(FIELD_KEYS[f.field] || f.field))}</b>: <s>${esc(fieldValue(f.field, f.from))}</s> → ${esc(
        fieldValue(f.field, f.to),
      )}</li>`,
    );
  }
  for (const l of c.lines || []) {
    const name = `<b>${esc(l.name)}</b>`;
    if (l.type === 'added') items.push(`<li class="log-add">${esc(t('buy.log_added'))} ${name}: ${esc(lineText(l.to))}</li>`);
    else if (l.type === 'removed')
      items.push(`<li class="log-remove">${esc(t('buy.log_removed'))} ${name}: <s>${esc(lineText(l.from))}</s></li>`);
    else items.push(`<li>${name}: <s>${esc(lineText(l.from))}</s> → ${esc(lineText(l.to))}</li>`);
  }
  if (c.total) {
    items.push(`<li><b>${esc(t('common.total'))}</b>: <s>${money(c.total.from)}</s> → ${money(c.total.to)}</li>`);
  }
  return items.join('');
}

function logHtml(log) {
  if (!log.length) return '';
  return `<div class="purchase-log no-print">
    <div class="card-head" style="padding:0 0 8px;border-bottom:0">
      <div><h3 style="font-size:14px">${icon('history')} ${esc(t('buy.log'))}</h3></div>
    </div>
    <ol class="log-list">${log
      .map(
        (e) => `<li class="log-entry log-${esc(e.action)}">
          <div class="log-head">
            <span class="badge ${e.action === 'edited' ? 'warn' : e.action === 'deleted' ? 'danger' : 'success'}">${esc(
              t(`buy.log_${e.action}`),
            )}</span>
            <span>${esc(e.full_name || e.username || t('common.none'))}</span>
            <span class="spacer"></span>
            <span class="muted nowrap">${esc(dateTimeText(`${e.created_at}Z`))}</span>
          </div>
          <ul class="log-changes">${logChangesHtml(e)}</ul>
          ${e.reason ? `<div class="log-reason muted">“${esc(e.reason)}”</div>` : ''}
        </li>`,
      )
      .join('')}</ol>
  </div>`;
}

/** The stock-in document builder, as a full page. With `editId`, it edits a saved purchase. */
async function renderForm(root, ctx, editId = null) {
  const back = () => ctx.navigate('purchases');

  let editing = null;
  if (editId) {
    if (!isAdmin()) {
      toast(t('err.PURCHASE_EDIT_ADMIN_ONLY'), 'warn');
      return back();
    }
    try {
      editing = await api.purchase(editId);
    } catch (err) {
      toast(errorText(err), 'error');
      return back();
    }
  }

  // Only a count, to refuse an empty catalogue. Lines are searched, not preloaded.
  if (!(await api.products({ limit: 1 })).length) {
    toast(t('buy.need_product'), 'warn');
    return back();
  }
  const supplierNames = await suggestions('supplier');
  const lines = editing
    ? editing.items.map((i) => ({
        product_id: i.product_id,
        name: i.name,
        barcode: i.barcode || '',
        qty: i.qty,
        unit_cost: i.unit_cost,
        touchedCost: true,
      }))
    : [];

  const linesHtml = () =>
    lines.length
      ? `<table class="data">
          <thead><tr><th>${esc(t('nav.products'))}</th><th class="right" style="width:110px">${esc(t('common.qty'))}</th>
            <th class="right" style="width:130px">${esc(t('buy.unit_cost'))}</th>
            <th class="right" style="width:110px">${esc(t('common.total'))}</th><th style="width:40px"></th></tr></thead>
          <tbody>${lines
            .map(
              (l, i) => `<tr>
                <td>
                  <div class="combo">
                    <input class="input" data-product="${i}" value="${esc(l.name || '')}"
                           placeholder="${esc(t('buy.find_product'))}"/>
                  </div>
                  ${l.barcode ? `<div class="cell-sub mono">${esc(l.barcode)}</div>` : ''}
                </td>
                <td><input class="input" type="number" step="any" min="0" value="${l.qty}" data-qty="${i}" style="text-align:end"/></td>
                <td><input class="input" type="number" step="0.01" min="0" value="${l.unit_cost}" data-cost="${i}" style="text-align:end"/></td>
                <td class="right"><b>${money(l.qty * l.unit_cost)}</b></td>
                <td class="right"><button type="button" class="cl-remove" data-remove="${i}">${icon('trash')}</button></td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="3">${esc(t('buy.purchase_total'))}</td>
            <td class="right">${money(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0))}</td><td></td></tr></tfoot>
        </table>`
      : emptyState(t('buy.no_lines'), t('buy.no_lines_sub'), 'package');

  root.innerHTML = `
    <form id="purchase-form" class="card form-page">
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" data-cancel
                aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(editing ? t('buy.edit_title', { doc: editing.doc_no }) : t('buy.title'))}</h3>
          <div class="sub">${esc(editing ? t('buy.edit_sub') : t('buy.sub'))}</div></div>
      </div>
      <div class="card-body">
        <div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="field"><label>${esc(t('common.supplier'))}</label>
            <input class="input" name="supplier" list="supplier-names" placeholder="${esc(
              t('buy.supplier_placeholder'),
            )}" value="${esc(editing?.supplier || '')}" autocomplete="off"/>
            <datalist id="supplier-names">${supplierNames
              .map((n) => `<option value="${esc(n)}"></option>`)
              .join('')}</datalist></div>
          <div class="field"><label>${esc(t('common.date'))}</label>
            <input class="input" type="date" name="date" value="${editing?.date || todayISO()}"/></div>
          <div class="field"><label>${esc(t('buy.ref'))}</label>
            <input class="input" name="note" placeholder="${esc(t('buy.ref_placeholder'))}" value="${esc(
              editing?.note || '',
            )}" autocomplete="off"/></div>
          ${
            editing
              ? `<div class="field" style="grid-column:1/-1"><label>${esc(t('buy.reason'))}</label>
                  <input class="input" name="reason" placeholder="${esc(t('buy.reason_placeholder'))}" autocomplete="off"/></div>`
              : ''
          }
        </div>
      </div>
      <div class="card-head" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div><h3>${esc(t('buy.items'))}</h3></div><div class="spacer"></div>
        <button type="button" class="btn btn-sm" id="add-line">${icon('plus')} ${esc(t('buy.add_line'))}</button>
      </div>
      <div class="table-wrap" id="lines">${linesHtml()}</div>
      <div class="card-head form-actions">
        <div class="spacer"></div>
        <button type="button" class="btn" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="save-purchase">${icon('check')} ${esc(editing ? t('buy.save_changes') : t('buy.save'))}</button>
      </div>
    </form>`;

  const form = root.querySelector('#purchase-form');
  const linesEl = root.querySelector('#lines');

  // The line table is re-rendered on every add, remove and pick, so the pickers
  // attached to the old rows must be torn down or their menus leak.
  let pickers = [];
  const dropPickers = () => {
    pickers.forEach((p) => p.destroy());
    pickers = [];
  };

  const redraw = () => {
    dropPickers();
    linesEl.innerHTML = linesHtml();
    wire();
  };

  // Cheap in-place total refresh so typing does not steal focus.
  const updateTotals = () => {
    lines.forEach((l, i) => {
      const cell = linesEl.querySelector(`tbody tr:nth-child(${i + 1}) td:nth-child(4) b`);
      if (cell) cell.textContent = money(l.qty * l.unit_cost);
    });
    const foot = linesEl.querySelector('tfoot td.right');
    if (foot) foot.textContent = money(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
  };

  const wire = () => {
    linesEl.querySelectorAll('[data-product]').forEach((input) => {
      const line = lines[+input.dataset.product];
      pickers.push(
        attachPicker(input, {
          search: (q) => api.products({ search: q, limit: 25 }),
          render: productOption,
          emptyText: t('buy.no_product_match'),
          onPick: (p) => {
            line.product_id = p.id;
            line.name = p.name;
            line.barcode = p.barcode || '';
            // Default to what it last cost, unless the buyer already typed a price.
            if (!line.touchedCost) line.unit_cost = Number(p.cost) || 0;
            redraw();
            // Keep the flow moving: land on the quantity for the line just filled.
            linesEl.querySelector(`[data-qty="${input.dataset.product}"]`)?.focus();
          },
        }),
      );
    });
    linesEl.querySelectorAll('[data-qty]').forEach((input) =>
      input.addEventListener('input', () => {
        lines[+input.dataset.qty].qty = Number(input.value) || 0;
        updateTotals();
      }),
    );
    linesEl.querySelectorAll('[data-cost]').forEach((input) =>
      input.addEventListener('input', () => {
        const line = lines[+input.dataset.cost];
        line.unit_cost = Number(input.value) || 0;
        line.touchedCost = true;
        updateTotals();
      }),
    );
    linesEl.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        lines.splice(+btn.dataset.remove, 1);
        redraw();
      }),
    );
  };

  root.querySelector('#add-line').addEventListener('click', () => {
    lines.push({ product_id: 0, name: '', barcode: '', qty: 1, unit_cost: 0, touchedCost: false });
    redraw();
    // Focus the new line's search box so you can just start typing.
    linesEl.querySelector(`[data-product="${lines.length - 1}"]`)?.focus();
  });

  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', back));

  root.querySelector('#save-purchase').addEventListener('click', async () => {
    const valid = lines.filter((l) => l.product_id && l.qty > 0);
    if (!valid.length) return toast(t('buy.need_line'), 'warn');
    const payload = {
      supplier: form.supplier.value.trim(),
      date: form.date.value,
      note: form.note.value.trim(),
      items: valid.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost })),
    };
    try {
      if (editing) {
        const saved = await api.updatePurchase(editing.id, { ...payload, reason: form.reason.value.trim() });
        toast(t('buy.updated', { doc: saved.doc_no, v: money(saved.total) }), 'success');
        if (saved.supplier) forgetSuggestions('supplier');
        return back();
      }
      const saved = await api.createPurchase(payload);
      toast(t('buy.saved', { doc: saved.doc_no, v: money(saved.total) }), 'success');
      if (saved.supplier) forgetSuggestions('supplier');
      back();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  // A new purchase starts with one empty line so the form is immediately usable.
  if (editing) wire();
  else root.querySelector('#add-line').click();

  // main.js calls this when navigating away.
  return dropPickers;
}
