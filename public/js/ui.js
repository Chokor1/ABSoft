import { api } from './api.js';
import { icon } from './icons.js';
import { isRtl, locale, t } from './i18n.js';
import { niceTicks, stepDecimals } from './chart-scale.js';
import { wireNamePickers } from './name-picker.js';
import { sweepPickers } from './picker.js';

/* ------------------------------------------------------------ formatting -- */

export const store = {
  user: null,
  settings: { currency: '$', store_name: 'ABSoft Store', tax_rate: '0', receipt_footer: '' },
  // How people pay, as the shop keeps it (Cash, On account, Whish, OMT…).
  methods: [],
};

/** The icons a payment method can wear, offered when one is added. */
export const METHOD_ICONS = ['coins', 'card', 'transfer', 'phone', 'wallet', 'bank', 'receipt', 'globe', 'gift', 'star', 'whish', 'omt'];

/** A method's icon: an uploaded logo when there is one, otherwise a drawn icon. */
export const methodMark = (glyph) =>
  String(glyph || '').startsWith('data:image/')
    ? `<img class="method-logo" src="${esc(glyph)}" alt="" />`
    : icon(glyph || 'coins');

/** The ways to pay that are switched on, in the shop's own order. */
export const paymentMethods = () => store.methods.filter((m) => m.active);

/** The icon a method wears; anything unknown falls back to plain money. */
export const methodIcon = (name) =>
  store.methods.find((m) => m.name.toLowerCase() === String(name).toLowerCase())?.icon || 'coins';

/** Reload the list after it is edited, so every screen shows the same one. */
export async function loadPaymentMethods() {
  try {
    store.methods = await api.entities('payment_method', { all: '1' });
  } catch {
    store.methods = []; // the till falls back to Cash rather than refusing to open
  }
  return store.methods;
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);

export function money(value, { sign = false } = {}) {
  const n = Number(value) || 0;
  const body = Math.abs(n).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  const symbol = store.settings.currency || '$';
  // Arabic convention puts the currency after the amount.
  return isRtl() ? `‎${prefix}${body} ${symbol}` : `${prefix}${symbol}${body}`;
}

export const number = (value, digits = 0) =>
  (Number(value) || 0).toLocaleString(locale(), { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Quantities print without trailing zeros: 3, 2.5, 0.75. */
export const qtyText = (value) => {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};

export const pct = (value) => `${(Number(value) || 0).toFixed(1)}%`;

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export function shiftDays(iso, days) {
  // Calendar arithmetic in UTC on both ends: mixing local midnight with
  // toISOString() lands on the previous day anywhere east of Greenwich.
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const monthStart = () => `${todayISO().slice(0, 7)}-01`;

export function dateText(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTimeText(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).length <= 10 ? 'T00:00:00' : ''));
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const initials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '?';

export const signClass = (n) => (Number(n) < 0 ? 'money-neg' : Number(n) > 0 ? 'money-pos' : 'muted');

/* ----------------------------------------------------------------- toast -- */

const TOAST_ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

export function toast(message, kind = 'info', ms = 3200) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(TOAST_ICON[kind] || 'info')}<div>${esc(message)}</div>`;
  root.appendChild(el);
  const kill = () => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', kill);
  setTimeout(kill, ms);
}

/* ----------------------------------------------------------------- modal -- */

/**
 * Open a modal. `render(close)` returns HTML for the body; `setup(root, close)`
 * wires events. Resolves with whatever `close(value)` is called with.
 */
let modalSeq = 0;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modal({ title, subtitle = '', body, footer = '', wide = false, setup, onOpen }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    // Where the keyboard was, so closing puts it back there.
    const opener = document.activeElement;
    const id = `modal-${++modalSeq}`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="${id}-title"
           ${subtitle ? `aria-describedby="${id}-sub"` : ''}>
        <div class="modal-head">
          <div>
            <h3 id="${id}-title">${esc(title)}</h3>
            ${subtitle ? `<div class="sub" id="${id}-sub">${esc(subtitle)}</div>` : ''}
          </div>
          <div class="spacer"></div>
          <button class="btn btn-ghost btn-icon no-print" data-close aria-label="${esc(t('common.close'))}"
                  title="${esc(t('common.close'))}">${icon('close')}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    root.appendChild(backdrop);

    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      sweepPickers();
      // Back to the button that opened it, unless the page moved on and took it away.
      if (opener?.isConnected && !root.children.length) opener.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      // Dialogs stack (a receipt over the till, a confirm over a form): only the top one answers.
      if (root.lastElementChild !== backdrop) return;
      if (e.key === 'Escape') return close(undefined);
      // Tab stays inside the dialog, wrapping at either end.
      if (e.key !== 'Tab') return;
      const items = [...backdrop.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = backdrop.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(undefined);
    });
    backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(undefined)));

    setup?.(backdrop, close);
    onOpen?.(backdrop, close);
    // Start in the first field. A dialog without one (a receipt, a confirm) takes the focus
    // itself rather than a button: a scanner's Enter after the next barcode must not press Print.
    const field = backdrop.querySelector('[autofocus], input:not([type=hidden]), select, textarea');
    if (field) {
      field.focus();
      field.select?.();
    } else if (!backdrop.contains(document.activeElement)) {
      backdrop.querySelector('.modal').focus();
    }
  });
}

export function confirmDialog({ title, message, confirmLabel = t('common.confirm'), danger = false }) {
  return modal({
    title,
    body: `<p style="color:var(--text-2);padding:4px 0 10px">${esc(message)}</p>`,
    footer: `
      <button class="btn" data-close>${esc(t('common.cancel'))}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
    setup: (root, close) => root.querySelector('[data-confirm]').addEventListener('click', () => close(true)),
  }).then((v) => v === true);
}

