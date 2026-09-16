import { api } from '../api.js';
import { attachPicker } from '../picker.js';
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
  money,
  pager,
  qtyText,
  rangeBar,
  toast,
  todayISO,
} from '../ui.js';

/** #/openings, #/openings/new, #/openings/<id> */
export async function render(root, ctx) {
  if (ctx.params[0] === 'new') return renderForm(root, ctx);
  if (/^\d+$/.test(ctx.params[0] || '')) return renderDoc(root, ctx, Number(ctx.params[0]));
  return renderList(root, ctx);
}

/* ------------------------------------------------------------------ list -- */

async function renderList(root, ctx) {
  const state = { from: '2000-01-01', to: todayISO(), search: '', page: 1, per: 50 };
  let rows = [];

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('opn.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('openings/new'));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-opening-stock.csv`,
      rows.map((o) => ({ doc_no: o.doc_no, date: o.date, lines: o.line_count, quantity: o.total_qty, value: o.value, note: o.note })),
    ),
  );

  // Opening stock is rare and often old: the list starts with everything.
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
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('opn.search'))}"/>`;
  searchWrap.querySelector('input').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      refilter();
    }, 250),
  );
  bar.appendChild(searchWrap);

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('common.loading'))}</p></div></div></div>`;
    const result = await api.openings({ ...state });
    rows = result.rows;
    const pageValue = rows.reduce((s, o) => s + o.value, 0);

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(count('opn', result.total))}</h3>
            <div class="sub">${esc(t('opn.list_sub'))}</div></div>
          <div class="spacer"></div>
          <span class="badge accent">${esc(t('opn.value_badge', { v: money(result.sums.value) }))}</span>
        </div>
        <div class="card-body flush">${
          rows.length
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('buy.document'))}</th><th>${esc(t('common.date'))}</th>
                  <th class="right">${esc(t('common.lines'))}</th><th class="right">${esc(t('common.quantity'))}</th>
                  <th class="right">${esc(t('adj.value'))}</th><th>${esc(t('common.note'))}</th><th>${esc(t('common.user'))}</th></tr></thead>
                <tbody>${rows
                  .map(
                    (o) => `<tr class="row-click" data-open="${o.id}">
                      <td class="mono nowrap">${esc(o.doc_no)}</td>
                      <td class="nowrap">${dateText(o.date)}</td>
                      <td class="right">${o.line_count}</td>
                      <td class="right">${qtyText(o.total_qty)}</td>
                      <td class="right"><b>${money(o.value)}</b></td>
                      <td class="muted">${esc(o.note || '')}</td>
                      <td class="muted">${esc(o.username || t('common.none'))}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr><td colspan="4">${esc(t('page.page_total'))}</td>
                  <td class="right">${money(pageValue)}</td><td colspan="2"></td></tr></tfoot>
              </table></div>`
            : emptyState(t('opn.none'), t('opn.none_sub'), 'package')
        }</div>
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
      tr.addEventListener('click', () => ctx.navigate(`openings/${tr.dataset.open}`)),
    );
  }

  await load();
}

/* -------------------------------------------------------------- document -- */

async function renderDoc(root, ctx, id) {
  const back = () => ctx.navigate('openings');
  let o;
  try {
    o = await api.opening(id);
  } catch (err) {
    toast(errorText(err), 'error');
    return back();
  }
  const body = docPage(root, {
    title: t('opn.view_title', { doc: o.doc_no }),
    subtitle: [dateText(o.date), o.full_name || o.username].filter(Boolean).join(' · '),
    badges: `<span class="badge accent">${esc(t('opn.value_badge', { v: money(o.value) }))}</span>`,
    actions: `<button class="btn" data-print>${icon('print')} ${esc(t('common.print'))}</button>
              <button class="btn btn-ghost" data-del title="${esc(t('common.delete'))}">${icon('trash')}</button>`,
    onBack: back,
  });
  body.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>${esc(t('opn.lines_title'))}</h3>
        <div class="sub">${esc(t('opn.lines_sub', { n: o.items.length, q: qtyText(o.total_qty) }))}</div></div></div>
      <div class="card-body flush">
        <div class="table-wrap table-scroll"><table class="data">
          <thead><tr><th>${esc(t('nav.products'))}</th><th class="right">${esc(t('common.quantity'))}</th>
            <th class="right">${esc(t('buy.unit_cost'))}</th><th class="right">${esc(t('adj.value'))}</th></tr></thead>
          <tbody>${o.items
            .map(
              (i) => `<tr class="row-click" data-product="${i.product_id}">
                <td><div class="cell-title">${esc(i.name)}</div><div class="cell-sub mono">${esc(i.barcode || '')}</div></td>
                <td class="right">${qtyText(i.qty)} ${esc(i.unit)}</td>
                <td class="right">${money(i.unit_cost)}</td>
                <td class="right"><b>${money(i.value)}</b></td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td>${esc(t('common.total'))}</td><td class="right">${qtyText(o.total_qty)}</td><td></td>
            <td class="right">${money(o.value)}</td></tr></tfoot>
        </table></div>
      </div>
      ${o.note ? `<div class="card-body doc-note">${esc(o.note)}</div>` : ''}
    </div>`;

  body.querySelectorAll('[data-product]').forEach((tr) =>
    tr.addEventListener('click', () => ctx.navigate(`products/${tr.dataset.product}`)),
  );
  root.querySelector('[data-print]').addEventListener('click', () => window.print());
  root.querySelector('[data-del]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('opn.delete_title'),
      message: t('opn.delete_msg'),
      confirmLabel: t('opn.delete_confirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteOpening(o.id);
      toast(t('opn.deleted'), 'success');
      back();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

/* ---------------------------------------------------------------- builder -- */

async function renderForm(root, ctx) {
  const back = () => ctx.navigate('openings');
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
      const saved = await api.createOpening({
        date: root.querySelector('#opn-date').value,
        note: root.querySelector('#opn-note').value.trim(),
        items,
      });
      toast(t('opn.saved', { doc: saved.doc_no, n: saved.items.length }), 'success');
      ctx.navigate(`openings/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  draw();
  find.focus();
  return () => picker.destroy();
}
