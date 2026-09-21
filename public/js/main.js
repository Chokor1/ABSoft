import { api, setUnauthorizedHandler } from './api.js';
import { icon } from './icons.js';
import { LANGUAGES, applyDocumentLang, errorText, lang, roleText, setLang, t } from './i18n.js';
import { dateTimeText, esc, formModal, initials, loadPaymentMethods, modal, store, toast } from './ui.js';

import * as dashboard from './views/dashboard.js';
import * as pos from './views/pos.js';
import * as products from './views/products.js';
import * as purchases from './views/purchases.js';
import * as adjustments from './views/adjustments.js';
import * as stockCount from './views/stock-count.js';
import { sweepPickers } from './picker.js';
import { onRateChange, saveRate, second, watchRate } from './currency.js';
import * as salesView from './views/sales.js';
import * as expenses from './views/expenses.js';
import * as reports from './views/reports.js';
import * as lists from './views/lists.js';
import * as users from './views/users.js';
import * as settings from './views/settings.js';
import * as shifts from './views/shifts.js';

/**
 * Route table. Titles are keys so the whole shell re-labels on a language switch.
 * Administrators see everything; a cashier only the screens marked `cashier`
 * (the server enforces the same split).
 */
const VIEWS = {
  dashboard: { key: 'dashboard', icon: 'dashboard', mod: dashboard, group: 'overview' },
  // Not in the menu: the POS button in the top bar (or F2) opens it.
  pos: { key: 'pos', icon: 'pos', mod: pos, group: 'daily', cashier: true, hidden: true },
  sales: { key: 'sales', icon: 'receipt', mod: salesView, group: 'daily', cashier: true },
  // The till's shifts, listed only once shifts are switched on in Settings.
  shifts: { key: 'shifts', icon: 'history', mod: shifts, group: 'daily', cashier: true, when: () => store.settings.pos_shifts === '1' },
  purchases: { key: 'purchases', icon: 'truck', mod: purchases, group: 'daily' },
  expenses: { key: 'expenses', icon: 'wallet', mod: expenses, group: 'daily' },
  products: { key: 'products', icon: 'box', mod: products, group: 'stock' },
  'stock-count': { key: 'stockcount', icon: 'clipboard', mod: stockCount, group: 'stock' },
  adjustments: { key: 'adjustments', icon: 'adjust', mod: adjustments, group: 'stock' },
  lists: { key: 'lists', icon: 'users', mod: lists, group: 'catalogue' },
  // Sales Analysis lives in Reports now; old links still land there.
  analysis: {
    key: 'reports',
    icon: 'chart',
    group: 'reports',
    hidden: true,
    bare: true,
    mod: {
      render: (root, ctx) => {
        ctx.navigate(['reports', 'analysis', ...ctx.params].join('/'));
      },
    },
  },
  // Reports put their menu, dates and buttons on one line of their own, so the
  // screen header would only repeat what the menu already says.
  reports: { key: 'reports', icon: 'chart', mod: reports, group: 'reports', bare: true },
  users: { key: 'users', icon: 'users', mod: users, group: 'settings' },
  settings: { key: 'settings', icon: 'settings', mod: settings, group: 'settings', cashier: true },
};

const isAdmin = () => store.user?.role === 'admin';
const canSee = (view) => isAdmin() || !!view.cashier;
const homeRoute = () => (isAdmin() ? 'dashboard' : 'pos');

const GROUPS = ['overview', 'daily', 'stock', 'catalogue', 'reports', 'settings'];
const SHORTCUTS = { pos: 'F2', products: 'F3', purchases: 'F4', expenses: 'F5' };

const app = document.getElementById('app');
localStorage.removeItem('absoft-nav'); // left over from the collapsible sidebar
let cleanup = null;

/* ------------------------------------------------------------------ theme -- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('absoft-theme', theme);
}
applyTheme(localStorage.getItem('absoft-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
const isDark = () => document.documentElement.dataset.theme === 'dark';
const toggleTheme = () => applyTheme(isDark() ? 'light' : 'dark');

/* ------------------------------------------------------------- fullscreen -- */

const isFullscreen = () => !!document.fullscreenElement;

