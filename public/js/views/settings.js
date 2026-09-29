import { api } from '../api.js';
import { playSaleChime, setSoundEnabled, setTileImages, soundEnabled, tileImagesEnabled } from '../feedback.js';
import { icon } from '../icons.js';
import { LANGUAGES, errorText, lang, t } from '../i18n.js';
import { dateTimeText, esc, money, number, shrinkImage, store, toast } from '../ui.js';
import { applySettings, money2 } from '../currency.js';

const kb = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Settings, a section at a time: the store, the till, search, the second
 * currency, language, backups and about. A cashier sees the sections that
 * concern their own till; the shop-wide ones are for administrators.
 *
 *   #/settings/<section>
 */
const SECTIONS = [
  { key: 'store', icon: 'settings' },
  { key: 'pos', icon: 'pos' },
  { key: 'search', icon: 'search', admin: true },
  { key: 'currency', icon: 'coins' },
  { key: 'language', icon: 'globe' },
  { key: 'backup', icon: 'database', admin: true },
  { key: 'about', icon: 'info' },
];

export async function render(root, ctx) {
  const isAdmin = store.user.role === 'admin';
  const sections = SECTIONS.filter((s) => isAdmin || !s.admin);
  const wanted = ctx.params[0];
  const active = sections.some((s) => s.key === wanted) ? wanted : 'store';
  const [cfg, sys] = await Promise.all([api.settings(), api.system()]);
  const off = isAdmin ? '' : 'disabled';

  const saveBar = () =>
    isAdmin
      ? `<div class="card-head set-foot"><div class="spacer"></div>
           <button class="btn btn-primary" type="submit">${icon('check')} ${esc(t('set.save'))}</button></div>`
      : `<div class="card-body" style="padding-top:0"><p class="muted">${esc(t('set.admin_only'))}</p></div>`;

  const panels = {
    store: () => `
      <form class="card" id="settings-form">
        <div class="card-head"><div><h3>${esc(t('set.store'))}</h3>
          <div class="sub">${esc(t('set.store_sub'))}</div></div></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field span-2">
              <label>${esc(t('set.logo'))}</label>
              <div class="logo-pick">
                <div class="logo-preview" id="logo-preview">${
                  cfg.store_logo ? `<img src="${esc(cfg.store_logo)}" alt=""/>` : icon('image')
                }</div>
                <div class="logo-pick-text">
                  <div class="help">${esc(t('set.logo_help'))}</div>
                  <div class="logo-pick-buttons">
                    <button type="button" class="btn btn-sm" id="logo-choose" ${off}>${icon('upload')} ${esc(t('set.logo_choose'))}</button>
                    <button type="button" class="btn btn-sm btn-ghost" id="logo-clear" ${cfg.store_logo ? '' : 'hidden'} ${off}>${esc(t('common.remove'))}</button>
                  </div>
                </div>
                <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden/>
                <input type="hidden" name="store_logo" value="${esc(cfg.store_logo)}"/>
              </div>
            </div>
            <div class="field span-2">
              <label>${esc(t('set.store_name'))}</label>
              <input class="input" name="store_name" value="${esc(cfg.store_name)}" ${off}/>
            </div>
            <div class="field">
              <label>${esc(t('set.currency'))}</label>
              <input class="input" name="currency" value="${esc(cfg.currency)}" maxlength="4" ${off}/>
              <div class="help">${esc(t('set.currency_help'))}</div>
            </div>
            <div class="field">
              <label>${esc(t('set.tax_rate'))}</label>
              <input class="input" type="number" step="0.01" min="0" name="tax_rate" value="${esc(cfg.tax_rate)}" ${off}/>
              <div class="help">${esc(t('set.tax_help'))}</div>
            </div>
            <div class="field span-2">
              <label>${esc(t('set.receipt_footer'))}</label>
              <textarea class="input" name="receipt_footer" ${off}>${esc(cfg.receipt_footer)}</textarea>
            </div>
            <div class="field span-2">
              <label class="check">
                <input type="checkbox" name="low_stock_alert" ${cfg.low_stock_alert === '1' ? 'checked' : ''} ${off}/>
                ${esc(t('set.low_alert'))}
              </label>
            </div>
          </div>
        </div>
        ${saveBar()}
      </form>`,

    pos: () => `
      ${
        isAdmin
          ? `<form class="card" id="pos-form">
              <div class="card-head"><div><h3>${esc(t('set.shifts'))}</h3>
                <div class="sub">${esc(t('set.shifts_sub'))}</div></div></div>
              <div class="card-body">
                <label class="set-switch">
                  <input type="checkbox" name="pos_shifts" ${cfg.pos_shifts === '1' ? 'checked' : ''}/>
                  <span><b>${esc(t('set.shifts_enable'))}</b><small>${esc(t('set.shifts_help'))}</small></span>
                </label>
              </div>
              ${saveBar()}
            </form>`
          : ''
      }
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('set.till'))}</h3>
          <div class="sub">${esc(t('set.till_sub'))}</div></div></div>
        <div class="card-body" style="display:grid;gap:12px">
          <label class="set-switch">
            <input type="checkbox" id="sound-toggle" ${soundEnabled() ? 'checked' : ''}/>
            <span><b>${esc(t('set.sound'))}</b><small>${esc(t('set.sound_help'))}</small></span>
          </label>
          <label class="set-switch">
            <input type="checkbox" id="images-toggle" ${tileImagesEnabled() ? 'checked' : ''}/>
            <span><b>${esc(t('set.tile_images'))}</b><small>${esc(t('set.device_only'))}</small></span>
          </label>
          <div><button type="button" class="btn btn-sm" id="sound-test">${icon('check')} ${esc(t('set.sound_test'))}</button></div>
        </div>
      </div>`,

    search: () => `
      <form class="card" id="search-form">
        <div class="card-head"><div><h3>${esc(t('set.search'))}</h3>
          <div class="sub">${esc(t('set.search_sub'))}</div></div></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label>${esc(t('set.search_min'))}</label>
              <select class="select" name="search_min_chars">${[1, 2, 3, 4, 5]
                .map((n) => `<option value="${n}" ${String(n) === String(cfg.search_min_chars || 1) ? 'selected' : ''}>${esc(t('set.search_min_n', { n }))}</option>`)
                .join('')}</select>
              <div class="help">${esc(t('set.search_min_help'))}</div>
            </div>
            <div class="field">
              <label>${esc(t('set.page_size'))}</label>
              <select class="select" name="pos_page_size">${[20, 40, 60, 100, 200]
                .map((n) => `<option value="${n}" ${String(n) === String(cfg.pos_page_size || 40) ? 'selected' : ''}>${number(n)}</option>`)
                .join('')}</select>
              <div class="help">${esc(t('set.page_size_help'))}</div>
            </div>
          </div>
        </div>
        ${saveBar()}
      </form>`,

    currency: () => `
      <form class="card" id="currency2-form">
        <div class="card-head"><div><h3>${esc(t('set.currency2'))}</h3>
          <div class="sub">${esc(t('set.currency2_sub', { c: cfg.currency || '$' }))}</div></div></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field span-2">
              <label class="check">
                <input type="checkbox" name="currency2_enabled" ${cfg.currency2_enabled === '1' ? 'checked' : ''} ${off}/>
                ${esc(t('set.currency2_enable'))}
              </label>
            </div>
            <div class="field">
              <label>${esc(t('set.currency2_symbol'))}</label>
              <input class="input" name="currency2_symbol" value="${esc(cfg.currency2_symbol || 'L.L')}" maxlength="6" ${off}/>
            </div>
            <div class="field">
              <label>${esc(t('set.currency2_decimals'))}</label>
              <input class="input" type="number" min="0" max="4" step="1" name="currency2_decimals" value="${esc(cfg.currency2_decimals || '0')}" ${off}/>
            </div>
            <div class="field span-2">
              <label>${esc(t('set.currency2_rate', { c: cfg.currency || '$' }))}</label>
              <input class="input" type="number" min="0" step="any" name="currency2_rate" value="${esc(Number(cfg.currency2_rate) > 0 ? cfg.currency2_rate : '')}"
                     placeholder="89500" ${off}/>
              <div class="help" id="currency2-example"></div>
            </div>
          </div>
        </div>
        ${isAdmin ? saveBar() : ''}
      </form>`,

    language: () => `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('set.language'))}</h3></div></div>
        <div class="card-body">
          <div class="seg lang-picker" id="settings-lang" style="margin-bottom:10px">
            ${LANGUAGES.map(
              (l) => `<button type="button" data-lang="${l.code}" lang="${l.code}" class="${l.code === lang ? 'active' : ''}">${esc(l.native)}</button>`,
            ).join('')}
          </div>
          <p class="muted" style="font-size:12.5px">${esc(t('set.language_help'))}</p>
        </div>
      </div>`,

    backup: () => `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('set.backup'))}</h3>
          <div class="sub">${esc(t('set.backup_sub'))}</div></div></div>
        <div class="card-body">
          <div class="pnl" style="margin-bottom:14px">
            <div class="pnl-row"><span>${esc(t('set.db_size'))}</span><span class="v">${esc(kb(sys.db_size))}</span></div>
            <div class="pnl-row"><span>${esc(t('set.schema'))}</span><span class="v">v${number(sys.schema_version)}</span></div>
          </div>
          <p class="muted" style="font-size:12.5px;margin-bottom:14px">${esc(
            t('set.records', {
              p: number(sys.counts.products),
              s: number(sys.counts.sales),
              b: number(sys.counts.purchases),
              e: number(sys.counts.expenses),
            }),
          )}</p>
          <div style="display:flex;gap:9px;flex-wrap:wrap">
            <button class="btn btn-primary" id="backup-download">${icon('download')} ${esc(t('set.backup_download'))}</button>
            <button class="btn" id="backup-local">${icon('database')} ${esc(t('set.backup_local'))}</button>
          </div>
          <p class="muted" style="font-size:12px;margin-top:13px">${esc(t('set.backup_help'))}</p>
          <div id="backup-list" style="margin-top:14px"></div>
        </div>
      </div>
      <form class="card" id="backup-form" style="margin-top:16px">
        <div class="card-head"><div><h3>${esc(t('set.backup_auto'))}</h3>
          <div class="sub">${esc(t('set.backup_auto_sub'))}</div></div></div>
        <div class="card-body">
          <div class="pnl" style="margin-bottom:14px">
            <div class="pnl-row"><span>${esc(t('set.backup_last'))}</span><span class="v" id="backup-auto-status"></span></div>
          </div>
          <div class="form-grid">
            <div class="field span-2">
              <label for="backup-dir2">${esc(t('set.backup_dir2'))}</label>
              <input class="input" id="backup-dir2" name="backup_dir2" value="${esc(cfg.backup_dir2 || '')}"
                     placeholder="D:\\ABSoft backups" autocomplete="off" dir="ltr" spellcheck="false"/>
              <div class="help">${esc(t('set.backup_dir2_help'))}</div>
            </div>
          </div>
        </div>
        ${saveBar()}
      </form>`,

    about: () => `
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('set.about'))}</h3></div></div>
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:13px">
            <div class="about-mark" style="width:42px;height:42px;margin:0;border-radius:13px;font-size:15px"><img src="/img/logo-mark.svg" alt="ABSoft" /></div>
            <div>
              <div style="font-weight:650">${esc(t('app.name'))} — ${esc(t('app.tagline'))}</div>
              <div class="muted" style="font-size:12.5px">${esc(t('set.version', { v: sys.version }))} · Node ${esc(sys.node)}</div>
            </div>
          </div>
          <p style="margin-top:14px;font-weight:600">${esc(t('app.author'))}</p>
          <p class="muted" style="font-size:12px;margin-top:8px">${esc(t('set.update_hint'))}</p>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${esc(t('set.how_title'))}</h3></div></div>
        <div class="card-body">
          <div class="pnl" style="font-size:13.5px">
            <div class="pnl-row"><span>${esc(t('set.how_revenue'))}</span><span class="v muted">${esc(t('set.how_revenue_v'))}</span></div>
            <div class="pnl-row"><span>${esc(t('set.how_cogs'))}</span><span class="v muted">${esc(t('set.how_cogs_v'))}</span></div>
            <div class="pnl-row strong"><span>${esc(t('set.how_gross'))}</span><span class="v muted">${esc(t('set.how_gross_v'))}</span></div>
            <div class="pnl-row"><span>${esc(t('set.how_exp'))}</span><span class="v muted">${esc(t('set.how_exp_v'))}</span></div>
            <div class="pnl-row final"><span>${esc(t('set.how_net'))}</span><span class="v" style="font-size:15px">${esc(t('set.how_net_v'))}</span></div>
          </div>
          <p class="muted" style="margin-top:14px;font-size:12.5px">${esc(t('set.how_note'))}</p>
          <div class="pnl" style="margin-top:16px">
            <div class="pnl-row"><span>${esc(t('set.example_price'))}</span><span class="v">${money(10)}</span></div>
            <div class="pnl-row"><span>${esc(t('set.example_cost'))}</span><span class="v">${money(6)}</span></div>
            <div class="pnl-row"><span>${esc(t('set.example_profit'))}</span><span class="v money-pos">${money(4)}</span></div>
          </div>
        </div>
      </div>`,
  };

  // The sections sit in the page header, beside the title, as one row of tabs.
  ctx.actions.innerHTML = `
    <nav class="seg set-nav" id="set-nav">${sections
      .map(
        (s) => `<button type="button" class="set-nav-item ${s.key === active ? 'active' : ''}" data-section="${s.key}">
          ${icon(s.icon)}<span>${esc(t(`set.section.${s.key}`))}</span></button>`,
      )
      .join('')}</nav>`;
  ctx.actions.querySelector('#set-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-section]');
    if (btn && btn.dataset.section !== active) ctx.navigate(`settings/${btn.dataset.section}`);
  });
  root.innerHTML = `<div class="set-panel" id="set-panel">${panels[active]()}</div>`;

  /* ------------------------------------------------------------- wiring -- */

  const $ = (sel) => root.querySelector(sel);
  const save = async (patch, message = t('set.saved')) => {
    try {
      const saved = await api.saveSettings(patch);
      applySettings(saved);
      toast(message, 'success');
      return saved;
    } catch (err) {
      toast(errorText(err), 'error');
      return null;
    }
  };

  $('#settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    const form = e.target;
    const saved = await save({
      store_name: form.store_name.value.trim(),
      store_logo: form.store_logo.value,
      currency: form.currency.value.trim() || '$',
      tax_rate: form.tax_rate.value || '0',
      receipt_footer: form.receipt_footer.value.trim(),
      low_stock_alert: form.low_stock_alert.checked ? '1' : '0',
    });
    if (saved) document.querySelector('.brand small').textContent = saved.store_name || t('app.tagline');
  });

  // The logo: shrunk on this device before it is saved, so the shop's file size
  // never matters.
  const logoField = $('#settings-form [name=store_logo]');
  const setLogo = (data) => {
    logoField.value = data;
    $('#logo-preview').innerHTML = data ? `<img src="${esc(data)}" alt=""/>` : icon('image');
    $('#logo-clear').hidden = !data;
  };
  $('#logo-choose')?.addEventListener('click', () => $('#logo-file').click());
  $('#logo-clear')?.addEventListener('click', () => setLogo(''));
  $('#logo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setLogo(await shrinkImage(file, 420));
    } catch {
      toast(t('set.logo_failed'), 'error');
    }
  });

  $('#pos-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await save({ pos_shifts: e.target.pos_shifts.checked ? '1' : '0' });
  });

  $('#search-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await save({ search_min_chars: e.target.search_min_chars.value, pos_page_size: e.target.pos_page_size.value });
  });

  if ($('#sound-toggle')) {
    $('#sound-toggle').addEventListener('change', (e) => setSoundEnabled(e.target.checked));
    $('#images-toggle').addEventListener('change', (e) => setTileImages(e.target.checked));
    $('#sound-test').addEventListener('click', () => {
      const was = soundEnabled();
      setSoundEnabled(true);
      playSaleChime();
      setSoundEnabled(was);
    });
  }

  const c2 = $('#currency2-form');
  if (c2) {
    const example = () => {
      const rate = Number(c2.currency2_rate.value);
      const symbol = c2.currency2_symbol.value.trim() || 'L.L';
      c2.querySelector('#currency2-example').textContent =
        rate > 0 ? t('set.currency2_example', { a: money(10), b: `${(10 * rate).toLocaleString()} ${symbol}` }) : t('set.currency2_help');
    };
    c2.addEventListener('input', example);
    example();
    c2.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!isAdmin) return;
      const enabled = c2.currency2_enabled.checked;
      const rate = Number(c2.currency2_rate.value);
      if (enabled && !(rate > 0)) return toast(t('err.RATE_POSITIVE'), 'warn');
      await save(
        {
          currency2_enabled: enabled ? '1' : '0',
          currency2_symbol: c2.currency2_symbol.value.trim() || 'L.L',
          currency2_decimals: c2.currency2_decimals.value || '0',
          ...(rate > 0 ? { currency2_rate: String(rate) } : {}),
        },
        enabled ? t('set.currency2_saved', { a: `1 ${store.settings.currency || '$'}`, v: money2(1) }) : t('set.saved'),
      );
    });
  }

  root.querySelectorAll('#settings-lang [data-lang]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      // Imported lazily: main.js owns the re-render, and it imports this module.
      const { switchLanguage } = await import('../main.js');
      switchLanguage(btn.dataset.lang);
    }),
  );

  if ($('#backup-list')) {
    const drawBackups = (list) => {
      $('#backup-list').innerHTML = list.length
        ? `<div class="cell-sub" style="margin-bottom:6px;font-weight:600">${esc(t('set.recent_backups'))}</div>
           ${list
             .map(
               (b) => `<div class="sum-row" style="font-size:12px">
                 <span class="mono">${esc(b.name)}</span>
                 <span class="v muted">${esc(kb(b.size))} · ${dateTimeText(b.modified)}</span>
               </div>`,
             )
             .join('')}`
        : `<div class="cell-sub">${esc(t('set.no_backups'))}</div>`;
    };
    drawBackups(sys.backups || []);

    // When the last automatic backup was taken, and whether the last attempt went wrong.
    const paintAuto = (s) => {
      const when = s.backup_last_auto ? dateTimeText(s.backup_last_auto) : t('set.backup_none_auto');
      $('#backup-auto-status').innerHTML = s.backup_last_error
        ? `${esc(when)} · <span class="money-neg">${esc(t('set.backup_error', { e: s.backup_last_error }))}</span>`
        : esc(when);
    };
    paintAuto(cfg);
    $('#backup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const saved = await save({ backup_dir2: e.target.backup_dir2.value.trim() });
      if (!saved) return;
      // Saving a folder takes a backup at once, so the list and the status move.
      paintAuto(saved);
      drawBackups((await api.system()).backups || []);
    });

    $('#backup-download').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        // Streamed as a file attachment, so it goes through the browser's downloader.
        const res = await fetch('/api/backup', { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'absoft-backup.db';
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        toast(t('set.backup_done'), 'success');
      } catch (err) {
        toast(`${t('set.backup_failed')}: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#backup-local').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await api.backupLocal();
        toast(t('set.backup_saved', { path: res.path }), 'success', 5000);
        drawBackups(res.backups);
      } catch (err) {
        toast(`${t('set.backup_failed')}: ${errorText(err)}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }
}
