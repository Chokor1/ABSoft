import { api } from '../api.js';
import { wireNamePickers } from '../name-picker.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import {
  debounce,
  emptyState,
  esc,
  forgetSuggestions,
  modal,
  methodMark,
  money,
  paymentMethods,
  qtyText,
  store,
  toast,
} from '../ui.js';
import { showReceipt } from './sales.js';
import { celebrateSale, playSaleChime, primeAudio, setTileImages, tileImagesEnabled } from '../feedback.js';
import { money2, money2Html, onRateChange, second, toBase, toSecond } from '../currency.js';

// The shop's own ways to pay; with none set up, Cash alone still works.
const methodOptions = () => {
  const list = paymentMethods();
  return (list.length ? list : [{ name: 'cash', icon: 'coins' }]).map((m) => ({
    value: m.name,
    label: methodText(m.name),
    icon: m.icon || 'coins',
    logo: String(m.icon || '').startsWith('data:image/'),
  }));
};
const freshDraft = () => ({ customer: '', method: 'cash', discount: 0, discountInput: 0, discountMode: 'amount', note: '' });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The till.
 *
 * The flow is deliberately split in two. The cart is only what is being sold:
 * each line can be adjusted where it sits, and the total. Everything to do with
 * money changing hands — who the customer is, how they pay, an invoice discount,
 * how much they hand over and what is left — happens in the payment dialog, and
 * saving there goes straight to the printable receipt.
 */