/** Modal built from a field spec; resolves with the collected values. */
export function formModal({ title, subtitle, fields, submitLabel = t('common.save'), wide = false, extraFooter = '', setup: extraSetup }) {
  const body = `<form id="modal-form" class="form-grid" style="padding:8px 0 12px">${fields
    .map(fieldHtml)
    .join('')}</form>`;
  return modal({
    title,
    subtitle,
    wide,
    body,
    footer: `${extraFooter}<div class="spacer"></div>
      <button class="btn" data-close>${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" form="modal-form" type="submit">${esc(submitLabel)}</button>`,
    setup: (root, close) => {
      wireNamePickers(root, fields);
      wireTagInputs(root);
      wireBarcodeTables(root);
      // A field may need more than the spec can say (a product search, say).
      // Closing the modal sweeps away any picker it attached.
      extraSetup?.(root, close);
      root.querySelector('#modal-form').addEventListener('submit', (e) => {
        e.preventDefault();
        close(readFields(root, fields));
      });
      root.querySelectorAll('[data-action]').forEach((btn) =>
        btn.addEventListener('click', () => close({ __action: btn.dataset.action })),
      );
    },
  });
}

/** Collect a field spec's values out of a rendered form. */
export function readFields(root, fields) {
  const data = {};
  for (const f of fields) {
    if (f.type === 'static') continue;
    const el = root.querySelector(`[name="${f.name}"]`);
    if (!el) continue;
    if (f.type === 'tags') {
      data[f.name] = tagValues(el.closest('.tags-field'));
      continue;
    }
    if (f.type === 'barcodes') {
      data[f.name] = barcodeValues(el.closest('.barcodes-field'));
      continue;
    }
    data[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return data;
}

export const renderFields = (fields) => fields.map(fieldHtml).join('');

/**
 * The same field spec as formModal, rendered as an ordinary page instead of an
 * overlay. Records are edited on their own screen — the sidebar stays put, the
 * form can breathe, and a long one scrolls the page rather than a dialog.
 */
export function formPage(container, { title, subtitle = '', fields, submitLabel = t('common.save'), onSubmit, onCancel }) {
  container.innerHTML = `
    <form class="card form-page" id="page-form" novalidate>
      <div class="card-head">
        <button type="button" class="btn btn-ghost btn-icon" data-cancel
                aria-label="${esc(t('common.back'))}">${icon('back')}</button>
        <div><h3>${esc(title)}</h3>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>
      </div>
      <div class="card-body">
        <div class="form-grid">${renderFields(fields)}</div>
      </div>
      <div class="card-head form-actions">
        <div class="spacer"></div>
        <button type="button" class="btn" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="submit" class="btn btn-primary">${icon('check')} ${esc(submitLabel)}</button>
      </div>
    </form>`;

  const form = container.querySelector('#page-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // novalidate above, so required fields are reported without blocking a
    // programmatic submit; report here instead.
    if (!form.checkValidity()) return form.reportValidity();
    onSubmit(readFields(container, fields));
  });
  container.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => onCancel?.()));
  wireNamePickers(container, fields);
  wireTagInputs(container);
  wireBarcodeTables(container);

  const first = container.querySelector('[autofocus], input:not([type=hidden]), select, textarea');
  first?.focus();
  first?.select?.();
  return form;
}

