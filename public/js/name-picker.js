import { attachPicker } from './picker.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { directory, esc, initials } from './ui.js';

/**
 * A text field for a reusable name — customer, supplier, category, unit —
 * with a proper dropdown of the saved ones instead of the browser's own
 * suggestion list.
 *
 * It stays a free-text field: anything typed is accepted, and a name that is
 * not saved yet is offered as "Use … (new)", listed first so Enter keeps
 * exactly what was typed. The server remembers new names when the document
 * is saved.
 *
 *   attachNamePicker(input, { kind: 'customer' })
 *   attachNamePicker(input, { extra: ['Stock count', 'Damaged'] })   // fixed choices
 */
export function attachNamePicker(input, { kind = null, extra = [], onPick } = {}) {
  if (!input.closest('.combo')) {
    const wrap = document.createElement('div');
    wrap.className = 'combo';
    input.replaceWith(wrap);
    wrap.appendChild(input);
  }
  input.closest('.combo').classList.add('combo-names');

  async function pool() {
    const rows = kind ? await directory(kind) : [];
    const seen = new Set(rows.map((r) => r.name.toLowerCase()));
    const fixed = extra.filter((n) => n && !seen.has(n.toLowerCase())).map((name) => ({ name }));
    return [...rows, ...fixed];
  }

  const picker = attachPicker(input, {
    delay: 40,
    openOnFocus: false,
    emptyText: t('picker.no_names'),
    // Highlight the name already in the field; with nothing typed, highlight nothing,
    // so Enter does not swap the value for whatever happens to be first.
    activeIndex: (results, query) => {
      const current = input.value.trim().toLowerCase();
      const at = results.findIndex((r) => !r.isNew && r.name.toLowerCase() === current);
      return at >= 0 ? at : query ? 0 : -1;
    },
    search: async (query) => {
      const all = await pool();
      const needle = query.toLowerCase();
      const matches = all
        .filter((r) => !needle || r.name.toLowerCase().includes(needle))
        // Names that start with what was typed come before names that merely contain it.
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)))
        .slice(0, 60);
      const exact = all.some((r) => r.name.toLowerCase() === needle);
      return query && !exact ? [{ name: query, isNew: true }, ...matches] : matches;
    },
    render: (r) => {
      if (r.isNew) {
        return `<span class="ci-avatar new">${icon('plus')}</span>
          <div class="ci-main"><div class="ci-name">${esc(t('picker.use_new', { name: r.name }))}</div>
          <div class="ci-sub">${esc(t('picker.use_new_sub'))}</div></div>`;
      }
      const sub = [r.phone, r.email].filter(Boolean).join(' · ');
      return `<span class="ci-avatar">${esc(initials(r.name))}</span>
        <div class="ci-main"><div class="ci-name">${esc(r.name)}</div>
        ${sub ? `<div class="ci-sub">${esc(sub)}</div>` : ''}</div>`;
    },
    onPick: (r) => {
      input.value = r.name;
      // "change", not "input": an input event would reopen the search.
      input.dispatchEvent(new Event('change', { bubbles: true }));
      onPick?.(r);
    },
  });

  // Click opens the full list, like a select, with the current value highlighted;
  // typing then narrows it. Merely tabbing through does not open it, so a dialog
  // that focuses this field first is not covered by a menu.
  input.addEventListener('click', () => {
    if (!picker.isOpen()) picker.open('');
  });
  return picker;
}

/** Attach name pickers to every `[data-names]` / `[data-choices]` field inside `root`. */
export function wireNamePickers(root, fields = []) {
  const pickers = [];
  root.querySelectorAll('input[data-names], input[data-choices]').forEach((input) => {
    const spec = fields.find((f) => f.name === input.name) || {};
    pickers.push(attachNamePicker(input, { kind: input.dataset.names || null, extra: spec.choices || [] }));
  });
  return () => pickers.forEach((p) => p.destroy());
}