export async function render(root, ctx) {
  const state = {
    products: [],
    filter: '',
    // Newest line first, so whatever was just scanned is always at the top.
    cart: [],
    // Kept between openings of the payment dialog, so cancelling it loses nothing.
    draft: freshDraft(),
  };

  const taxRate = Number(store.settings.tax_rate) || 0;

  root.innerHTML = `
    <div class="pos">
      <div class="scan-bar">
        <div class="input-icon combo">
          ${icon('barcode')}
          <input class="input" id="scan" data-search placeholder="${esc(
            t('pos.scan_placeholder'),
          )}" autocomplete="off"/>
        </div>
        <button class="btn btn-icon" id="toggle-images" aria-pressed="${tileImagesEnabled()}"
                title="${esc(t('pos.show_images'))}">${icon('image')}</button>
        <button class="btn" id="clear-search">${esc(t('pos.clear'))}</button>
      </div>

      <aside class="cart">
        <div class="cart-head">
          <h3>${esc(t('pos.current_sale'))}</h3>
          <span class="badge accent" id="cart-count"></span>
          <button class="btn btn-ghost btn-icon" id="clear-cart" title="${esc(t('pos.clear_cart'))}">${icon(
            'trash',
          )}</button>
        </div>
        <div class="cart-lines" id="cart-lines"></div>
        <div class="cart-foot">
          <div id="totals"></div>
          <button class="btn btn-primary btn-lg btn-block" id="checkout" disabled>
            ${icon('coins')} ${esc(t('pos.make_payment'))}
          </button>
        </div>
      </aside>

      <div id="tiles" class="product-grid"></div>

      <!-- phones: the total and the way to pay stay in reach while scrolling products -->
      <div class="pos-bar" id="pos-bar">
        <div class="pos-bar-total">
          <small id="bar-count"></small>
          <strong id="bar-total"></strong>
        </div>
        <button class="btn btn-primary btn-lg" id="bar-checkout" disabled>${icon('coins')} ${esc(
          t('pos.make_payment'),
        )}</button>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const tiles = $('#tiles');
  const scan = $('#scan');
  const linesEl = $('#cart-lines');

  /* ------------------------------------------------------------ catalogue -- */

  /*
   * The till never loads the whole catalogue, so a shop with thousands of
   * products opens and scans as fast as one with ten:
   *   - it opens on the best sellers (the last 30 days), QUICK cards;
   *   - one or two letters narrow the cards already on screen, instantly;
   *   - three or more search every product on the server (RESULTS at a time),
   *     narrowing what is on screen while the answer comes;
   *   - scrolling to the end of the cards loads the next batch of either;
   *   - Enter, or a scanner, looks the code up exactly.
   * Cards that stay glide to their new places, cards that arrive fade in.
   */
  const QUICK = 40;
  const MIN_SEARCH = 3;
  const RESULTS = 60;
  let searchToken = 0; // an answer to an older search must not paint over a newer one
  state.mode = 'popular';
  state.resultsFor = '';
  state.more = false; // the last batch was full, so there may be more
  let loadingMore = false;
  let showImages = tileImagesEnabled();
  $('#toggle-images').addEventListener('click', (e) => {
    showImages = !showImages;
    setTileImages(showImages);
    e.currentTarget.setAttribute('aria-pressed', String(showImages));
    drawTiles();
    applyFilter({ animate: false });
  });

  /** Load whatever should be on screen now — after a sale too, for fresh stock. */
  async function loadProducts() {
    if (state.filter.length >= MIN_SEARCH) return searchServer(state.filter, { animate: false });
    if (!state.products.length) {
      tiles.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>${esc(t('pos.loading_products'))}</p></div>`;
    }
    const token = ++searchToken;
    const rows = await api.products({ sort: 'popular', limit: QUICK });
    if (token !== searchToken) return;
    Object.assign(state, { products: rows, mode: 'popular', resultsFor: '', more: rows.length === QUICK });
    drawTiles();
    applyFilter({ animate: false });
    maybeLoadMore();
  }

  /** Every product matching `text`, from the server. Resolves null when overtaken. */
  async function searchServer(text, { animate = true } = {}) {
    const token = ++searchToken;
    let rows;
    try {
      rows = await api.products({ search: text, limit: RESULTS });
    } catch {
      return null;
    }
    if (token !== searchToken || state.filter !== text) return null;
    const same = rows.length === state.products.length && rows.every((p, i) => p.id === state.products[i].id);
    Object.assign(state, { products: rows, mode: 'search', resultsFor: text, more: rows.length === RESULTS });
    if (same && animate) {
      applyFilter({ animate: false });
    } else {
      drawTiles();
      applyFilter({ animate: false, fadeIn: animate });
    }
    maybeLoadMore();
    return rows;
  }

  /** The next batch, when the end of the cards comes near. */
  async function loadMore() {
    const short = state.filter.length > 0 && state.filter.length < MIN_SEARCH;
    if (loadingMore || !state.more || short) return;
    loadingMore = true;
    const token = searchToken;
    const batch = state.mode === 'search' ? RESULTS : QUICK;
    const query =
      state.mode === 'search'
        ? { search: state.resultsFor, limit: RESULTS, offset: state.products.length }
        : { sort: 'popular', limit: QUICK, offset: state.products.length };
    paintMore();
    let rows = [];
    try {
      rows = await api.products(query);
    } catch {
      rows = null;
    }
    loadingMore = false;
    // A new search started meanwhile: this batch belongs to the old one.
    if (token !== searchToken || !rows) return paintMore();
    const known = new Set(state.products.map((p) => p.id));
    const fresh = rows.filter((p) => !known.has(p.id));
    state.products = [...state.products, ...fresh];
    state.more = rows.length === batch;
    tiles.querySelector('#tiles-empty').insertAdjacentHTML('beforebegin', fresh.map(tileHtml).join(''));
    applyFilter({ animate: false });
    if (!reduceMotion()) {
      fresh.forEach((p, i) =>
        tiles.querySelector(`.tile[data-add="${p.id}"]`)?.animate(
          [{ opacity: 0, transform: 'translateY(8px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
          { duration: 260, delay: Math.min(i, 16) * 12, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
        ),
      );
    }
    paintMore();
    maybeLoadMore();
  }

  const paintMore = () => {
    const more = tiles.querySelector('#tiles-more');
    if (more) more.innerHTML = loadingMore ? `<span class="tiles-spinner"></span>${esc(t('pos.loading_more'))}` : '';
  };

  /** Load more once the end of the cards is within reach, in the card section or the page. */
  function maybeLoadMore() {
    const end = tiles.querySelector('#tiles-more');
    if (!end || !state.more || loadingMore) return;
    const box = tiles.getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, tiles.scrollHeight > tiles.clientHeight + 1 ? box.bottom : window.innerHeight);
    if (end.getBoundingClientRect().top < bottom + 120) loadMore();
  }
  const onScroll = () => maybeLoadMore();
  tiles.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  const haystack = (p) =>
    [p.name, p.barcode, ...(p.barcodes || []), p.category, p.description].filter(Boolean).join(' ').toLowerCase();

  function drawTiles() {
    tiles.innerHTML =
      state.products.map(tileHtml).join('') +
      `<div class="tiles-empty" id="tiles-empty" hidden></div><div class="tiles-note" id="tiles-note" hidden></div>
       <div class="tiles-more" id="tiles-more"></div>`;
  }

  function tileHtml(p) {
    const prices = `<div class="t-meta">
      <span class="t-prices"><span class="t-price">${money(p.price)}</span>${money2Html(p.price, { cls: 'block' })}</span>
      <span class="t-stock">${qtyText(p.stock)} ${esc(p.unit)}</span>
    </div>`;
    const title = [p.name, p.description].filter(Boolean).join(' — ');
    if (showImages) {
      // Picture cards: the picture fills the top, the name sits over its lower
      // edge, the price is underneath. No picture yet: a quiet placeholder.
      const src = p.image_at ? `/api/products/${p.id}/image?v=${encodeURIComponent(p.image_at)}` : '';
      return `<button class="tile tile-pic ${p.stock <= 0 ? 'out' : ''}" data-add="${p.id}"
               data-find="${esc(haystack(p))}" title="${esc(title)}">
        <div class="tp-media ${src ? '' : 'no-img'}">
          ${src ? `<img class="tp-img" src="${esc(src)}" alt="" loading="lazy" decoding="async" draggable="false"/>` : icon('image')}
          <div class="tp-name">${esc(p.name)}</div>
        </div>
        <div class="tp-body">${prices}</div>
      </button>`;
    }
    return `<button class="tile ${p.stock <= 0 ? 'out' : ''}" data-add="${p.id}"
           data-find="${esc(haystack(p))}" ${p.description ? `title="${esc(p.description)}"` : ''}>
    <div class="t-name">${esc(p.name)}</div>
    ${p.description ? `<div class="t-desc">${esc(p.description)}</div>` : ''}
    <div class="t-meta">
      <span class="t-prices"><span class="t-price">${money(p.price)}</span>${money2Html(p.price, { cls: 'block' })}</span>
      <span class="t-stock">${qtyText(p.stock)} ${esc(p.unit)}</span>
    </div>
  </button>`;
  }

  /** Every word typed must appear somewhere in the name, barcode, category or description. */
  const matches = (el, words) => words.every((w) => el.dataset.find.includes(w));
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function applyFilter({ animate = true, fadeIn = false } = {}) {
    const words = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const cards = [...tiles.querySelectorAll('.tile')];
    const motion = animate && !reduceMotion();

    // First: where the visible cards are now.
    const before = new Map();
    if (motion) cards.forEach((c) => !c.hidden && before.set(c, c.getBoundingClientRect()));

    let shown = 0;
    cards.forEach((c) => {
      const show = !words.length || matches(c, words);
      c.hidden = !show;
      if (show) shown++;
    });

    // Short of three letters, only the cards on screen were searched.
    const short = words.length > 0 && state.filter.length < MIN_SEARCH;
    const empty = tiles.querySelector('#tiles-empty');
    empty.hidden = shown > 0;
    if (!shown) {
      const nothingYet = state.mode === 'popular' && !words.length && !state.products.length;
      empty.innerHTML = emptyState(
        nothingYet ? t('pos.no_products') : t('pos.no_match'),
        nothingYet ? t('pos.no_products_sub') : short ? t('pos.type_more') : t('pos.no_match_sub'),
        'box',
      );
    }
    const note = tiles.querySelector('#tiles-note');
    note.hidden = !shown || !(short && state.products.length >= QUICK);
    note.textContent = t('pos.type_more');

    if (fadeIn && !reduceMotion()) {
      cards.forEach((c, i) => {
        if (c.hidden) return;
        c.animate([{ opacity: 0, transform: 'translateY(6px) scale(0.97)' }, { opacity: 1, transform: 'none' }], {
          duration: 240,
          delay: Math.min(i, 12) * 14,
          easing: 'cubic-bezier(.2,.8,.2,1)',
          fill: 'backwards',
        });
      });
    }
    if (!motion) return;

    // Last, invert, play: slide the cards that stayed from where they were,
    // and let the ones that reappeared grow in.
    cards.forEach((c) => {
      if (c.hidden) return;
      const was = before.get(c);
      if (!was) {
        c.animate(
          [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }],
          { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
        return;
      }
      const now = c.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 260,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
    });
  }

  tiles.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (btn) addToCart(state.products.find((p) => p.id === Number(btn.dataset.add)));
  });

  const searchSoon = debounce((text) => searchServer(text), 260);
  const refilter = debounce(() => {
    const text = scan.value.trim();
    state.filter = text;
    if (text.length >= MIN_SEARCH) {
      // Narrow what is on screen straight away, then fetch everything that matches.
      applyFilter();
      searchSoon(text);
    } else if (state.mode === 'search') {
      loadProducts(); // back under three letters: the best sellers again
    } else {
      applyFilter();
    }
  }, 90);
  scan.addEventListener('input', refilter);

  function resetSearch() {
    scan.value = '';
    state.filter = '';
    if (state.mode === 'search') loadProducts();
    else applyFilter();
    scan.focus();
  }

  scan.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' && scan.value) {
      e.preventDefault();
      return resetSearch();
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    if (!code) return;
    // A barcode scanner types the code and presses Enter at once: match it
    // exactly first, on screen, then anywhere in the catalogue.
    const exact = state.products.find((p) => (p.barcode && p.barcode === code) || p.barcodes?.includes(code));
    if (exact) {
      addToCart(exact);
      return resetSearch();
    }
    let notFound;
    try {
      addToCart(await api.lookup(code));
      return resetSearch();
    } catch (err) {
      notFound = err;
    }
    // Typed part of a name and only one product matches: Enter adds it.
    state.filter = code;
    if (code.length >= MIN_SEARCH && state.resultsFor !== code) await searchServer(code, { animate: false });
    if (scan.value.trim() !== code) return; // the cashier has moved on
    applyFilter({ animate: false });
    const visible = [...tiles.querySelectorAll('.tile:not([hidden])')];
    if (visible.length === 1) {
      addToCart(state.products.find((p) => p.id === Number(visible[0].dataset.add)));
      return resetSearch();
    }
    if (!visible.length) toast(errorText(notFound), 'error');
  });
  $('#clear-search').addEventListener('click', resetSearch);

  /* ----------------------------------------------------------------- cart -- */

  /** A line's discount is typed as a percentage; the invoice records it as money. */
  const lineDiscount = (l) => round2((l.qty * l.unit_price * Math.min(100, Math.max(0, Number(l.discountPct) || 0))) / 100);
  const lineTotal = (l) => Math.max(0, round2(l.qty * l.unit_price - lineDiscount(l)));

  function addToCart(product) {
    if (!product) return;
    const existing = state.cart.find((l) => l.product_id === product.id);
    if (existing) {
      // Scanning the same item again adds one to its line rather than a second
      // line, and brings that line back to the top where the cashier is looking.
      existing.qty = round2(existing.qty + 1);
      state.cart = [existing, ...state.cart.filter((l) => l !== existing)];
    } else {
      state.cart.unshift({
        product_id: product.id,
        name: product.name,
        unit: product.unit,
        unit_price: Number(product.price) || 0,
        stock: Number(product.stock) || 0,
        qty: 1,
        discountPct: 0,
      });
    }
    drawCart(product.id);
  }

  const lineOf = (el) => state.cart.find((l) => l.product_id === Number(el.closest('[data-line]')?.dataset.line));

  /** What the line comes to before its discount. */
  const lineGross = (l) => round2(l.qty * l.unit_price);

  /**
   * Selling at a price: the cashier types what the line should come to and the
   * discount follows. Above the full price there is nothing to discount, so the
   * unit price itself moves instead.
   */
  function setLineTotal(line, wanted) {
    const total = Math.max(0, round2(wanted));
    const gross = lineGross(line);
    if (total > gross && line.qty > 0) {
      line.unit_price = round2(total / line.qty);
      line.discountPct = 0;
      return;
    }
    line.discountPct = gross > 0 ? Math.min(100, ((gross - total) / gross) * 100) : 0;
  }

  /**
   * One compact line: name, total and remove on top; quantity, unit price and
   * discount underneath. The column names are shown once, above the list, rather
   * than repeated on every line. The chevron opens the line to sell it at a
   * price: type what it should come to, and the discount is worked out.
   */
  function lineHtml(l) {
    return `<div class="cart-line ${l.open ? 'open' : ''}" data-line="${l.product_id}">
      <div class="cl-top">
        <button class="cl-toggle" data-toggle title="${esc(t(l.open ? 'pos.line_close' : 'pos.line_open'))}"
                aria-expanded="${l.open ? 'true' : 'false'}">${icon('chevron')}</button>
        <div class="cl-name" title="${esc(l.name)}">${esc(l.name)}</div>
        <span class="cl-short" data-stock ${l.qty > l.stock ? '' : 'hidden'}
              title="${esc(t('pos.on_hand', { q: qtyText(l.stock), u: l.unit }))}">${esc(t('pos.low_badge'))}</span>
        <span class="cl-totals"><span class="cl-total" data-total>${money(lineTotal(l))}</span>${money2Html(lineTotal(l), { cls: 'cl-total2' })}</span>
        <button class="cl-remove" data-remove title="${esc(t('pos.remove_line'))}">${icon('trash')}</button>
      </div>
      <div class="cl-fields">
        <div class="cl-field">
          <div class="qty-box">
            <button type="button" data-step="-1" title="${esc(t('pos.less'))}">−</button>
            <input type="number" step="any" min="0" value="${l.qty}" data-field="qty"
                   aria-label="${esc(t('common.qty'))}"/>
            <button type="button" data-step="1" title="${esc(t('pos.more'))}">+</button>
          </div>
        </div>
        <div class="cl-field">
          <input class="input" type="number" step="0.01" min="0" value="${l.unit_price}" data-field="unit_price"
                 aria-label="${esc(t('pos.unit_price'))}" title="${esc(t('pos.unit_price'))}"/>
        </div>
        <div class="cl-field">
          <div class="pct-box">
            <input class="input" type="number" step="any" min="0" max="100" value="${pctValue(l)}"
                   placeholder="${esc(t('pos.discount_pct'))}" data-field="discount"
                   aria-label="${esc(t('pos.discount_pct'))}" title="${esc(t('pos.discount_pct'))}"/>
            <span aria-hidden="true">%</span>
          </div>
        </div>
      </div>
      <div class="cl-detail">
        <label class="cl-field">
          <span>${esc(t('pos.line_total'))}</span>
          <input class="input" type="number" step="0.01" min="0" value="${lineTotal(l)}" data-field="total"
                 aria-label="${esc(t('pos.line_total'))}"/>
        </label>
        <label class="cl-field">
          <span>${esc(t('pos.discount_amount'))}</span>
          <div class="input readonly" data-discount>${money(lineDiscount(l))}</div>
        </label>
      </div>
    </div>`;
  }

  // A percentage the cashier did not type reads better rounded: 33.33, not 33.333333.
  const pctValue = (l) => (l.discountPct ? Math.round(l.discountPct * 100) / 100 : '');

  const linesHeader = () => `<div class="cl-head">
      <span>${esc(t('common.qty'))}</span>
      <span>${esc(t('pos.unit_price'))}</span>
      <span>${esc(t('pos.discount_pct'))}</span>
    </div>`;

  function drawCart(highlightId) {
    const count = state.cart.length;
    $('#cart-count').textContent = t('pos.item_count', { n: count });
    linesEl.innerHTML = count
      ? linesHeader() + state.cart.map(lineHtml).join('')
      : emptyState(t('pos.cart_empty'), t('pos.cart_empty_sub'), 'cart');

    if (highlightId) {
      const el = linesEl.querySelector(`[data-line="${highlightId}"]`);
      el?.classList.add('flash');
      linesEl.scrollTop = 0;
    }
    paintTotals();
  }

  /** Only the numbers that depend on the line, so typing never loses its place. */
  function repaintLine(line, typedIn = null) {
    const el = linesEl.querySelector(`[data-line="${line.product_id}"]`);
    if (!el) return;
    // Every field follows the others, except the one being typed in.
    const set = (field, value) => {
      const input = el.querySelector(`[data-field="${field}"]`);
      if (input && input !== typedIn && document.activeElement !== input) input.value = value;
    };
    set('total', lineTotal(line));
    set('discount', pctValue(line));
    set('unit_price', line.unit_price);
    set('qty', line.qty);
    el.querySelector('[data-discount]').textContent = money(lineDiscount(line));
    el.querySelector('[data-total]').textContent = money(lineTotal(line));
    const total2 = el.querySelector('.cl-total2');
    if (total2) {
      total2.dataset.base = lineTotal(line);
      total2.textContent = money2(lineTotal(line));
    }
    el.querySelector('[data-stock]').hidden = line.qty <= line.stock;
    paintTotals();
  }

  /** Cart totals before anything decided at payment (customer, invoice discount). */
  function cartTotals(invoiceDiscount = 0) {
    const subtotal = round2(state.cart.reduce((s, l) => s + lineTotal(l), 0));
    const discount = Math.min(Math.max(0, Number(invoiceDiscount) || 0), subtotal);
    const taxable = round2(subtotal - discount);
    const tax = round2((taxable * taxRate) / 100);
    return { subtotal, discount, tax, total: round2(taxable + tax) };
  }

  function paintTotals() {
    const tot = cartTotals();
    const lineDiscounts = round2(state.cart.reduce((s, l) => s + lineDiscount(l), 0));
    $('#totals').innerHTML = `
      ${
        lineDiscounts > 0
          ? `<div class="sum-row"><span>${esc(t('common.discount'))}</span><span class="v">−${money(
              lineDiscounts,
            )}</span></div>`
          : ''
      }
      ${
        taxRate
          ? `<div class="sum-row"><span>${esc(t('pos.tax_label', { r: taxRate }))}</span><span class="v">${money(
              tot.tax,
            )}</span></div>`
          : ''
      }
      <div class="sum-row total"><span>${esc(t('common.total'))}</span><span class="v">${money(tot.total)}</span></div>
      ${
        second()
          ? `<div class="sum-row total2"><span>${esc(t('pos.total_in', { c: second().symbol }))}</span><span class="v">${money2Html(tot.total)}</span></div>`
          : ''
      }`;

    const empty = state.cart.length === 0;
    $('#checkout').disabled = empty;
    $('#bar-checkout').disabled = empty;
    $('#bar-total').innerHTML = `${esc(money(tot.total))} ${money2Html(tot.total)}`;
    $('#bar-count').textContent = t('pos.item_count', { n: state.cart.length });
    $('#pos-bar').classList.toggle('has-items', !empty);
  }

  // Typing into a line updates that line in place.
  linesEl.addEventListener('input', (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    const line = lineOf(input);
    if (!line) return;
    const value = Math.max(0, Number(input.value) || 0);
    if (input.dataset.field === 'discount') line.discountPct = Math.min(100, value);
    else if (input.dataset.field === 'total') setLineTotal(line, value);
    else line[input.dataset.field] = value;
    repaintLine(line, input);
  });

  // A quantity left at zero once the cashier moves on means "take it off".
  linesEl.addEventListener('change', (e) => {
    const input = e.target.closest('[data-field="qty"]');
    if (!input) return;
    const line = lineOf(input);
    if (line && line.qty <= 0) {
      state.cart = state.cart.filter((l) => l !== line);
      drawCart();
    }
  });

  linesEl.addEventListener('focusin', (e) => {
    if (e.target.matches('input')) e.target.select();
  });

  linesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const line = lineOf(btn);
    if (!line) return;

    if (btn.hasAttribute('data-remove')) {
      state.cart = state.cart.filter((l) => l !== line);
      drawCart();
      return;
    }
    if (btn.hasAttribute('data-toggle')) {
      line.open = !line.open;
      const el = btn.closest('.cart-line');
      el.classList.toggle('open', line.open);
      btn.setAttribute('aria-expanded', String(line.open));
      btn.title = t(line.open ? 'pos.line_close' : 'pos.line_open');
      if (line.open) el.querySelector('[data-field="total"]').focus();
      return;
    }
    if (btn.dataset.step) {
      line.qty = round2(Math.max(0, line.qty + Number(btn.dataset.step)));
      if (line.qty <= 0) {
        state.cart = state.cart.filter((l) => l !== line);
        drawCart();
        return;
      }
      btn.closest('.qty-box').querySelector('input').value = line.qty;
      repaintLine(line);
    }
  });

  $('#clear-cart').addEventListener('click', () => {
    if (!state.cart.length) return;
    state.cart = [];
    state.draft = freshDraft();
    drawCart();
    scan.focus();
  });

  /* -------------------------------------------------------------- payment -- */

  /**
   * The payment dialog. Saving happens inside it, so a failure (a network blip,
   * a product that went missing) keeps the dialog and everything typed into it.
   * On success it closes with the saved sale.
   */
  async function openPayment() {
    if (!state.cart.length) return;
    const draft = state.draft;
    const cur = second();
    const base = store.settings.currency || '$';
    const lineDiscounts = round2(state.cart.reduce((s, l) => s + lineDiscount(l), 0));

    /** The invoice discount as money, whether it was typed as an amount or a percentage. */
    const invoiceDiscount = (value, mode) => {
      const v = Math.max(0, Number(value) || 0);
      return mode === 'percent' ? round2((cartTotals().subtotal * Math.min(v, 100)) / 100) : v;
    };

    let stopRate = () => {};
    const sale = await modal({
      title: t('pos.take_payment'),
      subtitle: t('pos.payment_sub', { n: state.cart.length, t: money(cartTotals().subtotal) }),
      wide: true,
      body: `
        <div class="pay-layout">
          <section class="pay-main">
            <div class="pay-due">
              <span class="pay-due-label">${esc(t('pos.amount_due'))}</span>
              <span class="amount"><span id="pay-due"></span><small class="pay-due2" id="pay-due2"></small></span>
            </div>

            ${
              cur
                ? `<div class="pay-tenders">
                    <div class="field">
                      <label>${esc(t('pos.received_in', { c: base }))}</label>
                      <div class="pay-input"><span class="pay-cur">${esc(base)}</span>
                        <input class="input pay-amount" id="pay-amount" type="number" step="0.01" min="0" autofocus/></div>
                    </div>
                    <div class="field">
                      <div class="pay-label-row">
                        <label for="pay-amount2">${esc(t('pos.received_in', { c: cur.symbol }))}</label>
                        <button type="button" class="btn btn-sm btn-ghost pay-all2" id="pay-all2">${esc(t('pos.all_in', { c: cur.symbol }))}</button>
                      </div>
                      <div class="pay-input"><span class="pay-cur">${esc(cur.symbol)}</span>
                        <input class="input pay-amount" id="pay-amount2" type="number" step="any" min="0" placeholder="0"/></div>
                    </div>
                  </div>
                  <div class="pay-rate" id="pay-rate"></div>`
                : `<div class="field">
                    <label>${esc(t('pos.amount_received'))}</label>
                    <div class="pay-input"><span class="pay-cur">${esc(base)}</span>
                      <input class="input pay-amount" id="pay-amount" type="number" step="0.01" min="0" autofocus/></div>
                  </div>`
            }

            <div class="pay-result" id="pay-result"></div>
          </section>

          <aside class="pay-side">
            <div class="field">
              <label>${esc(t('common.customer'))}</label>
              <div class="combo"><input class="input" id="pay-customer" data-names="customer" value="${esc(
                draft.customer,
              )}" placeholder="${esc(t('common.walk_in'))}" autocomplete="off"/></div>
            </div>

            <div class="field">
              <label>${esc(t('pos.payment_method'))}</label>
              <div class="pay-methods" id="pay-method" role="radiogroup">
                ${methodOptions()
                  .map(
                    // The mark or the method's own logo, with its name beside it.
                    (o) => `<button type="button" role="radio" data-method="${o.value}"
                              class="${o.value === draft.method ? 'active' : ''} ${o.logo ? 'has-logo' : ''}"
                              aria-checked="${o.value === draft.method}" title="${esc(o.label)}">
                              ${methodMark(o.icon)}<span>${esc(o.label)}</span></button>`,
                  )
                  .join('')}
              </div>
            </div>

            <div class="pay-summary">
              <div class="sum-row"><span>${esc(t('common.subtotal'))}</span><span class="v">${money(cartTotals().subtotal)}</span></div>
              ${
                lineDiscounts > 0
                  ? `<div class="sum-row muted"><span>${esc(t('pos.line_discounts'))}</span><span class="v">−${money(lineDiscounts)}</span></div>`
                  : ''
              }
              <div class="sum-row">
                <span>${esc(t('pos.invoice_discount'))}</span>
                <span class="v pay-discount-box">
                  <input class="input sum-input" id="pay-discount" type="number" step="0.01" min="0"
                         value="${draft.discountInput || ''}" placeholder="${esc(draft.discountMode === 'percent' ? t('pos.discount_pct') : '0.00')}"/>
                  <span class="seg seg-sm" id="pay-discount-mode">
                    <button type="button" data-mode="amount" class="${draft.discountMode !== 'percent' ? 'active' : ''}">${esc(base)}</button>
                    <button type="button" data-mode="percent" class="${draft.discountMode === 'percent' ? 'active' : ''}">%</button>
                  </span>
                </span>
              </div>
              ${taxRate ? `<div class="sum-row"><span>${esc(t('pos.tax_label', { r: taxRate }))}</span><span class="v" id="pay-tax"></span></div>` : ''}
              <div class="sum-row total"><span>${esc(t('common.total'))}</span><span class="v" id="pay-total"></span></div>
            </div>

            <div class="field">
              <label>${esc(t('pos.note_optional'))}</label>
              <input class="input" id="pay-note" value="${esc(draft.note)}" placeholder="${esc(t('pos.note_placeholder'))}" autocomplete="off"/>
            </div>
          </aside>
        </div>`,
      footer: `<div class="spacer"></div>
               <button class="btn" data-close>${esc(t('common.cancel'))}</button>
               <button class="btn btn-primary btn-lg" id="pay-confirm">${icon('check')} ${esc(t('pos.confirm_sale'))}</button>`,
      setup: (dialog, close) => {
        const $d = (sel) => dialog.querySelector(sel);
        const amount = $d('#pay-amount');
        const amount2 = $d('#pay-amount2'); // only when a second currency is on
        let amountTouched = false;
        let mode = draft.discountMode === 'percent' ? 'percent' : 'amount';

        const current = () => cartTotals(invoiceDiscount($d('#pay-discount').value, mode));
        const received2 = () => (amount2 && second() ? toBase(amount2.value) : 0);
        const received = () => round2((Number(amount.value) || 0) + received2());
        // A second-currency amount beside a first-currency one.
        const both = (v) => `${esc(money(v))}${second() ? ` <small class="money2">${esc(money2(v))}</small>` : ''}`;

        const paint = () => {
          const tot = current();
          $d('#pay-due').textContent = money(tot.total);
          $d('#pay-due2').textContent = second() ? money2(tot.total) : '';
          $d('#pay-total').textContent = money(tot.total);
          if ($d('#pay-tax')) $d('#pay-tax').textContent = money(tot.tax);
          // Until the cashier types a first-currency amount, it covers whatever the
          // second-currency notes do not.
          if (!amountTouched) amount.value = Math.max(0, round2(tot.total - received2())).toFixed(2);
          const c = second();
          if ($d('#pay-rate') && c) {
            $d('#pay-rate').textContent = t('pos.rate_line', { a: `1 ${base}`, b: `${c.rate.toLocaleString()} ${c.symbol}` });
          }

          const diff = round2(received() - tot.total);
          const result = $d('#pay-result');
          if (diff > 0.004) {
            result.className = 'pay-result change';
            result.innerHTML = `<span>${icon('coins')} ${esc(t('receipt.change'))}</span><span class="amount">${both(diff)}</span>`;
          } else if (diff < -0.004) {
            result.className = 'pay-result owing';
            result.innerHTML = `<span>${icon('alert')} ${esc(t('pay.remaining'))}</span><span class="amount">${both(-diff)}</span>`;
          } else {
            result.className = 'pay-result settled';
            result.innerHTML = `<span>${icon('check')} ${esc(t('pay.settled_now'))}</span><span class="amount">${money(0)}</span>`;
          }
        };

        // Remember what was typed, so closing and reopening the dialog keeps it.
        const keepDraft = () => {
          draft.customer = $d('#pay-customer').value;
          draft.method = $d('#pay-method [data-method].active')?.dataset.method || 'cash';
          draft.discountMode = mode;
          draft.discountInput = Math.max(0, Number($d('#pay-discount').value) || 0);
          draft.discount = invoiceDiscount(draft.discountInput, mode);
          draft.note = $d('#pay-note').value;
        };

        wireNamePickers(dialog);
        $d('#pay-customer').addEventListener('change', keepDraft);
        ['#pay-customer', '#pay-note'].forEach((sel) => $d(sel).addEventListener('input', keepDraft));

        $d('#pay-method').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-method]');
          if (!btn) return;
          $d('#pay-method').querySelectorAll('[data-method]').forEach((b) => {
            b.classList.toggle('active', b === btn);
            b.setAttribute('aria-checked', String(b === btn));
          });
          keepDraft();
        });

        $d('#pay-discount').addEventListener('input', () => {
          keepDraft();
          paint();
        });
        $d('#pay-discount-mode').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-mode]');
          if (!btn || btn.dataset.mode === mode) return;
          mode = btn.dataset.mode;
          $d('#pay-discount-mode').querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
          $d('#pay-discount').placeholder = mode === 'percent' ? t('pos.discount_pct') : '0.00';
          $d('#pay-discount').step = mode === 'percent' ? '1' : '0.01';
          keepDraft();
          paint();
          $d('#pay-discount').focus();
        });

        amount.addEventListener('input', () => {
          amountTouched = true;
          paint();
        });
        const confirmOnEnter = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            $d('#pay-confirm').click();
          }
        };
        amount.addEventListener('keydown', confirmOnEnter);
        if (amount2) {
          amount2.addEventListener('input', paint);
          amount2.addEventListener('keydown', confirmOnEnter);
          // The whole invoice in the second currency.
          $d('#pay-all2').addEventListener('click', () => {
            amount2.value = toSecond(current().total);
            amountTouched = true;
            amount.value = '0';
            paint();
            amount2.focus();
          });
        }
        // The rate changed while the dialog was open (another till, the sidebar).
        stopRate = onRateChange(paint);

        $d('#pay-confirm').addEventListener('click', async () => {
          const btn = $d('#pay-confirm');
          if (btn.disabled) return;
          keepDraft();
          btn.disabled = true;
          // Audio must be unlocked inside the click, before the save is awaited.
          primeAudio();
          try {
            const saved = await api.createSale({
              customer: draft.customer.trim(),
              method: draft.method,
              discount: draft.discount,
              ...(amount2 && second()
                ? {
                    tenders: [
                      { currency: 'base', amount: Math.max(0, Number(amount.value) || 0) },
                      { currency: 'second', amount: Math.max(0, Number(amount2.value) || 0) },
                    ],
                  }
                : { paid: Math.max(0, Number(amount.value) || 0) }),
              note: draft.note.trim(),
              items: state.cart.map((l) => ({
                product_id: l.product_id,
                qty: l.qty,
                unit_price: l.unit_price,
                discount: lineDiscount(l),
              })),
            });
            saved.change = saved.change ?? round2(Math.max(0, received() - saved.total));
            close(saved);
          } catch (err) {
            toast(errorText(err), 'error');
            btn.disabled = false;
          }
        });

        paint();
      },
    });

    stopRate();
    if (!sale) return; // cancelled: the cart and the draft are left exactly as they were

    if (sale.shortages?.length) {
      toast(t('pos.shortage', { names: sale.shortages.map((s) => s.name).join(', ') }), 'warn', 5200);
    }
    if (sale.customer) forgetSuggestions('customer');

    state.cart = [];
    state.draft = freshDraft();
    drawCart();
    loadProducts();

    playSaleChime();
    await celebrateSale(sale);

    // Then the document: print it, or close it and carry on selling.
    await showReceipt(sale, { change: sale.change, change2: sale.change2, afterSale: true });
    scan.focus();
  }

  $('#checkout').addEventListener('click', openPayment);
  $('#bar-checkout').addEventListener('click', openPayment);

  ctx.actions.innerHTML = `<span class="muted hide-mobile" style="font-size:12.5px">${esc(
    t('pos.hint'),
  )} <span class="kbd">Enter</span></span>`;

  await loadProducts();
  drawCart();
  scan.focus();

  // Switching the second currency on or off redraws the prices; a new rate
  // alone is handled by the live amounts themselves.
  const stopWatching = onRateChange(() => {
    drawTiles();
    applyFilter({ animate: false });
    paintTotals();
  });

  // main.js calls this when navigating away.
  return () => {
    window.removeEventListener('scroll', onScroll);
    stopWatching();
  };
}