function fieldHtml(f) {
  const span = f.span === 2 ? 'span-2' : '';
  const common = `name="${f.name}" ${f.required ? 'required' : ''} ${f.autofocus ? 'autofocus' : ''}`;
  if (f.type === 'static') return `<div class="field ${span}">${f.html}</div>`;
  if (f.type === 'barcodes') {
    const codes = f.value && typeof f.value === 'object' ? f.value : { main: '', list: [] };
    return `<div class="field ${span} barcodes-field">
      <label>${esc(f.label)}</label>
      <div class="barcodes-box">
        <table class="data barcodes-table"><tbody data-rows></tbody></table>
        <div class="barcodes-add">
          <div class="input-icon">${icon('barcode')}
            <input class="input barcodes-entry" placeholder="${esc(f.placeholder || '')}" autocomplete="off"/>
          </div>
          <button type="button" class="btn btn-sm" data-add-code>${icon('plus')} ${esc(t('common.add'))}</button>
        </div>
      </div>
      <input type="hidden" name="${f.name}" value="${esc(JSON.stringify(codes))}"/>
      ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
    </div>`;
  }
  if (f.type === 'tags') {
    const values = Array.isArray(f.value) ? f.value : [];
    return `<div class="field ${span} tags-field">
      <label for="tags-${f.name}">${esc(f.label)}</label>
      <div class="tags-box">
        ${values.map(tagHtml).join('')}
        <input class="tags-entry ${f.mono ? 'mono' : ''}" id="tags-${f.name}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"/>
      </div>
      <input type="hidden" name="${f.name}" value="${esc(JSON.stringify(values))}"/>
      ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
    </div>`;
  }
  if (f.type === 'checkbox') {
    return `<div class="field ${span}"><label class="check"><input type="checkbox" ${common} ${
      f.value ? 'checked' : ''
    }/> ${esc(f.label)}</label></div>`;
  }
  const control =
    f.type === 'select'
      ? `<select class="select" ${common}>${(f.options || [])
          .map(
            (o) =>
              `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(
                o.label,
              )}</option>`,
          )
          .join('')}</select>`
      : f.type === 'textarea'
        ? `<textarea class="input" ${common} placeholder="${esc(f.placeholder || '')}">${esc(f.value ?? '')}</textarea>`
        : `<input class="input" type="${f.type || 'text'}" ${common} value="${esc(f.value ?? '')}"
             placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} ${
               f.min !== undefined ? `min="${f.min}"` : ''
             } ${f.readonly ? 'readonly' : ''} ${f.names ? `data-names="${esc(f.names)}"` : ''} ${
               f.choices ? 'data-choices' : ''
             } autocomplete="off"/>`;
  // `combo` alone wraps the field for a picker the caller attaches itself.
  return `<div class="field ${span}">
    <label>${esc(f.label)}</label>${f.names || f.choices || f.combo ? `<div class="combo">${control}</div>` : control}
    ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
  </div>`;
}

/**
 * Back to the top of the screen. A menu of tabs (reports, a product, a
 * customer) stays where it is while the content under it changes, so the new
 * tab starts at its own beginning rather than partway down the last one.
 */
