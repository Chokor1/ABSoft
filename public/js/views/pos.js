import { api } from '../api.js';
import { icon } from '../icons.js';
import { PAYMENT_METHODS, errorText, methodText, t } from '../i18n.js';
import { debounce, emptyState, esc, formModal, money, qtyText, store, toast } from '../ui.js';
import { showReceipt } from './sales.js';

const methodOptions = () => PAYMENT_METHODS.map((m) => ({ value: m, label: methodText(m) }));

export async function render(root, ctx) {
  const state = {
    products: [],
    filter: '',
    cart: [],
    discount: 0,
  };

  const taxRate = Number(store.settings.tax_rate) || 0;

  root.innerHTML = `
    <div class="pos">
      <section>
        <div class="scan-bar">
          <div class="input-icon">
            ${icon('barcode')}
            <input class="input" id="scan" data-search placeholder="${esc(
              t('pos.scan_placeholder'),
            )}" autocomplete="off"/>
          </div>
          <button class="btn" id="clear-search">${esc(t('pos.clear'))}</button>
        </div>
        <div id="tiles" class="product-grid"></div>
      </section>

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
          <div class="form-grid" style="gap:9px;margin-bottom:12px">
            <div class="field">
              <label>${esc(t('common.customer'))}</label>
              <input class="input" id="customer" placeholder="${esc(t('common.walk_in'))}" autocomplete="off"/>
            </div>
            <div class="field">
              <label>${esc(t('sales.payment'))}</label>
              <select class="select" id="method">
                ${methodOptions()
                  .map((o) => `<option value="${o.value}">${esc(o.label)}</option>`)
                  .join('')}
              </select>
            </div>
          </div>
          <div id="totals"></div>
          <button class="btn btn-primary btn-lg btn-block" id="checkout" style="margin-top:12px" disabled>
            ${icon('check')} ${esc(t('pos.complete'))}
          </button>
        </div>
      </aside>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const tiles = $('#tiles');
  const scan = $('#scan');

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
        (p) => `<button class="tile ${p.stock <= 0 ? 'out' : ''}" data-add="${p.id}" ${
          p.description ? `title="${esc(p.description)}"` : ''
        }>
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
  scan.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    if (!code) return;
    try {
      // A barcode scanner types the code then hits Enter — resolve it straight to the cart.
      const product = await api.lookup(code);
      addToCart(product);
      scan.value = '';
      state.filter = '';
      loadProducts();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
  $('#clear-search').addEventListener('click', () => {
    scan.value = '';
    state.filter = '';
    loadProducts();
    scan.focus();
  });

  /* ----------------------------------------------------------------- cart -- */

  function addToCart(product, quantity = 1) {
    if (!product) return;
    const line = state.cart.find((l) => l.product_id === product.id);
    if (line) line.qty += quantity;
    else
      state.cart.push({
        product_id: product.id,
        name: product.name,
        unit: product.unit,
        unit_price: Number(product.price) || 0,
        stock: Number(product.stock) || 0,
        qty: quantity,
        discount: 0,
      });
    drawCart();
  }

  function drawCart() {
    const lines = $('#cart-lines');
    $('#cart-count').textContent = t('pos.item_count', { n: state.cart.length });

    if (!state.cart.length) {
      lines.innerHTML = emptyState(t('pos.cart_empty'), t('pos.cart_empty_sub'), 'cart');
    } else {
      lines.innerHTML = state.cart
        .map(
          (l, i) => `<div class="cart-line">
            <div class="cl-name">${esc(l.name)}${
              l.qty > l.stock ? ` <span class="badge danger">${esc(t('pos.low_badge'))}</span>` : ''
            }</div>
            <div class="cl-total">${money(l.qty * l.unit_price - l.discount)}</div>
            <div class="cl-controls">
              <div class="qty-box">
                <button data-dec="${i}" title="${esc(t('pos.less'))}">−</button>
                <input type="number" step="any" min="0" value="${l.qty}" data-qty="${i}"/>
                <button data-inc="${i}" title="${esc(t('pos.more'))}">+</button>
              </div>
              <span class="cl-price">× ${money(l.unit_price)}${l.discount ? ` − ${money(l.discount)}` : ''}</span>
            </div>
            <div style="display:flex;gap:4px;justify-content:flex-end">
              <button class="cl-remove" data-edit="${i}" title="${esc(t('pos.edit_line'))}">${icon('edit')}</button>
              <button class="cl-remove" data-del="${i}" title="${esc(t('pos.remove_line'))}">${icon('trash')}</button>
            </div>
          </div>`,
        )
        .join('');
    }
    drawTotals();
  }

  function totals() {
    const subtotal = state.cart.reduce((s, l) => s + l.qty * l.unit_price - l.discount, 0);
    const discount = Math.min(Math.max(0, state.discount), subtotal);
    const taxable = subtotal - discount;
    const tax = (taxable * taxRate) / 100;
    return { subtotal, discount, tax, total: taxable + tax };
  }

  function drawTotals() {
    const tot = totals();
    $('#totals').innerHTML = `
      <div class="sum-row"><span>${esc(t('common.subtotal'))}</span><span class="v">${money(tot.subtotal)}</span></div>
      <div class="sum-row">
        <span>${esc(t('common.discount'))}</span>
        <span class="v"><input class="input" id="discount" type="number" step="0.01" min="0" value="${
          state.discount || ''
        }" placeholder="0.00" style="width:110px;height:30px;text-align:end;padding:4px 9px"/></span>
      </div>
      ${
        taxRate
          ? `<div class="sum-row"><span>${esc(t('pos.tax_label', { r: taxRate }))}</span><span class="v">${money(
              tot.tax,
            )}</span></div>`
          : ''
      }
      <div class="sum-row total"><span>${esc(t('common.total'))}</span><span class="v">${money(tot.total)}</span></div>`;

    $('#discount').addEventListener('change', (e) => {
      state.discount = Number(e.target.value) || 0;
      drawTotals();
    });
    $('#checkout').disabled = state.cart.length === 0;
  }

  $('#cart-lines').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { inc, dec, del, edit } = btn.dataset;
    if (inc !== undefined) state.cart[+inc].qty += 1;
    if (dec !== undefined) state.cart[+dec].qty = Math.max(0, state.cart[+dec].qty - 1);
    if (del !== undefined) state.cart.splice(+del, 1);
    if (inc !== undefined || dec !== undefined) state.cart = state.cart.filter((l) => l.qty > 0);
    if (edit !== undefined) return editLine(+edit);
    drawCart();
  });

  $('#cart-lines').addEventListener('change', (e) => {
    const input = e.target.closest('[data-qty]');
    if (!input) return;
    const value = Number(input.value);
    state.cart[+input.dataset.qty].qty = value > 0 ? value : 0;
    state.cart = state.cart.filter((l) => l.qty > 0);
    drawCart();
  });

  async function editLine(index) {
    const line = state.cart[index];
    const data = await formModal({
      title: line.name,
      subtitle: t('pos.on_hand', { q: qtyText(line.stock), u: line.unit }),
      submitLabel: t('pos.update_line'),
      fields: [
        { name: 'qty', label: t('common.quantity'), type: 'number', step: 'any', min: 0, value: line.qty, autofocus: true },
        { name: 'unit_price', label: t('pos.unit_price'), type: 'number', step: '0.01', min: 0, value: line.unit_price },
        {
          name: 'discount',
          label: t('pos.line_discount'),
          type: 'number',
          step: '0.01',
          min: 0,
          value: line.discount,
          span: 2,
        },
      ],
    });
    if (!data) return;
    line.qty = Math.max(0, Number(data.qty) || 0);
    line.unit_price = Math.max(0, Number(data.unit_price) || 0);
    line.discount = Math.max(0, Number(data.discount) || 0);
    state.cart = state.cart.filter((l) => l.qty > 0);
    drawCart();
  }

  $('#clear-cart').addEventListener('click', () => {
    if (!state.cart.length) return;
    state.cart = [];
    state.discount = 0;
    drawCart();
    scan.focus();
  });

  /* ------------------------------------------------------------- checkout -- */

  $('#checkout').addEventListener('click', async () => {
    const tot = totals();
    const data = await formModal({
      title: t('pos.take_payment'),
      subtitle: t('pos.payment_sub', { n: state.cart.length, t: money(tot.total) }),
      submitLabel: t('pos.confirm_sale'),
      fields: [
        {
          type: 'static',
          span: 2,
          html: `<div class="pnl" style="margin-bottom:4px">
            <div class="pnl-row"><span>${esc(t('common.subtotal'))}</span><span class="v">${money(
              tot.subtotal,
            )}</span></div>
            ${
              tot.discount
                ? `<div class="pnl-row"><span>${esc(t('common.discount'))}</span><span class="v">−${money(
                    tot.discount,
                  )}</span></div>`
                : ''
            }
            ${
              taxRate
                ? `<div class="pnl-row"><span>${esc(t('common.tax'))}</span><span class="v">${money(tot.tax)}</span></div>`
                : ''
            }
            <div class="pnl-row final"><span>${esc(t('pos.amount_due'))}</span><span class="v">${money(
              tot.total,
            )}</span></div>
          </div>`,
        },
        {
          name: 'paid',
          label: t('pos.amount_received'),
          type: 'number',
          step: '0.01',
          min: 0,
          value: tot.total.toFixed(2),
          autofocus: true,
        },
        { name: 'method', label: t('pos.payment_method'), type: 'select', value: $('#method').value, options: methodOptions() },
        { name: 'note', label: t('pos.note_optional'), type: 'text', span: 2, placeholder: t('pos.note_placeholder') },
      ],
    });
    if (!data) return;

    try {
      const sale = await api.createSale({
        customer: $('#customer').value.trim(),
        discount: state.discount,
        method: data.method,
        paid: Number(data.paid) || 0,
        note: data.note,
        items: state.cart.map((l) => ({
          product_id: l.product_id,
          qty: l.qty,
          unit_price: l.unit_price,
          discount: l.discount,
        })),
      });

      const change = (Number(data.paid) || 0) - sale.total;
      toast(
        change > 0.004
          ? t('pos.completed_change', { doc: sale.doc_no, t: money(sale.total), c: money(change) })
          : t('pos.completed', { doc: sale.doc_no, t: money(sale.total) }),
        'success',
      );
      if (sale.shortages?.length) {
        toast(t('pos.shortage', { names: sale.shortages.map((s) => s.name).join(', ') }), 'warn', 5200);
      }

      state.cart = [];
      state.discount = 0;
      $('#customer').value = '';
      drawCart();
      loadProducts();
      scan.focus();
      showReceipt(sale, { change });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  ctx.actions.innerHTML = `<span class="muted" style="font-size:12.5px">${esc(
    t('pos.hint'),
  )} <span class="kbd">Enter</span></span>`;

  await loadProducts();
  drawCart();
  scan.focus();
}
