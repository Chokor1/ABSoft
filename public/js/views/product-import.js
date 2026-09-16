import { api } from '../api.js';
import { parseCsv, toCsv } from '../csv.js';
import { icon } from '../icons.js';
import { errorText, t } from '../i18n.js';
import { emptyState, esc, forgetSuggestions, money, number, qtyText, toast, todayISO } from '../ui.js';

/** The columns of the template, in order. The header row uses these names. */
export const IMPORT_COLUMNS = ['name', 'description', 'barcode', 'category', 'unit', 'cost', 'price', 'min_stock', 'opening_stock'];

// Headings people are likely to type instead, in English or Arabic.
const ALIASES = {
  name: ['product', 'product name', 'item', 'الاسم', 'اسم المنتج', 'المنتج'],
  description: ['details', 'الوصف'],
  barcode: ['code', 'sku', 'الباركود', 'الرمز'],
  category: ['group', 'الفئة', 'المجموعة'],
  unit: ['الوحدة'],
  cost: ['cost price', 'unit cost', 'التكلفة', 'سعر التكلفة'],
  price: ['selling price', 'sale price', 'السعر', 'سعر البيع'],
  min_stock: ['min stock', 'minimum', 'reorder', 'low stock', 'حد الطلب', 'الحد الأدنى'],
  opening_stock: ['opening stock', 'opening', 'stock', 'qty', 'quantity', 'الرصيد الافتتاحي', 'الكمية', 'المخزون'],
};