export const toTop = () => window.scrollTo({ top: 0, behavior: 'instant' });

/* ------------------------------------------------------- barcode tables -- */

/** What the table holds, including a code typed but not yet added. */
function barcodeValues(field) {
  const codes = JSON.parse(field.querySelector('input[type=hidden]').value || '{"main":"","list":[]}');
  const pending = field.querySelector('.barcodes-entry').value.trim();
  if (pending && pending !== codes.main && !codes.list.includes(pending)) {
    if (codes.main) codes.list = [...codes.list, pending];
    else codes.main = pending;
  }
  return codes;
}

/**
 * A product's barcodes as a small table: the main one first (the one printed on
 * shelf labels and shown in lists), then any others the same item arrives under.
 * Scan or type to add; any row can be made the main one or taken off.
 */
export function wireBarcodeTables(root) {
  root.querySelectorAll('.barcodes-field').forEach((field) => {
    if (field.dataset.wired) return;
    field.dataset.wired = '1';
    const hidden = field.querySelector('input[type=hidden]');
    const rows = field.querySelector('[data-rows]');
    const entry = field.querySelector('.barcodes-entry');
    const read = () => JSON.parse(hidden.value || '{"main":"","list":[]}');

    const draw = () => {
      const codes = read();
      const all = [...(codes.main ? [{ code: codes.main, main: true }] : []), ...codes.list.map((code) => ({ code }))];
      rows.innerHTML = all.length
        ? all
            .map(
              (r) => `<tr>
                <td class="mono">${esc(r.code)}</td>
                <td class="right nowrap">
                  ${
                    r.main
                      ? `<span class="badge accent">${esc(t('prod.barcode_main'))}</span>`
                      : `<button type="button" class="btn btn-sm btn-ghost" data-main="${esc(r.code)}">${esc(t('prod.barcode_make_main'))}</button>`
                  }
                  <button type="button" class="btn btn-sm btn-ghost" data-drop="${esc(r.code)}"
                          title="${esc(t('common.remove'))}" aria-label="${esc(t('common.remove'))}">${icon('trash')}</button>
                </td>
              </tr>`,
            )
            .join('')
        : `<tr><td class="muted">${esc(t('prod.barcode_none'))}</td></tr>`;
    };
    const write = (codes) => {
      hidden.value = JSON.stringify(codes);
      draw();
    };

    const add = () => {
      const code = entry.value.trim();
      entry.value = '';
      if (!code) return;
      const codes = read();
      if (code === codes.main || codes.list.includes(code)) return;
      if (codes.main) codes.list.push(code);
      else codes.main = code;
      write(codes);
    };
    entry.addEventListener('keydown', (e) => {
      // A scanner types the code and presses Enter; that adds a row, never saves.
      if (e.key !== 'Enter') return;
      e.preventDefault();
      add();
    });
    // Not on blur: a row appearing under the pointer would move whatever is being
    // clicked. A code left in the box is saved with the form all the same.
    field.querySelector('[data-add-code]').addEventListener('click', add);

    rows.addEventListener('click', (e) => {
      const main = e.target.closest('[data-main]');
      const drop = e.target.closest('[data-drop]');
      const codes = read();
      if (main) {
        const code = main.dataset.main;
        codes.list = [...codes.list.filter((c) => c !== code), ...(codes.main ? [codes.main] : [])];
        codes.main = code;
        write(codes);
      } else if (drop) {
        const code = drop.dataset.drop;
        if (codes.main === code) {
          codes.main = codes.list[0] || '';
          codes.list = codes.list.slice(1);
        } else {
          codes.list = codes.list.filter((c) => c !== code);
        }
        write(codes);
      }
    });
    draw();
  });
}

/* ------------------------------------------------------------ tag fields -- */

const tagHtml = (value) =>
  `<span class="tag" data-tag="${esc(value)}"><span class="mono">${esc(value)}</span><button type="button" class="tag-x"
     data-untag title="${esc(t('common.remove'))}" aria-label="${esc(t('common.remove'))}">${icon('close')}</button></span>`;

