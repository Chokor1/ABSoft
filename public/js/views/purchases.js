import { api } from '../api.js';
import { icon } from '../icons.js';
import { count, errorText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
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

export async function render(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '' };
  let rows = [];

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('buy.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => newPurchase(load));
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
              ? `<div class="table-wrap"><table class="data">
                  <thead><tr><th>${esc(t('buy.document'))}</th><th>${esc(t('common.date'))}</th>
                    <th>${esc(t('common.supplier'))}</th><th class="right">${esc(t('common.lines'))}</th>
                    <th class="right">${esc(t('common.quantity'))}</th><th class="right">${esc(t('common.total'))}</th>
                    <th>${esc(t('common.note'))}</th><th>${esc(t('common.user'))}</th><th></th></tr></thead>
                  <tbody>${rows
                    .map(
                      (p) => `<tr class="row-click" data-open="${p.id}">
                        <td class="mono">${esc(p.doc_no)}</td>
                        <td class="nowrap">${dateText(p.date)}</td>
                        <td>${esc(p.supplier || t('common.none'))}</td>
                        <td class="right">${p.line_count}</td>
                        <td class="right">${qtyText(p.total_qty)}</td>
                        <td class="right"><b>${money(p.total)}</b></td>
                        <td class="muted">${esc(p.note || '')}</td>
                        <td class="muted">${esc(p.username || t('common.none'))}</td>
                        <td class="right">${
                          store.user.role === 'admin'
                            ? `<button class="btn btn-sm btn-ghost" data-del="${p.id}" title="${esc(
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
        showPurchase(await api.purchase(tr.dataset.open));
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

function showPurchase(p) {
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
      ${p.note ? `<p class="muted" style="padding:12px 2px">${esc(p.note)}</p>` : ''}`,
    footer: `<button class="btn" data-close>${esc(t('common.close'))}</button>`,
  });
}

/** Multi-line stock-in document builder. */
export async function newPurchase(onSaved) {
  const products = await api.products({});
  if (!products.length) return toast(t('buy.need_product'), 'warn');
  const supplierNames = await suggestions('supplier');

  const lines = [];

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
                  <select class="select" data-product="${i}">
                    ${products
                      .map(
                        (p) =>
                          `<option value="${p.id}" ${p.id === l.product_id ? 'selected' : ''}>${esc(p.name)}${
                            p.barcode ? ` · ${esc(p.barcode)}` : ''
                          }</option>`,
                      )
                      .join('')}
                  </select>
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

  await modal({
    title: t('buy.title'),
    subtitle: t('buy.sub'),
    wide: true,
    body: `
      <form id="purchase-form">
        <div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:16px">
          <div class="field"><label>${esc(t('common.supplier'))}</label>
            <input class="input" name="supplier" list="supplier-names" placeholder="${esc(
              t('buy.supplier_placeholder'),
            )}" autocomplete="off"/>
            <datalist id="supplier-names">${supplierNames
              .map((n) => `<option value="${esc(n)}"></option>`)
              .join('')}</datalist></div>
          <div class="field"><label>${esc(t('common.date'))}</label>
            <input class="input" type="date" name="date" value="${todayISO()}"/></div>
          <div class="field"><label>${esc(t('buy.ref'))}</label>
            <input class="input" name="note" placeholder="${esc(t('buy.ref_placeholder'))}" autocomplete="off"/></div>
        </div>
        <div class="card"><div class="card-head">
            <div><h3>${esc(t('buy.items'))}</h3></div><div class="spacer"></div>
            <button type="button" class="btn btn-sm" id="add-line">${icon('plus')} ${esc(t('buy.add_line'))}</button>
          </div>
          <div class="card-body flush"><div class="table-wrap" id="lines">${linesHtml()}</div></div>
        </div>
      </form>`,
    footer: `<button class="btn" data-close>${esc(t('common.cancel'))}</button>
             <button class="btn btn-primary" id="save-purchase">${icon('check')} ${esc(t('buy.save'))}</button>`,
    setup: (rootEl, close) => {
      const linesEl = rootEl.querySelector('#lines');

      const redraw = () => {
        linesEl.innerHTML = linesHtml();
        wire();
      };

      const wire = () => {
        linesEl.querySelectorAll('[data-product]').forEach((sel) =>
          sel.addEventListener('change', () => {
            const line = lines[+sel.dataset.product];
            line.product_id = Number(sel.value);
            const product = products.find((p) => p.id === line.product_id);
            if (product && !line.touchedCost) line.unit_cost = Number(product.cost) || 0;
            redraw();
          }),
        );
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

      // Cheap in-place total refresh so typing does not steal focus.
      const updateTotals = () => {
        lines.forEach((l, i) => {
          const cell = linesEl.querySelector(`tbody tr:nth-child(${i + 1}) td:nth-child(4) b`);
          if (cell) cell.textContent = money(l.qty * l.unit_cost);
        });
        const foot = linesEl.querySelector('tfoot td.right');
        if (foot) foot.textContent = money(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
      };

      rootEl.querySelector('#add-line').addEventListener('click', () => {
        const first = products[0];
        lines.push({ product_id: first.id, qty: 1, unit_cost: Number(first.cost) || 0, touchedCost: false });
        redraw();
      });

      rootEl.querySelector('#save-purchase').addEventListener('click', async () => {
        const form = rootEl.querySelector('#purchase-form');
        const valid = lines.filter((l) => l.qty > 0);
        if (!valid.length) return toast(t('buy.need_line'), 'warn');
        try {
          const saved = await api.createPurchase({
            supplier: form.supplier.value.trim(),
            date: form.date.value,
            note: form.note.value.trim(),
            items: valid.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost })),
          });
          toast(t('buy.saved', { doc: saved.doc_no, v: money(saved.total) }), 'success');
          if (saved.supplier) forgetSuggestions('supplier');
          close(true);
          onSaved?.();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      });

      // Start with one empty line so the form is immediately usable.
      rootEl.querySelector('#add-line').click();
    },
  });
}
