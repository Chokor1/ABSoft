import { api } from '../api.js';
import { attachPicker } from '../picker.js';
import { productOption } from '../product-option.js';
import { wireNamePickers } from '../name-picker.js';
import { icon } from '../icons.js';
import { PAYMENT_METHODS, errorText, methodText, t } from '../i18n.js';
import {
  debounce,
  emptyState,
  esc,
  forgetSuggestions,
  modal,
  money,
  productThumb,
  qtyText,
  store,
  toast,
} from '../ui.js';
import { showReceipt } from './sales.js';
import { celebrateSale, playSaleChime, primeAudio } from '../feedback.js';

const methodOptions = () => PAYMENT_METHODS.map((m) => ({ value: m, label: methodText(m) }));
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
    draft: { customer: '', method: 'cash', discount: 0, note: '' },
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

  async function loadProducts() {
    tiles.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>${esc(t('pos.loading_products'))}</p></div>`;
    state.products = await api.products({ search: state.filter });
    drawTiles();
  }

  function drawTiles() {
    if (!state.products.length) {
      tiles.innerHTML = `<div style="grid-column:1/-1">${emptyState(
        state.filter ? t('pos.no_match') : t('pos.no_products'),
        state.filter ? t('pos.no_match_sub') : t('pos.no_products_sub'),
        'box',
      )}</div>`;
      return;
    }
    tiles.innerHTML = state.products
      .map(
        (p) => `<button class="tile ${p.stock <= 0 ? 'out' : ''} ${p.image_at ? 'has-image' : ''}" data-add="${p.id}" ${
          p.description ? `title="${esc(p.description)}"` : ''
        }>
          ${p.image_at ? productThumb(p, 'tile') : ''}
          <div class="t-name">${esc(p.name)}</div>
          ${p.description ? `<div class="t-desc">${esc(p.description)}</div>` : ''}
          <div class="t-meta">
            <span class="t-price">${money(p.price)}</span>
            <span class="t-stock">${qtyText(p.stock)} ${esc(p.unit)}</span>
          </div>
        </button>`,
      )
      .join('');
  }

  tiles.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (btn) addToCart(state.products.find((p) => p.id === Number(btn.dataset.add)));
  });

  const search = debounce(() => {
    state.filter = scan.value.trim();
    loadProducts();
  }, 220);

  scan.addEventListener('input', search);

  // Results drop down under the box as you type; the tile grid filters alongside.
  const picker = attachPicker(scan, {
    search: (q) => (q ? api.products({ search: q, limit: 25 }) : []),
    render: productOption,
    emptyText: t('pos.no_match'),
    openOnFocus: false,
    onPick: (product) => {
      addToCart(product);
      resetSearch();
    },
  });

  function resetSearch() {
    // Cancel any search still in flight, so its results cannot reopen the menu
    // over the next scan.
    picker.reset();
    scan.value = '';
    state.filter = '';
    loadProducts();
    scan.focus();
  }

  scan.addEventListener('keydown', async (e) => {
    // The picker consumes Enter when something is highlighted.
    if (e.key !== 'Enter' || (picker.isOpen() && picker.activeItem())) return;
    e.preventDefault();
    const code = scan.value.trim();
    if (!code) return;
    try {
      // A barcode scanner types the code then hits Enter before any search has
      // returned, so resolve the exact code straight to the cart.
      addToCart(await api.lookup(code));
      resetSearch();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
  $('#clear-search').addEventListener('click', () => {
    picker.close();
    resetSearch();
  });

  /* ----------------------------------------------------------------- cart -- */

  const lineTotal = (l) => Math.max(0, round2(l.qty * l.unit_price - l.discount));

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
        discount: 0,
      });
    }
    drawCart(product.id);
  }

  const lineOf = (el) => state.cart.find((l) => l.product_id === Number(el.closest('[data-line]')?.dataset.line));

  /**
   * One compact line: name, total and remove on top; quantity, unit price and
   * discount underneath. The column names are shown once, above the list, rather
   * than repeated on every line.
   */
  function lineHtml(l) {
    return `<div class="cart-line" data-line="${l.product_id}">
      <div class="cl-top">
        <div class="cl-name" title="${esc(l.name)}">${esc(l.name)}</div>
        <span class="cl-short" data-stock ${l.qty > l.stock ? '' : 'hidden'}
              title="${esc(t('pos.on_hand', { q: qtyText(l.stock), u: l.unit }))}">${esc(t('pos.low_badge'))}</span>
        <span class="cl-total" data-total>${money(lineTotal(l))}</span>
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
          <input class="input" type="number" step="0.01" min="0" value="${l.discount || ''}" placeholder="0.00"
                 data-field="discount" aria-label="${esc(t('common.discount'))}" title="${esc(t('common.discount'))}"/>
        </div>
      </div>
    </div>`;
  }

  const linesHeader = () => `<div class="cl-head">
      <span>${esc(t('common.qty'))}</span>
      <span>${esc(t('pos.unit_price'))}</span>
      <span>${esc(t('common.discount'))}</span>
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
  function repaintLine(line) {
    const el = linesEl.querySelector(`[data-line="${line.product_id}"]`);
    if (!el) return;
    el.querySelector('[data-total]').textContent = money(lineTotal(line));
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
    const lineDiscounts = round2(state.cart.reduce((s, l) => s + Math.min(l.discount, l.qty * l.unit_price), 0));
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
      <div class="sum-row total"><span>${esc(t('common.total'))}</span><span class="v">${money(tot.total)}</span></div>`;

    const empty = state.cart.length === 0;
    $('#checkout').disabled = empty;
    $('#bar-checkout').disabled = empty;
    $('#bar-total').textContent = money(tot.total);
    $('#bar-count').textContent = t('pos.item_count', { n: state.cart.length });
    $('#pos-bar').classList.toggle('has-items', !empty);
  }

  // Typing into a line updates that line in place.
  linesEl.addEventListener('input', (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    const line = lineOf(input);
    if (!line) return;
    line[input.dataset.field] = Math.max(0, Number(input.value) || 0);
    repaintLine(line);
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
    state.draft = { customer: '', method: 'cash', discount: 0, note: '' };
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
    const initial = cartTotals(draft.discount);

    const sale = await modal({
      title: t('pos.take_payment'),
      subtitle: t('pos.payment_sub', { n: state.cart.length, t: money(initial.subtotal) }),
      body: `
        <div class="pay-form">
          <div class="form-grid">
            <div class="field">
              <label>${esc(t('common.customer'))}</label>
              <div class="combo"><input class="input" id="pay-customer" data-names="customer" value="${esc(
                draft.customer,
              )}" placeholder="${esc(t('common.walk_in'))}" autocomplete="off"/></div>
            </div>
            <div class="field">
              <label>${esc(t('pos.payment_method'))}</label>
              <select class="select" id="pay-method">
                ${methodOptions()
                  .map(
                    (o) =>
                      `<option value="${o.value}" ${o.value === draft.method ? 'selected' : ''}>${esc(o.label)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>

          <div class="pay-due">
            <span>${esc(t('pos.amount_due'))}</span>
            <span class="amount" id="pay-due"></span>
          </div>

          <div class="field">
            <label>${esc(t('pos.amount_received'))}</label>
            <input class="input pay-amount" id="pay-amount" type="number" step="0.01" min="0" autofocus/>
          </div>

          <div class="pay-result" id="pay-result"></div>

          <div class="pay-summary">
            <div class="sum-row"><span>${esc(t('common.subtotal'))}</span>
              <span class="v">${money(initial.subtotal)}</span></div>
            <div class="sum-row">
              <span>${esc(t('pos.invoice_discount'))}</span>
              <span class="v"><input class="input sum-input" id="pay-discount" type="number" step="0.01" min="0"
                value="${draft.discount || ''}" placeholder="0.00"/></span>
            </div>
            ${
              taxRate
                ? `<div class="sum-row"><span>${esc(t('pos.tax_label', { r: taxRate }))}</span>
                     <span class="v" id="pay-tax"></span></div>`
                : ''
            }
          </div>

          <div class="field">
            <label>${esc(t('pos.note_optional'))}</label>
            <input class="input" id="pay-note" value="${esc(draft.note)}" placeholder="${esc(
              t('pos.note_placeholder'),
            )}" autocomplete="off"/>
          </div>
        </div>`,
      footer: `<button class="btn" data-close>${esc(t('common.cancel'))}</button>
               <button class="btn btn-primary btn-lg" id="pay-confirm">${icon('check')} ${esc(
                 t('pos.confirm_sale'),
               )}</button>`,
      setup: (dialog, close) => {
        const $d = (sel) => dialog.querySelector(sel);
        const amount = $d('#pay-amount');
        let amountTouched = false;

        const current = () => cartTotals($d('#pay-discount').value);

        const paint = () => {
          const tot = current();
          $d('#pay-due').textContent = money(tot.total);
          if ($d('#pay-tax')) $d('#pay-tax').textContent = money(tot.tax);
          // Until the cashier types an amount, it follows what is due.
          if (!amountTouched) amount.value = tot.total.toFixed(2);

          const diff = round2((Number(amount.value) || 0) - tot.total);
          const result = $d('#pay-result');
          if (diff > 0.004) {
            result.className = 'pay-result change';
            result.innerHTML = `<span>${esc(t('receipt.change'))}</span><span class="amount">${money(diff)}</span>`;
          } else if (diff < -0.004) {
            result.className = 'pay-result owing';
            result.innerHTML = `<span>${esc(t('pay.remaining'))}</span><span class="amount">${money(-diff)}</span>`;
          } else {
            result.className = 'pay-result settled';
            result.innerHTML = `<span>${esc(t('pay.settled_now'))}</span><span class="amount">${money(0)}</span>`;
          }
        };

        // Remember what was typed, so closing and reopening the dialog keeps it.
        const keepDraft = () => {
          draft.customer = $d('#pay-customer').value;
          draft.method = $d('#pay-method').value;
          draft.discount = Math.max(0, Number($d('#pay-discount').value) || 0);
          draft.note = $d('#pay-note').value;
        };

        wireNamePickers(dialog);
        $d('#pay-customer').addEventListener('change', keepDraft);
        $d('#pay-discount').addEventListener('input', () => {
          keepDraft();
          paint();
        });
        ['#pay-customer', '#pay-method', '#pay-note'].forEach((sel) =>
          $d(sel).addEventListener('input', keepDraft),
        );
        amount.addEventListener('input', () => {
          amountTouched = true;
          paint();
        });
        amount.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            $d('#pay-confirm').click();
          }
        });

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
              paid: Math.max(0, Number(amount.value) || 0),
              note: draft.note.trim(),
              items: state.cart.map((l) => ({
                product_id: l.product_id,
                qty: l.qty,
                unit_price: l.unit_price,
                discount: l.discount,
              })),
            });
            saved.change = round2(Math.max(0, (Number(amount.value) || 0) - saved.total));
            close(saved);
          } catch (err) {
            toast(errorText(err), 'error');
            btn.disabled = false;
          }
        });

        paint();
      },
    });

    if (!sale) return; // cancelled: the cart and the draft are left exactly as they were

    if (sale.shortages?.length) {
      toast(t('pos.shortage', { names: sale.shortages.map((s) => s.name).join(', ') }), 'warn', 5200);
    }
    if (sale.customer) forgetSuggestions('customer');

    state.cart = [];
    state.draft = { customer: '', method: 'cash', discount: 0, note: '' };
    drawCart();
    loadProducts();

    playSaleChime();
    await celebrateSale(sale);

    // Then the document: print it, or close it and carry on selling.
    await showReceipt(sale, { change: sale.change, afterSale: true });
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

  // main.js calls this when navigating away.
  return () => picker.destroy();
}