/** The values of a tag field, including one still being typed. */
function tagValues(field) {
  const values = JSON.parse(field.querySelector('input[type=hidden]').value || '[]');
  const pending = field.querySelector('.tags-entry').value.trim();
  return pending && !values.includes(pending) ? [...values, pending] : values;
}

/**
 * A field holding a short list, like a product's other barcodes: type or scan
 * one and press Enter, and it becomes a chip; the × takes it off. Enter never
 * submits the form from here, since a scanner presses it after every code.
 */
export function wireTagInputs(root) {
  root.querySelectorAll('.tags-field').forEach((field) => {
    if (field.dataset.wired) return;
    field.dataset.wired = '1';
    const hidden = field.querySelector('input[type=hidden]');
    const entry = field.querySelector('.tags-entry');
    const box = field.querySelector('.tags-box');
    const read = () => JSON.parse(hidden.value || '[]');
    const write = (values) => {
      hidden.value = JSON.stringify(values);
      box.querySelectorAll('.tag').forEach((el) => el.remove());
      entry.insertAdjacentHTML('beforebegin', values.map(tagHtml).join(''));
    };
    const commit = () => {
      const value = entry.value.trim();
      entry.value = '';
      if (!value) return;
      const values = read();
      if (values.includes(value)) {
        box.querySelector(`.tag[data-tag="${CSS.escape(value)}"]`)?.classList.add('flash');
        return;
      }
      write([...values, value]);
    };
    entry.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
        if (e.key === 'Tab' && !entry.value.trim()) return;
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !entry.value) {
        const values = read();
        if (values.length) write(values.slice(0, -1));
      }
    });
    entry.addEventListener('blur', commit);
    box.addEventListener('click', (e) => {
      const x = e.target.closest('[data-untag]');
      if (x) {
        const value = x.closest('.tag').dataset.tag;
        write(read().filter((v) => v !== value));
      }
      entry.focus();
    });
  });
}

/* ---------------------------------------------------------------- paging -- */

export const PER_PAGE = [25, 50, 100, 200];

/**
 * The strip under a list: how much is being shown, how many fit on a page, and
 * the way through them. Lists ask the server for one page at a time, so a shop
 * with thousands of invoices opens as quickly as a new one.
 *
 *   root.append(pager(result, ({ page, per }) => { state.page = page; load(); }))
 */
export function pager({ page = 1, pages = 1, total = 0, per = 50 }, onChange) {
  const el = document.createElement('div');
  el.className = 'pager';
  const from = total ? (page - 1) * per + 1 : 0;
  const to = Math.min(total, page * per);
  el.innerHTML = `
    <span class="pager-count">${esc(t('page.showing', { from: number(from), to: number(to), total: number(total) }))}</span>
    <div class="spacer"></div>
    <label class="pager-per">${esc(t('page.per_page'))}
      <select class="select">${PER_PAGE.map(
        (n) => `<option value="${n}" ${n === per ? 'selected' : ''}>${n}</option>`,
      ).join('')}</select>
    </label>
    <div class="pager-nav">
      <button class="btn btn-sm btn-ghost" data-go="1" ${page <= 1 ? 'disabled' : ''} title="${esc(t('page.first'))}">«</button>
      <button class="btn btn-sm" data-go="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${esc(t('page.prev'))}</button>
      <span class="pager-page">${esc(t('page.of', { page: number(page), pages: number(pages) }))}</span>
      <button class="btn btn-sm" data-go="${page + 1}" ${page >= pages ? 'disabled' : ''}>${esc(t('page.next'))}</button>
      <button class="btn btn-sm btn-ghost" data-go="${pages}" ${page >= pages ? 'disabled' : ''} title="${esc(t('page.last'))}">»</button>
    </div>`;
  el.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => onChange({ page: Math.min(pages, Math.max(1, Number(b.dataset.go))), per })),
  );
  el.querySelector('.pager-per select').addEventListener('change', (e) =>
    onChange({ page: 1, per: Number(e.target.value) }),
  );
  return el;
}

