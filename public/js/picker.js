import { esc } from './ui.js';

/**
 * Type-ahead picker for a plain text input.
 *
 * Replaces the usual `<select>` full of every record: you type, results appear
 * underneath, and arrow keys or a click choose one. Searching happens through the
 * caller's `search` function — normally a server query — so a shop with thousands
 * of products never ships them all to the browser.
 *
 * The input must sit inside an element with class `combo`.
 *
 *   attachPicker(input, {
 *     search: (q) => api.products({ search: q }),
 *     render: (p) => `<b>${p.name}</b>`,
 *     onPick: (p) => ...,
 *   })
 *
 * Returns { open, close, isOpen, activeItem, refresh, destroy }.
 */
export function attachPicker(input, { search, render, onPick, emptyText = '', openOnFocus = true, delay = 180 }) {
  const wrap = input.closest('.combo');
  if (!wrap) throw new Error('attachPicker: the input must be inside a .combo element');

  // Mounted on <body>, not next to the input. Pickers sit inside scrolling table
  // wrappers and modals, and any of those would clip an absolutely-positioned
  // menu; a fixed layer escapes every one of them.
  const menu = document.createElement('div');
  menu.className = 'combo-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);

  /** Sit the menu under the input, or above it when the window runs out. */
  function position() {
    // If the field has been re-rendered away, take the menu with it.
    if (!input.isConnected) return destroy();
    const r = input.getBoundingClientRect();
    const gap = 5;
    menu.style.width = `${r.width}px`;
    menu.style.left = `${r.left}px`;
    const below = window.innerHeight - r.bottom - gap;
    const wanted = Math.min(menu.scrollHeight || 320, 320);
    if (below < wanted && r.top > below) {
      menu.style.top = `${Math.max(8, r.top - gap - wanted)}px`;
      menu.style.maxHeight = `${Math.min(wanted, r.top - gap - 8)}px`;
    } else {
      menu.style.top = `${r.bottom + gap}px`;
      menu.style.maxHeight = `${Math.max(120, below - 8)}px`;
    }
  }

  const reposition = () => {
    if (!menu.hidden) position();
  };

  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-expanded', 'false');

  let items = [];
  let active = -1;
  let token = 0; // discards results from a keystroke the user has already overtaken
  let timer;

  const isOpen = () => !menu.hidden;

  function close() {
    menu.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function paint() {
    menu.innerHTML = items.length
      ? items
          .map(
            (item, i) =>
              `<div class="combo-item ${i === active ? 'active' : ''}" data-i="${i}" role="option"
                    aria-selected="${i === active}">${render(item)}</div>`,
          )
          .join('')
      : `<div class="combo-empty">${esc(emptyText)}</div>`;
    menu.hidden = false;
    position();
    input.setAttribute('aria-expanded', 'true');
  }

  function highlight(next) {
    if (!items.length) return;
    active = (next + items.length) % items.length;
    menu.querySelectorAll('.combo-item').forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  async function run(query) {
    const mine = ++token;
    let results = [];
    try {
      results = (await search(query)) || [];
    } catch {
      results = []; // a failed lookup shows "no matches", never a broken field
    }
    if (mine !== token) return; // a newer keystroke already answered
    items = results;
    active = results.length ? 0 : -1;
    paint();
  }

  const schedule = (query) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(query), delay);
  };

  input.addEventListener('input', () => schedule(input.value.trim()));

  input.addEventListener('focus', () => {
    if (openOnFocus) schedule(input.value.trim());
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) return run(input.value.trim());
      highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation(); // keep Escape from also closing the surrounding modal
      close();
      return;
    }
    if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    }
  });

  // mousedown, not click: the input must not blur before the choice registers.
  menu.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.combo-item');
    if (!el) return;
    e.preventDefault();
    choose(items[Number(el.dataset.i)]);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  function choose(item) {
    if (!item) return;
    close();
    onPick(item);
  }

  function destroy() {
    clearTimeout(timer);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    menu.remove();
  }

  window.addEventListener('scroll', reposition, true); // capture: any ancestor
  window.addEventListener('resize', reposition);

  return {
    isOpen,
    close,
    activeItem: () => (active >= 0 ? items[active] : null),
    refresh: () => run(input.value.trim()),
    destroy,
  };
}
