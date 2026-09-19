import { api } from '../api.js';
import { formatSecond, second } from '../currency.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import { dateTimeText, esc, modal, money, store, toast } from '../ui.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const time = (value) => dateTimeText(value);

/**
 * Shifts at the till. With shifts switched on (Settings → POS), the till sells
 * only inside an open shift: it opens with the cash already in the drawer and
 * closes by counting it against what the drawer should hold.
 *
 * Returns { refresh, isOpen, destroy }. With shifts off it does nothing and the
 * till is always open for business.
 */
export async function attachShifts(pos, { scanBar, navigate, onChange = () => {} }) {
  const enabled = store.settings.pos_shifts === '1';
  if (!enabled) return { refresh: async () => {}, isOpen: () => true, destroy() {} };

  let current = null;

  // The shift in progress, at the end of the scan bar.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'btn shift-chip';
  chip.id = 'shift-chip';
  chip.hidden = true;
  scanBar.appendChild(chip);

  // Until a shift is open, the till shows how to open one instead of selling.
  const gate = document.createElement('div');
  gate.className = 'shift-gate';
  gate.id = 'shift-gate';
  gate.hidden = true;
  pos.appendChild(gate);

  function paint() {
    const open = !!current;
    pos.classList.toggle('shift-closed', !open);
    chip.hidden = !open;
    gate.hidden = open;
    if (open) {
      chip.title = t('shift.chip_title');
      chip.innerHTML = `<span class="shift-dot"></span><b>${esc(current.doc_no)}</b>
        <small>${esc(t('shift.since', { t: time(current.opened_at) }))}</small>${icon('chevron')}`;
      return;
    }
    const cur = second();
    gate.innerHTML = `
      <form class="card shift-open" id="shift-open-form">
        <div class="shift-open-icon">${icon('coins')}</div>
        <h3>${esc(t('shift.open_title'))}</h3>
        <p class="muted">${esc(t('shift.open_sub'))}</p>
        <div class="shift-fields">
          <div class="field">
            <label for="opening-cash">${esc(t('shift.opening_cash', { c: store.settings.currency || '$' }))}</label>
            <input class="input pay-amount" id="opening-cash" type="number" step="0.01" min="0" value="0" autofocus/>
          </div>
          ${
            cur
              ? `<div class="field">
                  <label for="opening-cash2">${esc(t('shift.opening_cash', { c: cur.symbol }))}</label>
                  <input class="input pay-amount" id="opening-cash2" type="number" step="any" min="0" value="0"/>
                </div>`
              : ''
          }
          <div class="field">
            <label for="opening-note">${esc(t('pos.note_optional'))}</label>
            <input class="input" id="opening-note" placeholder="${esc(t('shift.note_placeholder'))}" autocomplete="off"/>
          </div>
        </div>
        <button class="btn btn-primary btn-lg btn-block" type="submit" id="shift-open">${icon('check')} ${esc(t('shift.open'))}</button>
        <button class="btn btn-ghost btn-sm" type="button" id="shift-history">${icon('history')} ${esc(t('shift.history'))}</button>
      </form>`;
    const form = gate.querySelector('#shift-open-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('#shift-open');
      btn.disabled = true;
      try {
        current = await api.openShift({
          opening_cash: Number(form.querySelector('#opening-cash').value) || 0,
          opening_cash2: Number(form.querySelector('#opening-cash2')?.value) || 0,
          note: form.querySelector('#opening-note').value.trim(),
        });
        toast(t('shift.opened', { doc: current.doc_no }), 'success');
        paint();
        onChange(current);
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
        if (err.code === 'SHIFT_OPEN') refresh();
      }
    });
    gate.querySelector('#shift-history').addEventListener('click', () => navigate('shifts'));
    gate.querySelector('#opening-cash').focus();
    gate.querySelector('#opening-cash').select();
  }

  async function refresh() {
    try {
      current = (await api.currentShift()).shift;
    } catch {
      current = null;
    }
    paint();
    onChange(current);
  }

  /** Close the shift: what it took, what the drawer should hold, what it does. */
  async function closeShift() {
    const shift = await api.currentShift().then((r) => r.shift);
    if (!shift) return refresh();
    const cur = second();
    const row = (label, value, cls = '') => `<div class="sum-row ${cls}"><span>${label}</span><span class="v">${value}</span></div>`;
    const closed = await modal({
      title: t('shift.close_title', { doc: shift.doc_no }),
      subtitle: t('shift.close_sub', { t: time(shift.opened_at), u: shift.opened_by_name || '' }),
      wide: true,
      body: `
        <div class="shift-close">
          <section class="pay-summary">
            <div class="pay-card-head">${esc(t('shift.taken'))}</div>
            ${row(esc(t(shift.sales === 1 ? 'shift.sales_one' : 'shift.sales_n', { n: shift.sales })), `<b>${money(shift.sales_total)}</b>`)}
            ${shift.payments
              .map((p) =>
                row(
                  esc(p.currency === 'second' && cur ? `${methodText(p.method)} · ${cur.symbol}` : methodText(p.method)),
                  p.currency === 'second' && cur ? esc(formatSecond(p.amount2)) : money(p.amount),
                ),
              )
              .join('')}
            ${shift.on_account > 0.004 ? row(esc(t('shift.on_account')), money(shift.on_account), 'muted') : ''}
          </section>
          <section class="pay-summary">
            <div class="pay-card-head">${esc(t('shift.drawer'))}</div>
            ${row(esc(t('shift.opening')), money(shift.opening_cash))}
            ${row(esc(t('shift.cash_in')), money(shift.cash_in))}
            ${row(esc(t('shift.expected')), `<b>${money(shift.expected_cash)}</b>`, 'total')}
            ${
              cur
                ? `${row(esc(t('shift.expected_in', { c: cur.symbol })), `<b>${esc(formatSecond(shift.expected_cash2))}</b>`)}`
                : ''
            }
            <div class="field shift-count">
              <label for="counted-cash">${esc(t('shift.counted', { c: store.settings.currency || '$' }))}</label>
              <input class="input pay-amount" id="counted-cash" type="number" step="0.01" min="0" value="${shift.expected_cash}" autofocus/>
            </div>
            ${
              cur
                ? `<div class="field shift-count">
                    <label for="counted-cash2">${esc(t('shift.counted', { c: cur.symbol }))}</label>
                    <input class="input pay-amount" id="counted-cash2" type="number" step="any" min="0" value="${shift.expected_cash2}"/>
                  </div>`
                : ''
            }
            <div class="pay-result settled" id="shift-diff"></div>
            <div class="field">
              <label for="closing-note">${esc(t('pos.note_optional'))}</label>
              <input class="input" id="closing-note" placeholder="${esc(t('shift.close_note'))}" autocomplete="off"/>
            </div>
          </section>
        </div>`,
      footer: `<button class="btn btn-ghost" data-history>${icon('history')} ${esc(t('shift.history'))}</button>
               <div class="spacer"></div>
               <button class="btn" data-close>${esc(t('common.cancel'))}</button>
               <button class="btn btn-primary btn-lg" id="shift-close">${icon('check')} ${esc(t('shift.close'))}</button>`,
      setup: (dialog, close) => {
        const counted = dialog.querySelector('#counted-cash');
        const counted2 = dialog.querySelector('#counted-cash2');
        const diff = dialog.querySelector('#shift-diff');
        const paintDiff = () => {
          const d = round2((Number(counted.value) || 0) - shift.expected_cash);
          diff.className = `pay-result ${Math.abs(d) < 0.005 ? 'settled' : d > 0 ? 'change' : 'owing'}`;
          diff.innerHTML = `<span>${icon(Math.abs(d) < 0.005 ? 'check' : 'alert')} ${esc(
            t(Math.abs(d) < 0.005 ? 'shift.balanced' : d > 0 ? 'shift.over' : 'shift.short'),
          )}</span><span class="amount">${money(Math.abs(d))}</span>`;
        };
        counted.addEventListener('input', paintDiff);
        paintDiff();
        dialog.querySelector('[data-history]').addEventListener('click', () => {
          close(undefined);
          navigate('shifts');
        });
        dialog.querySelector('#shift-close').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const done = await api.closeShift(shift.id, {
              counted_cash: Number(counted.value) || 0,
              counted_cash2: Number(counted2?.value) || 0,
              note: dialog.querySelector('#closing-note').value.trim(),
            });
            close(done);
          } catch (err) {
            toast(errorText(err), 'error');
            btn.disabled = false;
          }
        });
      },
    });
    if (!closed) return;
    const d = Number(closed.difference) || 0;
    toast(
      Math.abs(d) < 0.005
        ? t('shift.closed_balanced', { doc: closed.doc_no })
        : t('shift.closed_diff', { doc: closed.doc_no, v: money(d, { sign: true }) }),
      Math.abs(d) < 0.005 ? 'success' : 'warn',
      6000,
    );
    current = null;
    paint();
    onChange(null);
  }

  chip.addEventListener('click', closeShift);
  await refresh();
  return {
    refresh,
    isOpen: () => !!current,
    destroy() {
      chip.remove();
      gate.remove();
    },
  };
}