/** A labelled dropdown for a list's filter bar. */
export function filterSelect({ label, value, options, onChange }) {
  const el = document.createElement('label');
  el.className = 'filter-select';
  el.innerHTML = `<span>${esc(label)}</span>
    <select class="select">${options
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`;
  el.querySelector('select').addEventListener('change', (e) => onChange(e.target.value));
  return el;
}

/**
 * The figures for a whole list — how many rows match and what they come to —
 * as the tail of the list's filter bar, so the table itself starts at its
 * headings instead of repeating a header of its own.
 *
 *   const sum = listSummary(bar);
 *   sum.innerHTML = `${t('prod.totals', { n: total })} · ${badge}`;
 */
export function listSummary(bar) {
  const el = document.createElement('div');
  el.className = 'list-summary';
  bar.appendChild(el);
  return el;
}

/* ------------------------------------------------------------- fragments -- */

/**
 * A document (invoice, purchase, adjustment) opened as a page: a header card
 * with Back, the title, badges and actions, and the body underneath.
 * Returns the body element; `[data-back]` inside the header goes back.
 */
export function docPage(root, { title, subtitle = '', badges = '', actions = '', onBack }) {
  root.innerHTML = `
    <div class="card doc-head">
      <button type="button" class="btn btn-ghost btn-icon" data-back aria-label="${esc(t('common.back'))}">${icon('back')}</button>
      <div class="doc-title"><h2>${esc(title)}</h2>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>
      <div class="doc-badges">${badges}</div>
      <div class="spacer"></div>
      <div class="doc-actions no-print">${actions}</div>
    </div>
    <div class="doc-body"></div>`;
  root.querySelector('[data-back]').addEventListener('click', () => onBack?.());
  return root.querySelector('.doc-body');
}

/**
 * The head of a printed slip: the shop's logo, if it has one, above its name.
 * `cfg` lets a stored document print with the settings it was made under.
 */
export const slipHead = (cfg = store.settings) => `
  ${cfg.store_logo ? `<div class="r-logo"><img src="${esc(cfg.store_logo)}" alt="" /></div>` : ''}
  <div class="r-center r-shop"><b>${esc(cfg.store_name || t('app.name'))}</b></div>`;

/** The tail of a printed slip: the software that printed it, in small type. */
export const slipFoot = () => `
  <div class="r-by"><img src="/img/logo-mark.svg" alt="" /><span>${esc(t('print.by', { v: store.version || '' }))}</span></div>`;

/** A product's picture, or its initials on a tinted square when it has none. */
export function productThumb(p, size = 'sm') {
  if (p?.image_at) {
    return `<img class="pthumb ${size}" src="/api/products/${p.id}/image?v=${encodeURIComponent(p.image_at)}"
                 alt="" loading="lazy" decoding="async"/>`;
  }
  // Not "empty": that is the empty-state class, and its padding would stretch the box.
  return `<span class="pthumb ${size} no-image" aria-hidden="true">${esc(initials(p?.name || ''))}</span>`;
}

/**
 * Read a picked image file and shrink it for upload: at most `max` pixels on the
 * long side, re-encoded as WebP (JPEG where WebP is unsupported). A phone photo
 * of several megabytes becomes a few tens of kilobytes.
 */
export function shrinkImage(file, max = 1024) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('not an image'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; // transparent PNGs would otherwise turn black as JPEG
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL('image/webp', 0.86);
      if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', 0.86);
      resolve(data);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable image'));
    };
    img.src = url;
  });
}

export const emptyState = (title, message, iconName = 'box') =>
  `<div class="empty">${icon(iconName)}<strong>${esc(title)}</strong><p>${esc(message)}</p></div>`;

export const statTile = ({ label, value, foot = '', tint = '', iconName = '', trend = '' }) => `
  <div class="stat ${tint ? `tint-${tint}` : ''}">
    <div class="label">${iconName ? icon(iconName) : ''}${esc(label)}</div>
    <div class="value">${value}${trend}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ''}
  </div>`;

