import { api } from '../api.js';
import { playSaleChime, setSoundEnabled, soundEnabled } from '../feedback.js';
import { icon } from '../icons.js';
import { LANGUAGES, errorText, lang, t } from '../i18n.js';
import { dateTimeText, esc, money, number, store, toast } from '../ui.js';
import { applySettings, money2 } from '../currency.js';

const kb = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export async function render(root, ctx) {
  const [cfg, sys] = await Promise.all([api.settings(), api.system()]);
  const isAdmin = store.user.role === 'admin';

  root.innerHTML = `
    <div class="grid cols-2 split-form" style="align-items:start">
      <form class="card" id="settings-form">
        <div class="card-head"><div><h3>${esc(t('set.store'))}</h3>
          <div class="sub">${esc(t('set.store_sub'))}</div></div></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field span-2">
              <label>${esc(t('set.store_name'))}</label>
              <input class="input" name="store_name" value="${esc(cfg.store_name)}" ${isAdmin ? '' : 'disabled'}/>
            </div>
            <div class="field">
              <label>${esc(t('set.currency'))}</label>
              <input class="input" name="currency" value="${esc(cfg.currency)}" maxlength="4" ${isAdmin ? '' : 'disabled'}/>
              <div class="help">${esc(t('set.currency_help'))}</div>
            </div>
            <div class="field">
              <label>${esc(t('set.tax_rate'))}</label>
              <input class="input" type="number" step="0.01" min="0" name="tax_rate" value="${esc(cfg.tax_rate)}" ${
                isAdmin ? '' : 'disabled'
              }/>
              <div class="help">${esc(t('set.tax_help'))}</div>
            </div>
            <div class="field span-2">
              <label>${esc(t('set.receipt_footer'))}</label>
              <textarea class="input" name="receipt_footer" ${isAdmin ? '' : 'disabled'}>${esc(cfg.receipt_footer)}</textarea>
            </div>
            <div class="field span-2">
              <label class="check">
                <input type="checkbox" name="low_stock_alert" ${cfg.low_stock_alert === '1' ? 'checked' : ''} ${
                  isAdmin ? '' : 'disabled'
                }/>
                ${esc(t('set.low_alert'))}
              </label>
            </div>
          </div>
        </div>
        ${
          isAdmin
            ? `<div class="card-head" style="border-top:1px solid var(--border);border-bottom:0">
                 <div class="spacer"></div>
                 <button class="btn btn-primary" type="submit">${icon('check')} ${esc(t('set.save'))}</button>
               </div>`
            : `<div class="card-body" style="padding-top:0"><p class="muted">${esc(t('set.admin_only'))}</p></div>`
        }
      </form>

      <div style="display:grid;gap:16px">
        <div class="card">
          <div class="card-head"><div><h3>${esc(t('set.language'))}</h3></div></div>
          <div class="card-body">
            <div class="seg lang-picker" id="settings-lang" style="margin-bottom:10px">
              ${LANGUAGES.map(
                (l) =>
                  `<button type="button" data-lang="${l.code}" lang="${l.code}" class="${
                    l.code === lang ? 'active' : ''
                  }">${esc(l.native)}</button>`,
              ).join('')}
            </div>
            <p class="muted" style="font-size:12.5px">${esc(t('set.language_help'))}</p>
          </div>
        </div>

        <form class="card" id="currency2-form">
          <div class="card-head"><div><h3>${esc(t('set.currency2'))}</h3>
            <div class="sub">${esc(t('set.currency2_sub', { c: cfg.currency || '$' }))}</div></div></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field span-2">
                <label class="check">
                  <input type="checkbox" name="currency2_enabled" ${cfg.currency2_enabled === '1' ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}/>
                  ${esc(t('set.currency2_enable'))}
                </label>
              </div>
              <div class="field">
                <label>${esc(t('set.currency2_symbol'))}</label>
                <input class="input" name="currency2_symbol" value="${esc(cfg.currency2_symbol || 'L.L')}" maxlength="6" ${isAdmin ? '' : 'disabled'}/>
              </div>
              <div class="field">
                <label>${esc(t('set.currency2_decimals'))}</label>
                <input class="input" type="number" min="0" max="4" step="1" name="currency2_decimals" value="${esc(cfg.currency2_decimals || '0')}" ${isAdmin ? '' : 'disabled'}/>
              </div>
              <div class="field span-2">
                <label>${esc(t('set.currency2_rate', { c: cfg.currency || '$' }))}</label>
                <input class="input" type="number" min="0" step="any" name="currency2_rate" value="${esc(Number(cfg.currency2_rate) > 0 ? cfg.currency2_rate : '')}"
                       placeholder="89500" ${isAdmin ? '' : 'disabled'}/>
                <div class="help" id="currency2-example"></div>
              </div>
            </div>
          </div>
          ${
            isAdmin
              ? `<div class="card-head" style="border-top:1px solid var(--border);border-bottom:0">
                   <div class="spacer"></div>
                   <button class="btn btn-primary" type="submit">${icon('check')} ${esc(t('set.save'))}</button>
                 </div>`
              : ''
          }
        </form>

        <div class="card">
          <div class="card-head"><div><h3>${esc(t('set.till'))}</h3></div></div>
          <div class="card-body" style="display:grid;gap:10px">
            <label class="check">
              <input type="checkbox" id="sound-toggle" ${soundEnabled() ? 'checked' : ''}/>
              ${esc(t('set.sound'))}
            </label>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm" id="sound-test">${esc(t('set.sound_test'))}</button>
              <span class="muted" style="font-size:12.5px">${esc(t('set.sound_help'))}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>${esc(t('set.how_title'))}</h3></div></div>
          <div class="card-body">
            <div class="pnl" style="font-size:13.5px">
              <div class="pnl-row"><span>${esc(t('set.how_revenue'))}</span>
                <span class="v muted">${esc(t('set.how_revenue_v'))}</span></div>
              <div class="pnl-row"><span>${esc(t('set.how_cogs'))}</span>
                <span class="v muted">${esc(t('set.how_cogs_v'))}</span></div>
              <div class="pnl-row strong"><span>${esc(t('set.how_gross'))}</span>
                <span class="v muted">${esc(t('set.how_gross_v'))}</span></div>
              <div class="pnl-row"><span>${esc(t('set.how_exp'))}</span>
                <span class="v muted">${esc(t('set.how_exp_v'))}</span></div>
              <div class="pnl-row final"><span>${esc(t('set.how_net'))}</span>
                <span class="v" style="font-size:15px">${esc(t('set.how_net_v'))}</span></div>
            </div>
            <p class="muted" style="margin-top:14px;font-size:12.5px">${esc(t('set.how_note'))}</p>
            <div class="pnl" style="margin-top:16px">
              <div class="pnl-row"><span>${esc(t('set.example_price'))}</span><span class="v">${money(10)}</span></div>
              <div class="pnl-row"><span>${esc(t('set.example_cost'))}</span><span class="v">${money(6)}</span></div>
              <div class="pnl-row"><span>${esc(t('set.example_profit'))}</span>
                <span class="v money-pos">${money(4)}</span></div>
            </div>
          </div>
        </div>

        ${
          isAdmin
            ? `<div class="card">
                <div class="card-head"><div><h3>${esc(t('set.backup'))}</h3>
                  <div class="sub">${esc(t('set.backup_sub'))}</div></div></div>
                <div class="card-body">
                  <div class="pnl" style="margin-bottom:14px">
                    <div class="pnl-row"><span>${esc(t('set.db_size'))}</span>
                      <span class="v">${esc(kb(sys.db_size))}</span></div>
                    <div class="pnl-row"><span>${esc(t('set.schema'))}</span>
                      <span class="v">v${number(sys.schema_version)}</span></div>
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
                    <button class="btn btn-primary" id="backup-download">${icon('download')} ${esc(
                      t('set.backup_download'),
                    )}</button>
                    <button class="btn" id="backup-local">${icon('database')} ${esc(t('set.backup_local'))}</button>
                  </div>
                  <p class="muted" style="font-size:12px;margin-top:13px">${esc(t('set.backup_help'))}</p>
                  <div id="backup-list" style="margin-top:14px"></div>
                </div>
              </div>`
            : ''
        }

        <div class="card">
          <div class="card-head"><div><h3>${esc(t('set.about'))}</h3></div></div>
          <div class="card-body">
            <div style="display:flex;align-items:center;gap:13px">
              <div class="mark" style="width:42px;height:42px;border-radius:13px;display:grid;place-items:center;
                background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font-weight:800">AB</div>
              <div>
                <div style="font-weight:650">${esc(t('app.name'))} — ${esc(t('app.tagline'))}</div>
                <div class="muted" style="font-size:12.5px">${esc(
                  t('set.version', { v: sys.version }),
                )} · Node ${esc(sys.node)}</div>
              </div>
            </div>
            <p style="margin-top:14px;font-weight:600">${esc(t('app.author'))}</p>
            <p class="muted" style="font-size:12px;margin-top:8px">${esc(t('set.update_hint'))}</p>
          </div>
        </div>
      </div>
    </div>`;

  /* ------------------------------------------------------------- backups -- */

  function drawBackups(list) {
    const el = root.querySelector('#backup-list');
    if (!el) return;
    el.innerHTML = list.length
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
  }

  if (isAdmin) {
    drawBackups(sys.backups || []);

    root.querySelector('#backup-download').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        // Streamed as a file attachment, so it goes through the browser's downloader
        // rather than the JSON api helper.
        const res = await fetch('/api/backup', { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const name =
          /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'absoft-backup.db';
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

    root.querySelector('#backup-local').addEventListener('click', async (e) => {
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

  // Second currency: a live example of the conversion while typing.
  const c2 = root.querySelector('#currency2-form');
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
    try {
      const saved = await api.saveSettings({
        currency2_enabled: enabled ? '1' : '0',
        currency2_symbol: c2.currency2_symbol.value.trim() || 'L.L',
        currency2_decimals: c2.currency2_decimals.value || '0',
        ...(rate > 0 ? { currency2_rate: String(rate) } : {}),
      });
      applySettings(saved);
      toast(enabled ? t('set.currency2_saved', { a: `1 ${store.settings.currency || '$'}`, v: money2(1) }) : t('set.saved'), 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  root.querySelector('#sound-toggle').addEventListener('change', (e) => setSoundEnabled(e.target.checked));
  root.querySelector('#sound-test').addEventListener('click', () => {
    const was = soundEnabled();
    setSoundEnabled(true);
    playSaleChime();
    setSoundEnabled(was);
  });

  root.querySelectorAll('#settings-lang [data-lang]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      // Imported lazily: main.js owns the re-render, and it imports this module.
      const { switchLanguage } = await import('../main.js');
      switchLanguage(btn.dataset.lang);
    }),
  );

  root.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    const form = e.target;
    try {
      const saved = await api.saveSettings({
        store_name: form.store_name.value.trim(),
        currency: form.currency.value.trim() || '$',
        tax_rate: form.tax_rate.value || '0',
        receipt_footer: form.receipt_footer.value.trim(),
        low_stock_alert: form.low_stock_alert.checked ? '1' : '0',
      });
      applySettings(saved);
      toast(t('set.saved'), 'success');
      document.querySelector('.brand small').textContent = saved.store_name || t('app.tagline');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}