const columnFor = (heading) => {
  const h = String(heading || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const key = h.replace(/ /g, '_');
  if (IMPORT_COLUMNS.includes(key)) return key;
  return IMPORT_COLUMNS.find((c) => ALIASES[c].includes(h)) || null;
};

function downloadTemplate() {
  const csv = toCsv([
    IMPORT_COLUMNS,
    ['Bottled Water 500ml', 'Still water', '5449000000996', 'Drinks', 'pcs', '0.25', '1.00', '24', '120'],
    ['قهوة عربية 250 غ', 'Arabic coffee with cardamom', '6221155000017', 'Coffee', 'pack', '3.40', '5.50', '5', '30'],
  ]);
  // A byte-order mark so Excel opens Arabic names correctly.
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'absoft-products-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** #/products/import */
export async function renderImport(root, ctx) {
  const state = { fileName: '', rows: [], check: null };

  ctx.actions.innerHTML = `<button class="btn" id="template">${icon('download')} ${esc(t('imp.template'))}</button>`;
  ctx.actions.querySelector('#template').addEventListener('click', downloadTemplate);

  root.innerHTML = `
    <div class="card form-page imp-card">
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" id="imp-back" aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(t('imp.title'))}</h3><div class="sub">${esc(t('imp.sub'))}</div></div>
      </div>
      <div class="card-body imp-steps">
        <ol class="imp-how">
          <li><b>${esc(t('imp.step1'))}</b> <button type="button" class="btn btn-sm" id="template2">${icon('download')} ${esc(t('imp.template'))}</button></li>
          <li><b>${esc(t('imp.step2'))}</b> <span class="muted">${esc(t('imp.step2_help'))}</span></li>
          <li><b>${esc(t('imp.step3'))}</b></li>
        </ol>
        <label class="imp-drop" id="imp-drop">
          <input type="file" id="imp-file" accept=".csv,text/csv" hidden/>
          ${icon('download')}
          <span class="imp-drop-title">${esc(t('imp.drop'))}</span>
          <span class="muted" id="imp-file-name">${esc(t('imp.drop_help'))}</span>
        </label>
      </div>
    </div>
    <div id="imp-result"></div>`;

  root.querySelector('#imp-back').addEventListener('click', () => ctx.navigate('products'));
  root.querySelector('#template2').addEventListener('click', downloadTemplate);
  const result = root.querySelector('#imp-result');
  const drop = root.querySelector('#imp-drop');
  const fileInput = root.querySelector('#imp-file');

  async function readFile(file) {
    if (!file) return;
    state.fileName = file.name;
    root.querySelector('#imp-file-name').textContent = file.name;
    let table;
    try {
      table = parseCsv(await file.text());
    } catch {
      return toast(t('imp.unreadable'), 'error');
    }
    if (table.length < 2) return toast(t('imp.no_rows'), 'warn');

    const columns = table[0].map(columnFor);
    if (!columns.includes('name')) return toast(t('imp.no_name_column'), 'error');
    state.rows = table.slice(1).map((cells) => {
      const row = {};
      columns.forEach((c, i) => {
        if (c) row[c] = (cells[i] ?? '').trim();
      });
      return row;
    });
    await check();
  }

  async function check() {
    result.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('imp.checking'))}</p></div></div></div>`;
    try {
      state.check = await api.importProducts({ rows: state.rows, dry_run: true });
    } catch (err) {
      result.innerHTML = '';
      return toast(errorText(err), 'error');
    }
    paintPreview();
  }

  const reasonText = (r) =>
    r.code === 'IMPORT_DUP_FILE'
      ? t('imp.err.IMPORT_DUP_FILE', { line: r.other })
      : t(`imp.err.${r.code}`, { field: t(`imp.col.${r.field}`) });

  function paintPreview(done = null) {
    const c = state.check;
    const s = c.summary;
    const sourceRows = state.rows;
    result.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(done ? t('imp.done_title') : t('imp.preview_title'))}</h3>
            <div class="sub">${esc(state.fileName)}</div></div>
          <div class="spacer"></div>
          <span class="badge success">${esc(t(done ? 'imp.created_n' : 'imp.ready_n', { n: s.ok }))}</span>
          ${s.skip ? `<span class="badge warn">${esc(t('imp.skip_n', { n: s.skip }))}</span>` : ''}
          ${s.error ? `<span class="badge danger">${esc(t('imp.error_n', { n: s.error }))}</span>` : ''}
        </div>
        ${
          done
            ? `<div class="card-body imp-done">
                ${icon('check')}
                <div>
                  <b>${esc(t('imp.done_msg', { n: s.ok }))}</b>
                  <div class="muted">${
                    done.opening
                      ? esc(t('imp.done_opening', { doc: done.opening.doc_no, n: s.opening_lines, q: qtyText(s.opening_qty) }))
                      : esc(t('imp.done_no_opening'))
                  }</div>
                </div>
                <div class="spacer"></div>
                ${done.opening ? `<button class="btn" id="imp-open-doc">${icon('package')} ${esc(done.opening.doc_no)}</button>` : ''}
                <button class="btn btn-primary" id="imp-to-products">${esc(t('imp.to_products'))}</button>
              </div>`
            : `<div class="card-body imp-options">
                <div class="muted imp-opening-note">${
                  s.opening_lines
                    ? esc(t('imp.opening_note', { n: s.opening_lines, q: qtyText(s.opening_qty) }))
                    : esc(t('imp.no_opening_note'))
                }</div>
                ${
                  s.opening_lines
                    ? `<label class="field-inline"><span>${esc(t('common.date'))}</span>
                         <input class="input" type="date" id="imp-date" value="${todayISO()}"/></label>
                       <label class="field-inline"><span>${esc(t('common.note'))}</span>
                         <input class="input" id="imp-note" value="${esc(t('imp.default_note', { file: state.fileName }))}"/></label>`
                    : ''
                }
                <div class="spacer"></div>
                <button class="btn btn-primary" id="imp-go" ${s.ok ? '' : 'disabled'}>${icon('check')} ${esc(t('imp.import_n', { n: s.ok }))}</button>
              </div>`
        }
        <div class="card-body flush">${
          c.rows.length
            ? `<div class="table-wrap table-scroll"><table class="data imp-table">
                <thead><tr>
                  <th class="right">${esc(t('imp.line'))}</th><th>${esc(t('imp.status'))}</th>
                  <th>${esc(t('imp.col.name'))}</th><th>${esc(t('imp.col.barcode'))}</th><th>${esc(t('imp.col.category'))}</th>
                  <th>${esc(t('imp.col.unit'))}</th><th class="right">${esc(t('imp.col.cost'))}</th>
                  <th class="right">${esc(t('imp.col.price'))}</th><th class="right">${esc(t('imp.col.opening_stock'))}</th>
                </tr></thead>
                <tbody>${c.rows
                  .map((r, i) => {
                    const src = sourceRows[i] || {};
                    const badge =
                      r.status === 'ok'
                        ? `<span class="badge success">${esc(t(done ? 'imp.created' : 'imp.ready'))}</span>`
                        : r.status === 'skip'
                          ? `<span class="badge warn" title="${esc(reasonText(r))}">${esc(t('imp.skipped'))}</span>`
                          : `<span class="badge danger">${esc(t('imp.error'))}</span>`;
                    return `<tr class="imp-${r.status}">
                      <td class="right muted">${r.line}</td>
                      <td>${badge}${r.status !== 'ok' ? `<div class="cell-sub">${esc(reasonText(r))}</div>` : ''}</td>
                      <td><div class="cell-title">${esc(src.name || '')}</div><div class="cell-sub">${esc(src.description || '')}</div></td>
                      <td class="mono">${esc(src.barcode || '')}</td>
                      <td>${esc(src.category || '')}</td>
                      <td>${esc(src.unit || 'pcs')}</td>
                      <td class="right">${src.cost ? money(Number(String(src.cost).replace(',', '.')) || 0) : ''}</td>
                      <td class="right">${src.price ? money(Number(String(src.price).replace(',', '.')) || 0) : ''}</td>
                      <td class="right">${r.opening ? `<b>${number(r.opening, 3)}</b>` : ''}</td>
                    </tr>`;
                  })
                  .join('')}</tbody>
              </table></div>`
            : emptyState(t('imp.no_rows'), '', 'box')
        }</div>
      </div>`;

    result.querySelector('#imp-go')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const saved = await api.importProducts({
          rows: state.rows,
          date: result.querySelector('#imp-date')?.value,
          note: result.querySelector('#imp-note')?.value.trim(),
        });
        state.check = saved;
        forgetSuggestions('category');
        forgetSuggestions('unit');
        toast(t('imp.done_msg', { n: saved.summary.ok }), 'success');
        paintPreview(saved);
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
      }
    });
    result.querySelector('#imp-open-doc')?.addEventListener('click', () => ctx.navigate(`openings/${done.opening.id}`));
    result.querySelector('#imp-to-products')?.addEventListener('click', () => ctx.navigate('products'));
  }

  fileInput.addEventListener('change', () => readFile(fileInput.files?.[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    readFile(e.dataTransfer.files?.[0]);
  });
}