/**
 * Whether a figure is up or down on an earlier one, as a small pill beside it:
 * "▲ 12%" against yesterday, or the same days last month. `vs` is the i18n key that
 * names the comparison. Nothing at all when there is no earlier figure to compare
 * with — a percentage of zero (or of a loss) would only mislead.
 */
export function trendPill(now, before, vs) {
  now = Number(now) || 0;
  before = Number(before) || 0;
  if (!(before > 0)) return '';
  const pct = ((now - before) / before) * 100;
  const dir = Math.abs(pct) < 0.5 ? 'same' : pct > 0 ? 'up' : 'down';
  const p = `${Math.round(Math.abs(pct))}%`;
  const said = `${t(`dash.trend_${dir}`, { p })} ${t(vs, { v: money(before) })}`;
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬';
  return `<span class="stat-trend ${dir}" title="${esc(said)}" aria-label="${esc(said)}"><span aria-hidden="true">${arrow}</span>${
    dir === 'same' ? '' : ` ${p}`
  }</span>`;
}

export const spinner = () => `<div class="empty"><p>${esc(t('common.loading'))}</p></div>`;

/** Horizontal bar list used for breakdowns (categories, top products). */
export function barList(items, { valueFormat = money } = {}) {
  const max = Math.max(...items.map((i) => Math.abs(Number(i.value) || 0)), 1);
  return `<div class="bar-list">${items
    .map(
      (i) => `<div class="bar-item">
        <div class="bl-top"><strong>${esc(i.label)}</strong><span>${valueFormat(i.value)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (Math.abs(i.value) / max) * 100)}%"></div></div>
      </div>`,
    )
    .join('')}</div>`;
}

/**
 * Combined bar (revenue) + line (profit) chart, drawn as plain SVG.
 * Kept deliberately simple: no external chart library, no build step.
 *
 * `markKey` adds a lane under the axis with one small bar per day that has a value
 * (expenses): a rent day shows as a mark of its own instead of dragging the profit
 * line, and the scale, far below everything else.
 */
export function chartSvg(series, { barKey = 'revenue', lineKey = 'gross_profit', markKey = null } = {}) {
  if (!series.length) return emptyState(t('rep.chart_empty'), t('rep.chart_empty_sub'), 'chart');

  const marks = markKey ? series.map((d) => Number(d[markKey]) || 0) : [];
  const markMax = Math.max(0, ...marks);
  const lane = markMax > 0 ? 18 : 0;

  const W = 760;
  const H = 210 + lane;
  const padL = 46;
  const padR = 10;
  const padT = 12;
  const padB = 24 + lane;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const bars = series.map((d) => Number(d[barKey]) || 0);
  const lines = series.map((d) => Number(d[lineKey]) || 0);
  const scale = niceTicks(Math.min(...bars, ...lines), Math.max(...bars, ...lines));
  const bottom = scale.min;
  const span = scale.max - scale.min;

  const y = (v) => padT + innerH - ((v - bottom) / span) * innerH;
  const slot = innerW / series.length;
  const barW = Math.max(2, Math.min(26, slot * 0.6));

  const barsHtml = series
    .map((d, i) => {
      const v = Number(d[barKey]) || 0;
      const x = padL + slot * i + (slot - barW) / 2;
      const yy = y(Math.max(v, 0));
      const h = Math.max(v === 0 ? 0 : 1.5, Math.abs(y(v) - y(0)));
      return `<rect class="bar" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(
        1,
      )}" rx="3"><title>${esc(d.date)} · ${money(v)}</title></rect>`;
    })
    .join('');

  const pts = series.map((d, i) => [padL + slot * i + slot / 2, y(Number(d[lineKey]) || 0)]);
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  // Steps under 1 need decimals, or neighbouring ticks would read the same.
  const decimals = stepDecimals(scale.step);
  const tickLabel = (v) => (decimals ? v.toFixed(decimals) : shortNum(v));
  const ticks = scale.ticks.map((v) => {
    const yy = y(v);
    return `<line class="${v === 0 ? 'zero-line' : 'grid-line'}" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(
      1,
    )}" y2="${yy.toFixed(1)}"/>
            <text class="axis-text" x="${padL - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${tickLabel(v)}</text>`;
  });

  // Mark heights follow the square root of the amount, so a small bill stays visible beside the rent.
  const laneTop = padT + innerH + 5;
  const marksHtml = marks
    .map((v, i) => {
      if (v <= 0) return '';
      const h = 3 + 10 * Math.sqrt(v / markMax);
      const x = padL + slot * i + (slot - barW) / 2;
      return `<rect class="mark" x="${x.toFixed(1)}" y="${laneTop}" width="${barW.toFixed(1)}" height="${h.toFixed(
        1,
      )}" rx="1.5"><title>${esc(series[i].date)} · ${esc(t('rep.expenses'))} ${money(v)}</title></rect>`;
    })
    .join('');

  const step = Math.max(1, Math.ceil(series.length / 8));
  const last = series.length - 1;
  // Always label the final day, but drop the tick before it if they would collide.
  const labelled = new Set(series.map((_, i) => i).filter((i) => i % step === 0 && last - i >= step / 2));
  labelled.add(last);
  const labels = [...labelled]
    .map(
      (i) =>
        `<text class="axis-text" x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${series[
          i
        ].date.slice(5)}</text>`,
    )
    .join('');

  return `<svg class="chart${lane ? ' has-marks' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${ticks.join('')}
    ${barsHtml}
    <path class="line" d="${linePath}"/>
    ${marksHtml}
    ${labels}
  </svg>`;
}

