import { api, setUnauthorizedHandler } from './api.js';
import { icon } from './icons.js';
import { LANGUAGES, applyDocumentLang, errorText, lang, roleText, setLang, t } from './i18n.js';
import { esc, formModal, initials, modal, store, toast } from './ui.js';

import * as dashboard from './views/dashboard.js';
import * as pos from './views/pos.js';
import * as products from './views/products.js';
import * as purchases from './views/purchases.js';
import * as salesView from './views/sales.js';
import * as expenses from './views/expenses.js';
import * as reports from './views/reports.js';
import * as lists from './views/lists.js';
import * as users from './views/users.js';
import * as settings from './views/settings.js';

/** Route table. Titles are keys so the whole shell re-labels on a language switch. */
const VIEWS = {
  dashboard: { key: 'dashboard', icon: 'dashboard', mod: dashboard, group: 'overview' },
  pos: { key: 'pos', icon: 'pos', mod: pos, group: 'daily' },
  purchases: { key: 'purchases', icon: 'truck', mod: purchases, group: 'daily' },
  expenses: { key: 'expenses', icon: 'wallet', mod: expenses, group: 'daily' },
  products: { key: 'products', icon: 'box', mod: products, group: 'catalogue' },
  lists: { key: 'lists', icon: 'users', mod: lists, group: 'catalogue' },
  sales: { key: 'sales', icon: 'receipt', mod: salesView, group: 'reports' },
  reports: { key: 'reports', icon: 'chart', mod: reports, group: 'reports' },
  users: { key: 'users', icon: 'users', mod: users, group: 'settings', adminOnly: true },
  settings: { key: 'settings', icon: 'settings', mod: settings, group: 'settings' },
};

const GROUPS = ['overview', 'daily', 'catalogue', 'reports', 'settings'];
const SHORTCUTS = { pos: 'F2', products: 'F3', purchases: 'F4', expenses: 'F5' };

const app = document.getElementById('app');
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
          <div class="mark">AB</div>
          <div><h1>${esc(t('app.name'))}</h1><span>${esc(t('app.tagline'))}</span></div>
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
      const { user, settings: cfg } = await api.login(form.username.value, form.password.value);
      store.user = user;
      store.settings = cfg;
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

function navHtml() {
  return GROUPS.map((group) => {
    const items = Object.entries(VIEWS).filter(
      ([, v]) => v.group === group && (!v.adminOnly || store.user.role === 'admin'),
    );
    if (!items.length) return '';
    return `<div class="nav-label">${esc(t(`nav.group.${group}`))}</div>${items
      .map(
        ([route, v]) => `<a class="nav-item" href="#/${route}" data-route="${route}">
            ${icon(v.icon)}<span>${esc(t(`nav.${v.key}`))}</span>
            ${SHORTCUTS[route] ? `<span class="kbd">${SHORTCUTS[route]}</span>` : ''}
          </a>`,
      )
      .join('')}`;
  }).join('');
}

function renderShell() {
  applyDocumentLang();
  app.className = '';
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="mark">AB</div>
          <div><strong>${esc(t('app.name'))}</strong><small>${esc(store.settings.store_name || t('app.tagline'))}</small></div>
        </div>
        <nav class="nav">${navHtml()}</nav>
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
          <div class="topbar-title"><h2 id="page-title"></h2><div class="sub" id="page-sub"></div></div>
          <div class="spacer"></div>
          <div class="page-actions" id="page-actions"></div>
          ${languagePicker(lang)}
          <button class="btn btn-ghost btn-icon theme-toggle" id="fullscreen-toggle"></button>
          <button class="btn btn-ghost btn-icon theme-toggle" id="theme-toggle" title="${esc(t('menu.toggle_theme'))}">
            ${icon(isDark() ? 'sun' : 'moon')}
          </button>
        </header>
        <main class="page" id="page"></main>
      </div>
    </div>`;

  wireLanguagePicker(app);
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
  document.querySelectorAll('.nav-item').forEach((a) =>
    a.addEventListener('click', () => document.getElementById('sidebar').classList.remove('open')),
  );
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
  const key = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard').toLowerCase();
  return VIEWS[key] && (!VIEWS[key].adminOnly || store.user?.role === 'admin') ? key : 'dashboard';
};

async function renderRoute() {
  const route = routeKey();
  const view = VIEWS[route];

  document.getElementById('page-title').textContent = t(`nav.${view.key}`);
  document.getElementById('page-sub').textContent = t(`nav.${view.key}.sub`);
  document.getElementById('page-actions').innerHTML = '';
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === route));

  const page = document.getElementById('page');
  page.innerHTML = `<div class="empty"><p>${esc(t('common.loading'))}</p></div>`;

  try {
    cleanup?.();
    cleanup = null;
    cleanup = await view.mod.render(page, {
      actions: document.getElementById('page-actions'),
      navigate: (to) => (location.hash = `#/${to}`),
      params: location.hash.replace(/^#\/?/, '').split('/').slice(1),
    });
  } catch (err) {
    page.innerHTML = `<div class="card"><div class="card-body"><div class="empty">${icon('alert')}
      <strong>${esc(t('common.page_error'))}</strong><p>${esc(errorText(err))}</p></div></div></div>`;
  }
}

function startApp() {
  renderShell();
  renderRoute();
  window.onhashchange = renderRoute;
}

document.addEventListener('keydown', (e) => {
  if (!store.user) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && /input|textarea|select/i.test(target.tagName);
  const shortcut = Object.entries(SHORTCUTS).find(([, k]) => k === e.key);
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
    const { user, settings: cfg } = await api.me();
    store.user = user;
    store.settings = cfg;
    startApp();
  } catch {
    renderLogin();
  }
})();

export const refreshRoute = renderRoute;