/** Browsers only allow this from a user gesture, so it is always button/key driven. */
async function toggleFullscreen() {
  try {
    if (isFullscreen()) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Denied (an iframe without permission, or the user dismissed it) — nothing to do.
  }
}

function paintFullscreenButton() {
  const btn = document.getElementById('fullscreen-toggle');
  if (!btn) return;
  btn.innerHTML = icon(isFullscreen() ? 'minimize' : 'maximize');
  btn.title = t(isFullscreen() ? 'common.exit_fullscreen' : 'common.fullscreen');
}
document.addEventListener('fullscreenchange', paintFullscreenButton);

/* --------------------------------------------------------------- language -- */

/** Switch language and rebuild whatever is on screen, keeping the route. */
export function switchLanguage(next) {
  if (next === lang) return;
  setLang(next);
  if (store.user) startApp();
  else renderLogin();
}

const languagePicker = (current) =>
  `<div class="seg lang-picker">${LANGUAGES.map(
    (l) => `<button type="button" data-lang="${l.code}" class="${l.code === current ? 'active' : ''}"
              lang="${l.code}" title="${esc(l.label)}"><span class="lang-full">${esc(
                l.native,
              )}</span><span class="lang-short">${esc(l.short)}</span></button>`,
  ).join('')}</div>`;

const wireLanguagePicker = (root) =>
  root.querySelectorAll('[data-lang]').forEach((b) =>
    b.addEventListener('click', () => switchLanguage(b.dataset.lang)),
  );

/* ------------------------------------------------------------------ login -- */