export function shortNum(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/* ----------------------------------------------------------- suggestions -- */

/**
 * Saved names for a directory kind (customer, supplier, category, unit…).
 *
 * Cached per kind so a busy till is not refetching on every keystroke. Anything
 * that adds a name calls `forgetSuggestions` so the next field picks it up.
 */
const suggestionCache = new Map();

/** The saved rows (name, phone, email…) for a kind. */
export function directory(kind) {
  if (!suggestionCache.has(kind)) {
    suggestionCache.set(
      kind,
      api.entities(kind).catch(() => []), // suggestions are a convenience; never block the form
    );
  }
  return suggestionCache.get(kind);
}

/** Just the names. */
export const suggestions = (kind) => directory(kind).then((rows) => rows.map((r) => r.name));

export const forgetSuggestions = (kind) => (kind ? suggestionCache.delete(kind) : suggestionCache.clear());


/* ------------------------------------------------------------------ misc -- */

export function downloadCsv(filename, rows) {
  if (!rows.length) return toast(t('common.nothing_export'), 'warn');
  const headers = Object.keys(rows[0]);
  const escapeCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast(t('common.exported', { n: rows.length }), 'success');
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Date-range picker with quick presets; calls onChange({from, to}). */
export function rangeBar(range, onChange) {
  const presets = [
    [t('range.today'), () => ({ from: todayISO(), to: todayISO() })],
    [t('range.7days'), () => ({ from: shiftDays(todayISO(), -6), to: todayISO() })],
    [t('range.30days'), () => ({ from: shiftDays(todayISO(), -29), to: todayISO() })],
    [t('range.month'), () => ({ from: monthStart(), to: todayISO() })],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'toolbar';
  wrap.innerHTML = `
    <div class="seg">${presets
      .map((p, i) => `<button data-preset="${i}">${esc(p[0])}</button>`)
      .join('')}</div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px">
      <input class="input" type="date" name="from" value="${range.from}" style="width:150px"/>
      <span class="muted">${isRtl() ? '←' : '→'}</span>
      <input class="input" type="date" name="to" value="${range.to}" style="width:150px"/>
    </div>`;

  const apply = (next) => {
    wrap.querySelector('[name=from]').value = next.from;
    wrap.querySelector('[name=to]').value = next.to;
    onChange(next);
  };
  wrap.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => apply(presets[Number(b.dataset.preset)][1]())),
  );
  wrap.querySelectorAll('input[type=date]').forEach((input) =>
    input.addEventListener('change', () =>
      onChange({ from: wrap.querySelector('[name=from]').value, to: wrap.querySelector('[name=to]').value }),
    ),
  );
  return wrap;
}
