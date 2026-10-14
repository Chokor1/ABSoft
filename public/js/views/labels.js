import { api } from '../api.js';
import { barcodeSvg, barcodeText } from '../barcode.js';
import { icon } from '../icons.js';
import { errorText, t } from '../i18n.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
import { emptyState, esc, money, qtyText, store, toast } from '../ui.js';

/**
 * Barcode labels for a label printer (an Xprinter and its kin): pick the
 * products, say how many of each, and print a sheet of labels drawn at exactly
 * the size of the roll — 40 × 20 mm by default.
 *
 * The barcode itself is drawn in the browser, so nothing has to be installed and
 * the printer only ever sees a page.
 */

const KEY = 'absoft-labels';
const DEFAULTS = { width: 40, height: 20, name: true, price: false, list: '' };

/** The label size and what goes on it, as this device last left them. */
function savedSetup() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const remember = (setup) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(setup));
  } catch {
    /* storage blocked: this device just forgets */
  }
};

/** #/labels, or #/labels/<product id> to start with one product on the sheet. */
export async function render(root, ctx) {
  const setup = savedSetup();
  // Every row is a product and how many labels of it to print.
  const rows = [];
  const lists = await api.priceLists({ use: 'sell' }).catch(() => []);
  if (!lists.some((l) => String(l.id) === String(setup.list))) setup.list = '';

  ctx.actions.innerHTML = `
    <button class="btn" id="labels-clear">${icon('trash')} ${esc(t('label.clear'))}</button>
    <button class="btn btn-primary" id="labels-print">${icon('print')} ${esc(t('label.print'))}</button>`;

  root.innerHTML = `
    <div class="toolbar sticky-bar labels-bar">
      <div class="combo input-icon labels-find">${icon('search')}
        <input class="input" id="label-find" placeholder="${esc(t('label.find'))}" autocomplete="off"/>
      </div>
      <label class="filter-select"><span>${esc(t('label.width'))}</span>
        <input class="input" id="label-w" type="number" min="10" max="120" step="1" value="${setup.width}"/></label>
      <label class="filter-select"><span>${esc(t('label.height'))}</span>
        <input class="input" id="label-h" type="number" min="10" max="120" step="1" value="${setup.height}"/></label>
      <label class="check"><input type="checkbox" id="label-name" ${setup.name ? 'checked' : ''}/> ${esc(t('label.show_name'))}</label>
      <label class="check"><input type="checkbox" id="label-price" ${setup.price ? 'checked' : ''}/> ${esc(t('label.show_price'))}</label>
      ${
        lists.length > 1
          ? `<label class="filter-select"><span>${esc(t('price.list'))}</span>
              <select class="select" id="label-list">${lists
                .map(
                  (l) => `<option value="${l.is_default ? '' : l.id}" ${
                    String(l.is_default ? '' : l.id) === String(setup.list) ? 'selected' : ''
                  }>${esc(l.name)}</option>`,
                )
                .join('')}</select></label>`
          : ''
      }
    </div>
    <div class="labels-top">
      <div id="label-rows"></div>
      <div class="card label-preview-card">
        <div class="card-head"><div><h3>${esc(t('label.preview'))}</h3>
          <div class="sub" id="label-size-note"></div></div></div>
        <div class="card-body"><div class="label-preview" id="label-preview"></div></div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const rowsEl = $('#label-rows');
  // The sheet the printer sees lives outside the app, so printing it does not
  // have to print the screen around it.
  const sheet = document.createElement('div');
  sheet.className = 'labels-sheet';
  sheet.id = 'labels-sheet';
  document.body.appendChild(sheet);
  // The page size a label printer is given: the roll, exactly, with no margin.
  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);

  const readSetup = () => ({
    width: Math.min(120, Math.max(10, Number($('#label-w').value) || 40)),
    height: Math.min(120, Math.max(10, Number($('#label-h').value) || 20)),
    name: $('#label-name').checked,
    price: $('#label-price').checked,
    list: $('#label-list')?.value || '',
  });

  function paintSheet() {
    const now = readSetup();
    remember(now);
    pageStyle.textContent = `@media print { @page { size: ${now.width}mm ${now.height}mm; margin: 0; } }`;
    sheet.style.setProperty('--label-w', `${now.width}mm`);
    sheet.style.setProperty('--label-h', `${now.height}mm`);
    // The bars take everything the words leave behind: the name needs about
    // 4.2 mm with its gap, the row of digits and the price about 3.9 mm, and the
    // label keeps 2.6 mm of padding. Whatever is left is bar height, so a taller
    // roll prints taller bars.
    const barWidth = Math.max(10, now.width - 4);
    const barHeight = Math.max(5, now.height - (now.name ? 4.2 : 0) - 4 - 2.5);
    const label = (row) => {
      const code = row.product.barcode || '';
      return `<div class="label">
        ${now.name ? `<div class="label-name">${esc(row.product.name)}</div>` : ''}
        <div class="label-bars">${
          code
            ? barcodeSvg(code, { width: barWidth, height: barHeight })
            : `<span class="label-nocode">${esc(t('label.no_code'))}</span>`
        }</div>
        <div class="label-foot">
          <span class="label-code">${esc(barcodeText(code))}</span>
          ${now.price ? `<span class="label-price">${money(row.price)}</span>` : ''}
        </div>
      </div>`;
    };
    sheet.style.setProperty('--label-w', `${now.width}mm`);
    sheet.style.setProperty('--label-h', `${now.height}mm`);
    sheet.innerHTML = rows
      .flatMap((row) => Array.from({ length: Math.max(1, Math.min(200, row.copies)) }, () => label(row)))
      .join('');

    // What one label will look like, at its real size.
    const preview = $('#label-preview');
    preview.style.setProperty('--label-w', `${now.width}mm`);
    preview.style.setProperty('--label-h', `${now.height}mm`);
    preview.innerHTML = rows.length
      ? label(rows[0])
      : `<div class="label label-empty"><span class="label-nocode">${esc(t('label.preview_empty'))}</span></div>`;
    $('#label-size-note').textContent = t('label.size_note', { w: now.width, h: now.height });
  }

  function paintRows() {
    if (!rows.length) {
      rowsEl.innerHTML = `<div class="card"><div class="card-body">${emptyState(
        t('label.none'),
        t('label.none_sub'),
        'barcode',
      )}</div></div>`;
      paintSheet();
      return;
    }
    rowsEl.innerHTML = `
      <div class="card"><div class="card-body flush">
        <div class="table-wrap"><table class="data" id="label-table">
          <thead><tr><th>${esc(t('nav.products'))}</th><th>${esc(t('prod.barcodes'))}</th>
            <th class="right">${esc(t('common.price'))}</th><th class="right">${esc(t('label.copies'))}</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (row, i) => `<tr data-row="${i}">
                <td><div class="cell-title">${esc(row.product.name)}</div>
                  <div class="cell-sub">${esc(row.product.category || '')}</div></td>
                <td>${
                  row.product.barcode
                    ? `<span class="mono">${esc(row.product.barcode)}</span>`
                    : `<button class="btn btn-sm" data-make>${icon('barcode')} ${esc(t('label.generate'))}</button>`
                }</td>
                <td class="right">${money(row.price)}</td>
                <td class="right"><input class="input label-copies" type="number" min="1" max="200" step="1"
                  value="${row.copies}" data-copies aria-label="${esc(t('label.copies'))}"/></td>
                <td class="right"><button class="btn btn-ghost btn-icon btn-sm" data-drop
                  title="${esc(t('common.remove'))}">${icon('trash')}</button></td>
              </tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="3">${esc(t('label.total_labels'))}</td>
            <td class="right"><b>${qtyText(rows.reduce((n, r) => n + Math.max(1, r.copies), 0))}</b></td><td></td></tr></tfoot>
        </table></div>
      </div></div>`;

    rowsEl.querySelectorAll('[data-copies]').forEach((input) =>
      input.addEventListener('input', () => {
        rows[Number(input.closest('[data-row]').dataset.row)].copies = Math.max(1, Math.min(200, Number(input.value) || 1));
        paintSheet();
      }),
    );
    rowsEl.querySelectorAll('[data-drop]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rows.splice(Number(btn.closest('[data-row]').dataset.row), 1);
        paintRows();
      }),
    );
    rowsEl.querySelectorAll('[data-make]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const row = rows[Number(btn.closest('[data-row]').dataset.row)];
        btn.disabled = true;
        try {
          row.product = await api.generateBarcode(row.product.id);
          toast(t('label.generated', { code: row.product.barcode }), 'success');
          paintRows();
        } catch (err) {
          toast(errorText(err), 'error');
          btn.disabled = false;
        }
      }),
    );
    paintSheet();
  }

  /** What this product costs on the chosen list, or its own price. */
  const priceOf = (p) => (p.list_price === null || p.list_price === undefined ? Number(p.price) || 0 : Number(p.list_price));

  function addProduct(product) {
    const existing = rows.find((r) => r.product.id === product.id);
    if (existing) existing.copies += 1;
    else rows.push({ product, price: priceOf(product), copies: 1 });
    paintRows();
  }

  const find = $('#label-find');
  const picker = attachPicker(find, {
    search: (q) => api.products({ search: q, limit: 25, price_list: $('#label-list')?.value || '' }),
    render: productOption,
    emptyText: t('buy.no_product_match'),
    onPick: (p) => {
      addProduct(p);
      find.value = '';
      find.focus();
    },
  });

  $('#label-w').addEventListener('input', paintSheet);
  $('#label-h').addEventListener('input', paintSheet);
  $('#label-name').addEventListener('change', paintSheet);
  $('#label-price').addEventListener('change', paintSheet);
  // A different list re-prices every row that has not been printed yet.
  $('#label-list')?.addEventListener('change', async () => {
    if (!rows.length) return paintSheet();
    const fresh = await api
      .products({ ids: rows.map((r) => r.product.id).join(','), price_list: $('#label-list').value || '' })
      .catch(() => []);
    const byId = new Map(fresh.map((p) => [p.id, p]));
    for (const row of rows) {
      const p = byId.get(row.product.id);
      if (p) row.price = priceOf(p);
    }
    paintRows();
  });
  ctx.actions.querySelector('#labels-clear').addEventListener('click', () => {
    rows.length = 0;
    paintRows();
  });
  ctx.actions.querySelector('#labels-print').addEventListener('click', () => {
    if (!rows.length) return toast(t('label.none'), 'warn');
    if (rows.some((r) => !r.product.barcode)) return toast(t('label.need_codes'), 'warn');
    window.print();
  });

  // Opened from a product's page: that product is already on the sheet.
  if (ctx.params[0] && /^\d+$/.test(ctx.params[0])) {
    try {
      const p = await api.product(ctx.params[0]);
      addProduct(p);
    } catch {
      paintRows();
    }
  } else {
    paintRows();
  }
  find.focus();

  // main.js calls this when leaving the screen.
  return () => {
    picker?.destroy?.();
    pageStyle.remove();
    sheet.remove();
  };
}