function renderLogin(message = '') {
  applyDocumentLang();
  app.className = '';
  app.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <div class="login-brand">
          <div class="mark"><img src="/img/logo-mark.svg" alt="ABSoft" /></div>
          <div><h1>${esc(t('app.brand'))} <span class="brand-product">${esc(t('app.product'))}</span></h1><span>${esc(t('app.tagline'))}</span></div>
        </div>
        <div class="form-grid" style="grid-template-columns:minmax(0,1fr)">
          <div class="field">
            <label>${esc(t('login.username'))}</label>
            <input class="input" name="username" autocomplete="username" autofocus required placeholder="admin"/>
          </div>
          <div class="field">
            <label>${esc(t('login.password'))}</label>
            <input class="input" type="password" name="password" autocomplete="current-password" required placeholder="••••••••"/>
          </div>
        </div>
        <div id="login-error" style="color:var(--danger);font-size:13px;min-height:20px;margin-top:10px">${esc(message)}</div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">${esc(t('login.submit'))}</button>
        <div class="login-hint">${esc(t('login.hint'))}</div>
        <div class="login-foot">
          ${languagePicker(lang)}
          <span class="credit">${esc(t('app.author'))}</span>
        </div>
      </form>
    </div>`;

  wireLanguagePicker(app);

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = t('login.submitting');
    try {
      const { user, settings: cfg, restart_needed, version } = await api.login(form.username.value, form.password.value);
      store.user = user;
      store.settings = cfg;
      store.restartNeeded = !!restart_needed;
    store.version = version || '';
      startApp();
    } catch (err) {
      document.getElementById('login-error').textContent = errorText(err);
      form.password.value = '';
      form.password.focus();
      btn.disabled = false;
      btn.textContent = t('login.submit');
    }
  });
}

/* ------------------------------------------------------------------ shell -- */

/** Groups shown as one item that opens to reveal its screens, rather than a heading. */
const FOLDING = { stock: 'box' };
const FOLD_KEY = (group) => `absoft-nav-${group}`;

/**
 * The letterhead every printed page carries: the shop's logo and name at the
 * top, and at the foot the software that printed it. Redrawn whenever the
 * settings change, so a new logo is on the next printout.
 */
function paintPrintFrame() {
  const head = document.getElementById('print-head');
  const foot = document.getElementById('print-foot');
  if (!head || !foot) return;
  const logo = store.settings.store_logo;
  head.innerHTML = `
    ${logo ? `<img class="print-logo" src="${esc(logo)}" alt="" />` : ''}
    <div class="print-store">
      <strong>${esc(store.settings.store_name || t('app.name'))}</strong>
      ${store.settings.receipt_footer ? `<small>${esc(store.settings.receipt_footer)}</small>` : ''}
    </div>
    <div class="spacer"></div>
    <div class="print-when">${esc(dateTimeText(new Date().toISOString().slice(0, 19).replace('T', ' ')))}</div>`;
  foot.innerHTML = `<img src="/img/logo-mark.svg" alt="" />
    <span>${esc(t('print.by', { v: store.version || '' }))}</span>`;
}

function navHtml() {
  const link = ([route, v], cls = '') => `<a class="nav-item ${cls}" href="#/${route}" data-route="${route}">
      ${icon(v.icon)}<span>${esc(t(`nav.${v.key}`))}</span>
      ${SHORTCUTS[route] && canSee(v) ? `<span class="kbd">${SHORTCUTS[route]}</span>` : ''}
    </a>`;
  return GROUPS.map((group) => {
    const items = Object.entries(VIEWS).filter(([, v]) => v.group === group && canSee(v) && !v.hidden && (!v.when || v.when()));
    if (!items.length) return '';
    if (FOLDING[group]) {
      // Open unless it was folded away on this device.
      let open = true;
      try {
        open = localStorage.getItem(FOLD_KEY(group)) !== '0';
      } catch {
        /* storage blocked: open */
      }
      return `<div class="nav-fold ${open ? 'open' : ''}" data-fold="${group}">
        <button type="button" class="nav-item nav-parent" aria-expanded="${open}" data-fold-toggle="${group}">
          ${icon(FOLDING[group])}<span>${esc(t(`nav.group.${group}`))}</span>
          <span class="nav-chevron" aria-hidden="true"></span>
        </button>
        <div class="nav-children"><div>${items.map((item) => link(item, 'nav-child')).join('')}</div></div>
      </div>`;
    }
    return `<div class="nav-label">${esc(t(`nav.group.${group}`))}</div>${items.map((item) => link(item)).join('')}`;
  }).join('');
}

/** Fold or unfold a menu group, and remember it on this device. */
function setFold(fold, open) {
  fold.classList.toggle('open', open);
  fold.querySelector('[data-fold-toggle]').setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem(FOLD_KEY(fold.dataset.fold), open ? '1' : '0');
  } catch {
    /* storage blocked: it just will not be remembered */
  }
}

function renderShell() {
  applyDocumentLang();
  app.className = '';
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <a class="mark" href="#/${isAdmin() ? 'dashboard' : 'sales'}" title="${esc(t(isAdmin() ? 'nav.dashboard' : 'nav.sales'))}"
             aria-label="${esc(t(isAdmin() ? 'nav.dashboard' : 'nav.sales'))}"><img src="/img/logo-mark.svg" alt="ABSoft" /></a>
          <div class="brand-text"><strong>${esc(t('app.brand'))} <span class="brand-product">${esc(t('app.product'))}</span>${
            store.version ? ` <span class="brand-version" title="${esc(t('app.version', { v: store.version }))}">v${esc(store.version)}</span>` : ''
          }</strong><small>${esc(
            store.settings.store_name || t('app.tagline'),
          )}</small></div>
        </div>
        <nav class="nav">${navHtml()}</nav>
        <div class="rate-box" id="rate-box" hidden></div>
        <div class="sidebar-foot">
          <button class="user-chip" id="user-menu">
            <div class="avatar">${esc(initials(store.user.full_name || store.user.username))}</div>
            <div style="min-width:0">
              <strong>${esc(store.user.full_name || store.user.username)}</strong>
              <small>${esc(roleText(store.user.role))}</small>
            </div>
          </button>
          <div class="credit">${esc(t('app.author'))}</div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon only-mobile" id="nav-toggle">${icon('menu')}</button>
          <a class="mark topbar-mark" href="#/${isAdmin() ? 'dashboard' : 'sales'}" title="${esc(t(isAdmin() ? 'nav.dashboard' : 'nav.sales'))}"
             aria-label="${esc(t(isAdmin() ? 'nav.dashboard' : 'nav.sales'))}"><img src="/img/logo-mark.svg" alt="ABSoft" /></a>
          <div class="spacer"></div>
          <a class="btn btn-primary topbar-pos" id="go-pos" href="#/pos" title="${esc(t('nav.pos.sub'))} (F2)">${icon('pos')} ${esc(t('nav.pos'))}</a>
          ${languagePicker(lang)}
          <button class="btn btn-ghost btn-icon theme-toggle" id="fullscreen-toggle"></button>
          <button class="btn btn-ghost btn-icon theme-toggle" id="theme-toggle" title="${esc(t('menu.toggle_theme'))}">
            ${icon(isDark() ? 'sun' : 'moon')}
          </button>
        </header>
        <main class="page" id="page"></main>
      </div>
    </div>`;

  // The screen's own header: its name, what it is for and its buttons. It is not
  // part of the top bar (that holds what belongs to the whole app); it sits in the
  // screen's filter bar, or at the top of the screen when there is none.
  pageHead = document.createElement('div');
  pageHead.className = 'page-head';
  pageHead.id = 'page-head';
  pageHead.innerHTML = `
    <div class="page-head-title"><h2 id="page-title"></h2><div class="sub" id="page-sub"></div></div>
    <div class="spacer"></div>
    <div class="page-actions" id="page-actions"></div>`;
  pageActions = pageHead.querySelector('#page-actions');
  const page = app.querySelector('#page');
  // Screens redraw themselves; whenever that takes the header with it, put it back.
  new MutationObserver(() => placePageHead()).observe(page, { childList: true, subtree: true });

  wireLanguagePicker(app);
  paintRateBox();

  // Anything that sticks under the top bar needs its height, which changes when
  // it wraps on a narrow screen.
  const topbar = app.querySelector('.topbar');
  new ResizeObserver(() =>
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`),
  ).observe(topbar);

  paintFullscreenButton();
  document.getElementById('fullscreen-toggle').addEventListener('click', toggleFullscreen);
  document.getElementById('theme-toggle').addEventListener('click', (e) => {
    toggleTheme();
    e.currentTarget.innerHTML = icon(isDark() ? 'sun' : 'moon');
  });
  document.getElementById('user-menu').addEventListener('click', openUserMenu);
  document.getElementById('nav-toggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  // One listener for the whole menu, so it keeps working when the menu is redrawn.
  const nav = document.querySelector('nav.nav');
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a.nav-item')) document.getElementById('sidebar').classList.remove('open');
    const btn = e.target.closest('[data-fold-toggle]');
    if (btn) {
      const fold = btn.closest('.nav-fold');
      setFold(fold, !fold.classList.contains('open'));
    }
  });
  // A setting can add or remove a screen (shifts), so the menu is drawn again.
  window.addEventListener('absoft:settings', () => {
    paintPrintFrame();
    nav.innerHTML = navHtml();
    nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === currentRoute));
  });
}

async function openUserMenu() {
  const choice = await modal({
    title: store.user.full_name || store.user.username,
    subtitle: t('menu.signed_in_as', { role: roleText(store.user.role) }),
    body: `<div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 14px">
        <button class="btn btn-block" data-pick="password" style="justify-content:flex-start">${icon('key')} ${esc(
          t('menu.change_password'),
        )}</button>
        <button class="btn btn-block" data-pick="theme" style="justify-content:flex-start">${icon('moon')} ${esc(
          t('menu.toggle_theme'),
        )}</button>
        <button class="btn btn-block btn-danger" data-pick="logout" style="justify-content:flex-start">${icon(
          'logout',
        )} ${esc(t('menu.sign_out'))}</button>
      </div>`,
    setup: (root, close) =>
      root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => close(b.dataset.pick))),
  });

  if (choice === 'theme') {
    toggleTheme();
    document.getElementById('theme-toggle').innerHTML = icon(isDark() ? 'sun' : 'moon');
  } else if (choice === 'logout') {
    await api.logout();
    store.user = null;
    renderLogin();
  } else if (choice === 'password') {
    await changePassword();
  }
}

async function changePassword() {
  const data = await formModal({
    title: t('pw.title'),
    submitLabel: t('pw.submit'),
    fields: [
      { name: 'current_password', label: t('pw.current'), type: 'password', required: true, span: 2, autofocus: true },
      { name: 'new_password', label: t('pw.new'), type: 'password', required: true },
      { name: 'confirm', label: t('pw.confirm'), type: 'password', required: true },
    ],
  });
  if (!data) return;
  if (data.new_password !== data.confirm) return toast(t('pw.mismatch'), 'error');
  try {
    await api.changePassword(data.current_password, data.new_password);
    toast(t('pw.updated'), 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

/* ----------------------------------------------------------------- router -- */

const routeKey = () => {
  const key = location.hash.replace(/^#\/?/, '').split('/')[0].toLowerCase();
  if (VIEWS[key] && canSee(VIEWS[key])) return key;
  // Not a screen this user has: land on their home and say so in the address bar.
  history.replaceState(null, '', `#/${homeRoute()}`);
  return homeRoute();
};

let pageHead = null;
let pageActions = null;
let currentRoute = '';

/**
 * Put the screen's header where it belongs: first row of the screen's filter bar
 * (the sticky toolbar a list or report opens with), otherwise the top of the
 * screen. The POS has none: it keeps every pixel for selling.
 */
function placePageHead() {
  const page = document.getElementById('page');
  if (!pageHead || !page) return;
  // The POS and the reports keep every pixel for what they show.
  if (currentRoute === 'pos' || VIEWS[currentRoute]?.bare) {
    pageHead.remove();
    return;
  }
  const bar = page.querySelector('.sticky-bar:not(.product-hero)');
  const target = bar || page;
  if (pageHead.parentElement === target && target.firstElementChild === pageHead) return;
  target.prepend(pageHead);
}

/**
 * One screen at a time. Screens load their data before painting, so two quick
 * moves (a link followed by another) could otherwise overlap and the slower one
 * paint over the newer screen. Renders are queued, and a screen already
 * overtaken is dropped rather than drawn.
 */
let renderSeq = 0;
let renderQueue = Promise.resolve();
function renderRoute() {
  const seq = ++renderSeq;
  renderQueue = renderQueue.then(() => (seq === renderSeq ? drawRoute() : undefined));
  return renderQueue;
}

async function drawRoute() {
  const route = routeKey();
  const view = VIEWS[route];
  currentRoute = route;

  pageHead.remove();
  // A screen may take the buttons into a bar of its own (the reports do); they
  // come back to the header before the next screen is drawn.
  pageHead.append(pageActions);
  pageActions.innerHTML = '';
  pageHead.querySelector('#page-title').textContent = t(`nav.${view.key}`);
  pageHead.querySelector('#page-sub').textContent = t(`nav.${view.key}.sub`);
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  // The POS folds the sidebar away, so the exchange rate moves up into the top bar.
  const rateBox = document.getElementById('rate-box');
  if (rateBox) {
    if (route === 'pos') document.getElementById('go-pos').before(rateBox);
    else document.querySelector('.sidebar-foot').before(rateBox);
  }
  // A screen inside a folded group opens the group, so you can see where you are.
  document.querySelectorAll('.nav-fold').forEach((fold) => {
    const holds = !!fold.querySelector(`[data-route="${route}"]`);
    fold.classList.toggle('has-active', holds);
    if (holds && !fold.classList.contains('open')) setFold(fold, true);
  });

  const page = document.getElementById('page');
  page.innerHTML = `<div class="empty"><p>${esc(t('common.loading'))}</p></div>`;
  // A new screen starts at its top, not where the last one was scrolled to.
  window.scrollTo(0, 0);

  try {
    cleanup?.();
    cleanup = null;
    sweepPickers();
    cleanup = await view.mod.render(page, {
      actions: pageActions,
      navigate: (to) => (location.hash = `#/${to}`),
      params: location.hash.replace(/^#\/?/, '').split('/').slice(1),
    });
  } catch (err) {
    // A route missing on the server means the server is older than these screens.
    if (err?.code === 'NO_ROUTE') {
      showRestartNotice();
      page.innerHTML = `<div class="card"><div class="card-body"><div class="empty">${icon('alert')}
        <strong>${esc(t('app.restart_title'))}</strong><p>${esc(t('app.restart_body'))}</p></div></div></div>`;
      return;
    }
    page.innerHTML = `<div class="card"><div class="card-body"><div class="empty">${icon('alert')}
      <strong>${esc(t('common.page_error'))}</strong><p>${esc(errorText(err))}</p></div></div></div>`;
  }
  placePageHead();
}

/* ---------------------------------------------------------- exchange rate -- */

/**
 * The rate of the second currency, in the sidebar. Everyone sees it; an
 * administrator can change it in place: one field, Enter or Save, and every
 * amount on screen follows.
 */
function paintRateBox(editing = false) {
  const box = document.getElementById('rate-box');
  if (!box) return;
  const cur = second();
  box.hidden = !cur;
  if (!cur) return;
  const base = store.settings.currency || '$';
  const rateText = cur.rate.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const canEdit = store.user?.role === 'admin';

  if (!editing) {
    box.innerHTML = `
      <div class="rate-label">${icon('coins')} ${esc(t('rate.title'))}</div>
      <div class="rate-row">
        <div class="rate-value" dir="ltr">1 ${esc(base)} = <b>${esc(rateText)}</b> ${esc(cur.symbol)}</div>
        ${canEdit ? `<button class="btn btn-ghost btn-icon btn-sm" id="rate-edit" title="${esc(t('rate.edit'))}">${icon('edit')}</button>` : ''}
      </div>`;
    box.querySelector('#rate-edit')?.addEventListener('click', () => paintRateBox(true));
    return;
  }

  box.innerHTML = `
    <div class="rate-label">${icon('coins')} ${esc(t('rate.title'))}</div>
    <form class="rate-form" id="rate-form" dir="ltr">
      <span class="muted">1 ${esc(base)} =</span>
      <input class="input" id="rate-input" type="number" min="0" step="any" value="${cur.rate}" required
             aria-label="${esc(t('rate.title'))}"/>
      <span class="muted">${esc(cur.symbol)}</span>
      <button class="btn btn-primary btn-icon btn-sm" type="submit" title="${esc(t('common.save'))}">${icon('check')}</button>
      <button class="btn btn-ghost btn-icon btn-sm" type="button" id="rate-cancel" title="${esc(t('common.cancel'))}">${icon('close')}</button>
    </form>`;
  const input = box.querySelector('#rate-input');
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      paintRateBox(false);
    }
  });
  box.querySelector('#rate-cancel').addEventListener('click', () => paintRateBox(false));
  box.querySelector('#rate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = Number(input.value);
    if (!(value > 0)) return toast(t('err.RATE_POSITIVE'), 'warn');
    try {
      await saveRate(value);
      toast(t('rate.saved', { a: `1 ${base}`, b: `${value.toLocaleString()} ${cur.symbol}` }), 'success');
      paintRateBox(false);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

// Keep the box in step with rate changes made anywhere (settings page, another till).
onRateChange(() => {
  if (!document.querySelector('#rate-form')) paintRateBox(false);
});

function startApp() {
  watchRate();
  // The ways to pay belong to the shop; every screen reads the same list.
  loadPaymentMethods();
  renderShell();
  paintPrintFrame();
  renderRoute();
  window.onhashchange = renderRoute;
  if (store.restartNeeded) showRestartNotice();
}

/**
 * The files on disk are newer than the running server: an update was pulled but
 * ABSoft POS was not restarted, so new screens would call routes that do not exist yet.
 */
function showRestartNotice() {
  if (document.querySelector('.restart-notice')) return;
  const bar = document.createElement('div');
  bar.className = 'restart-notice';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = `${icon('alert')}<span><b>${esc(t('app.restart_title'))}</b> ${esc(t('app.restart_body'))}</span>`;
  document.querySelector('.topbar')?.after(bar);
}

document.addEventListener('keydown', (e) => {
  if (!store.user) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && /input|textarea|select/i.test(target.tagName);
  const shortcut = Object.entries(SHORTCUTS).find(([route, k]) => k === e.key && canSee(VIEWS[route]));
  if (shortcut && !document.querySelector('.modal-backdrop')) {
    e.preventDefault();
    location.hash = `#/${shortcut[0]}`;
    return;
  }
  if (e.key === '/' && !typing && !document.querySelector('.modal-backdrop')) {
    const search = document.querySelector('input[data-search]');
    if (search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  }
});

setUnauthorizedHandler(() => {
  store.user = null;
  renderLogin(t('err.SESSION_EXPIRED'));
});

(async function boot() {
  try {
    const { user, settings: cfg, restart_needed, version } = await api.me();
    store.user = user;
    store.settings = cfg;
    store.restartNeeded = !!restart_needed;
    store.version = version || '';
    startApp();
  } catch {
    renderLogin();
  }
})();

export const refreshRoute = renderRoute;
