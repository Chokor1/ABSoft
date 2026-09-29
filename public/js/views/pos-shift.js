import { api } from '../api.js';
import { formatSecond, second } from '../currency.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import { dateTimeText, esc, methodIcon, methodMark, modal, money, slipFoot, slipHead, store, toast } from '../ui.js';

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

  /**
   * Close the shift: count every way of paying — the cash drawer, the card
   * terminal, Whish, OMT… — against what the shift says came in.
   */
  async function closeShift() {
    const shift = await api.currentShift().then((r) => r.shift);
    if (!shift) return refresh();
    const cur = second();
    // One row for every drawer to count: cash and each other method, and where a
    // second currency is in use, the same method again in that currency — money
    // in L.L is counted in L.L, never turned into dollars first.
    const payments = (o) => t('shift.payments_n', { n: o.n });
    const lines = [
      {
        key: 'cash',
        label: methodText('cash'),
        glyph: methodIcon('cash'),
        expected: shift.expected_cash,
        id: 'counted-cash',
        sub: t('shift.cash_sub', { o: money(shift.opening_cash), i: money(shift.cash_in) }),
      },
      ...(cur && (shift.opening_cash2 || shift.cash_in2)
        ? [{
            key: 'cash2',
            label: methodText('cash'),
            glyph: methodIcon('cash'),
            expected: shift.expected_cash2,
            id: 'counted-cash2',
            second: true,
            sub: t('shift.cash_sub', { o: formatSecond(shift.opening_cash2), i: formatSecond(shift.cash_in2) }),
          }]
        : []),
      ...shift.others.flatMap((o) => [
        ...(o.expected || !o.expected2
          ? [{ key: o.method, label: methodText(o.method), glyph: methodIcon(o.method), expected: o.expected, sub: payments(o) }]
          : []),
        ...(cur && o.expected2
          ? [{ key: `${o.method}~2`, method: o.method, label: methodText(o.method), glyph: methodIcon(o.method), expected: o.expected2, second: true }]
          : []),
      ]),
    ];
    const fmt = (l, v) => (l.second ? esc(formatSecond(v)) : money(v));
    const tile = (label, value, cls = '', foot = '') =>
      `<div class="shift-stat ${cls}"><span>${esc(label)}</span><b>${value}</b>${
        foot ? `<small class="money2">${esc(foot)}</small>` : ''
      }</div>`;

    const closed = await modal({
      title: t('shift.close_title', { doc: shift.doc_no }),
      subtitle: t('shift.close_sub', { t: time(shift.opened_at), u: shift.opened_by_name || '' }),
      wide: true,
      body: `
        <div class="shift-close-v2">
          <div class="shift-stats">
            ${tile(t('shift.sales_n', { n: shift.sales }), money(shift.sales_total))}
            ${tile(t('shift.taken_total'), money(shift.taken), '', cur && shift.taken2 ? formatSecond(shift.taken2) : '')}
            ${tile(t('shift.on_account'), money(shift.on_account), shift.on_account > 0.004 ? 'warn' : '')}
            ${tile(t('shift.opening'), money(shift.opening_cash))}
          </div>
          <div class="shift-count-table">
            <div class="sct-head">
              <span>${esc(t('shift.method'))}</span><span>${esc(t('shift.expected'))}</span>
              <span>${esc(t('shift.counted_col'))}</span><span>${esc(t('shift.difference'))}</span>
            </div>
            ${lines
              .map(
                (l, i) => `<div class="sct-row" style="--i:${i}" data-line="${esc(l.key)}">
                  <div class="sct-method"><span class="sct-icon">${methodMark(l.glyph)}</span>
                    <div><b>${esc(l.label)}</b>${
                      l.second ? `<span class="sct-cur">${esc(cur.symbol)}</span>` : ''
                    }${l.sub ? `<small>${esc(l.sub)}</small>` : ''}</div></div>
                  <div class="sct-expected">${fmt(l, l.expected)}</div>
                  <div><input class="input sct-input pay-amount" ${l.id ? `id="${l.id}"` : ''} data-count="${esc(l.key)}"
                    type="number" step="${l.second ? 'any' : '0.01'}" min="0" value="${l.expected}" aria-label="${esc(l.label)}"/></div>
                  <div class="sct-diff" data-diff="${esc(l.key)}"></div>
                </div>`,
              )
              .join('')}
          </div>
          <div class="pay-result settled" id="shift-diff"></div>
          <div class="field">
            <label for="closing-note">${esc(t('pos.note_optional'))}</label>
            <input class="input" id="closing-note" placeholder="${esc(t('shift.close_note'))}" autocomplete="off"/>
          </div>
        </div>`,
      footer: `<button class="btn btn-ghost" data-history>${icon('history')} ${esc(t('shift.history'))}</button>
               <div class="spacer"></div>
               <button class="btn" data-close>${esc(t('common.cancel'))}</button>
               <button class="btn btn-primary btn-lg" id="shift-close">${icon('check')} ${esc(t('shift.close'))}</button>`,
      setup: (dialog, close) => {
        const diffOf = (l) => round2((Number(dialog.querySelector(`[data-count="${CSS.escape(l.key)}"]`).value) || 0) - l.expected);
        const verdict = (d) => (Math.abs(d) < 0.005 ? 'settled' : d > 0 ? 'change' : 'owing');
        const paint = () => {
          // Each currency is its own money: a drawer short 5,000 L.L has not lost $5.
          let total = 0;
          let total2 = 0;
          for (const l of lines) {
            const d = diffOf(l);
            if (l.second) total2 = round2(total2 + d);
            else total = round2(total + d);
            const cell = dialog.querySelector(`[data-diff="${CSS.escape(l.key)}"]`);
            cell.className = `sct-diff ${verdict(d)}`;
            cell.innerHTML = Math.abs(d) < 0.005 ? icon('check') : `${d > 0 ? '+' : '−'}${fmt(l, Math.abs(d))}`;
          }
          const box = dialog.querySelector('#shift-diff');
          const mainOff = Math.abs(total) >= 0.005;
          const secondOff = Math.abs(total2) >= 0.005;
          const short = total < -0.004 || total2 < -0.004;
          box.className = `pay-result ${mainOff || secondOff ? (short ? 'owing' : 'change') : 'settled'}`;
          const said = !mainOff && !secondOff ? 'shift.all_balanced' : short ? 'shift.short' : 'shift.over';
          box.innerHTML = `<span>${icon(mainOff || secondOff ? 'alert' : 'check')} ${esc(t(said))}</span>
            <span class="amount">${mainOff ? money(Math.abs(total)) : ''}${
              secondOff ? `<small class="money2">${esc(formatSecond(Math.abs(total2)))}</small>` : ''
            }</span>`;
        };
        dialog.querySelectorAll('[data-count]').forEach((input) => {
          input.addEventListener('input', paint);
          input.addEventListener('focus', () => input.select());
        });
        paint();
        dialog.querySelector('[data-history]').addEventListener('click', () => {
          close(undefined);
          navigate('shifts');
        });
        dialog.querySelector('#shift-close').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          const value = (key) => Number(dialog.querySelector(`[data-count="${CSS.escape(key)}"]`)?.value) || 0;
          const has = (key) => !!dialog.querySelector(`[data-count="${CSS.escape(key)}"]`);
          try {
            const done = await api.closeShift(shift.id, {
              counted_cash: value('cash'),
              counted_cash2: value('cash2'),
              counted: Object.fromEntries(
                shift.others.map((o) => [
                  o.method,
                  { main: has(o.method) ? value(o.method) : o.expected, second: has(`${o.method}~2`) ? value(`${o.method}~2`) : o.expected2 },
                ]),
              ),
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
    current = null;
    paint();
    onChange(null);
    if (await celebrateClose(closed)) printShiftReport(closed);
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

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The shift is closed: a check draws itself, the figures rise in one by one,
 * and the cashier is asked whether to print the shift report. Resolves true
 * for Print.
 */
export function celebrateClose(shift) {
  return new Promise((resolve) => {
    const cur = second();
    const total = Number(shift.difference_total ?? shift.difference) || 0;
    const total2 = cur ? Number(shift.difference2_total ?? shift.difference2) || 0 : 0;
    const balanced = Math.abs(total) < 0.005 && Math.abs(total2) < 0.005;
    const layer = document.createElement('div');
    layer.className = `sale-done shift-done ${balanced ? '' : 'off'}`;
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    const row = (label, value, i) => `<div class="shift-done-row" style="--i:${i}"><span>${esc(label)}</span><b>${value}</b></div>`;
    // What was counted, in the currency it was counted in.
    const counted = (label, main, secondAmount) => {
      const inSecond = cur && secondAmount;
      // A method that only ever took L.L says so, instead of claiming $0.00.
      const showMain = main > 0.004 || !inSecond;
      return [
        label,
        `${showMain ? money(main) : ''}${inSecond ? `<small class="money2">${esc(formatSecond(secondAmount))}</small>` : ''}`,
      ];
    };
    const rows = [
      [t('shift.sales_n', { n: shift.sales }), money(shift.sales_total)],
      counted(methodText('cash'), shift.counted_cash, shift.counted_cash2),
      ...(shift.others || []).map((o) => counted(methodText(o.method), o.counted, o.counted2)),
    ];
    const off = [
      Math.abs(total) >= 0.005 ? money(Math.abs(total)) : '',
      cur && Math.abs(total2) >= 0.005 ? formatSecond(Math.abs(total2)) : '',
    ].filter(Boolean);
    const short = total < -0.004 || total2 < -0.004;
    const verdictText = balanced
      ? t('shift.all_balanced')
      : `${t(short ? 'shift.short' : 'shift.over')} ${off.join(' · ')}`;
    layer.innerHTML = `
      <div class="sale-done-card shift-done-card">
        <svg class="sale-done-check" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="ring" cx="26" cy="26" r="24"/>
          <path class="tick" d="M15 27.5 22.5 35 38 18.5"/>
        </svg>
        <div class="sale-done-title">${esc(t('shift.closed_title'))}</div>
        <div class="sale-done-doc mono">${esc(shift.doc_no)}</div>
        <div class="shift-done-rows">${rows.map(([l, v], i) => row(l, v, i)).join('')}</div>
        <div class="shift-done-verdict ${balanced ? 'settled' : short ? 'owing' : 'change'}" style="--i:${rows.length}">
          ${icon(balanced ? 'check' : 'alert')}<span>${esc(verdictText)}</span>
        </div>
        <div class="shift-done-ask">${esc(t('shift.print_ask'))}</div>
        <div class="shift-done-actions">
          <button class="btn" data-skip>${esc(t('shift.print_no'))}</button>
          <button class="btn btn-primary" data-print>${icon('print')} ${esc(t('shift.print_yes'))}</button>
        </div>
      </div>`;
    document.body.appendChild(layer);
    const finish = (print) => {
      document.removeEventListener('keydown', onKey, true);
      layer.classList.add('leaving');
      setTimeout(() => {
        layer.remove();
        resolve(print);
      }, reducedMotion() ? 0 : 220);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    layer.querySelector('[data-skip]').addEventListener('click', () => finish(false));
    layer.querySelector('[data-print]').addEventListener('click', () => finish(true));
    layer.querySelector('[data-print]').focus();
  });
}

/** The shift report, as a receipt: what came in, what was counted, what differs. */
export function shiftReportHtml(s) {
  const cur = second();
  const line = (label, value, cls = '') => `<div class="r-line ${cls}"><span>${esc(label)}</span><span>${value}</span></div>`;
  const signed = (v) => money(v, { sign: true });
  // The second currency signs itself: formatSecond has no sign of its own.
  const signedSecond = (v) => `${Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : ''}${formatSecond(Math.abs(Number(v) || 0))}`;
  const closed = s.status === 'closed';
  const heading = (text) => `<div class="r-rule"></div><div class="r-center"><b>${esc(text)}</b></div>`;
  return `<div class="receipt" id="shift-report">
      ${slipHead()}
      <div class="r-center">${esc(t('shift.report_title', { doc: s.doc_no }))}</div>
      <div class="r-rule"></div>
      ${line(t('shift.opened_col'), `${esc(dateTimeText(s.opened_at))} · ${esc(s.opened_by_name || '')}`)}
      ${closed ? line(t('shift.closed_col'), `${esc(dateTimeText(s.closed_at))} · ${esc(s.closed_by_name || '')}`) : ''}
      <div class="r-rule"></div>
      ${line(t('shift.sales_n', { n: s.sales }), money(s.sales_total), 'r-total')}
      ${(s.payments || [])
        .map((p) =>
          line(
            p.currency === 'second' && cur ? `${methodText(p.method)} · ${cur.symbol}` : methodText(p.method),
            p.currency === 'second' && cur ? esc(formatSecond(p.amount2)) : money(p.amount),
          ),
        )
        .join('')}
      ${s.on_account > 0.004 ? line(t('shift.on_account'), money(s.on_account)) : ''}
      ${heading(methodText('cash'))}
      ${line(t('shift.opening'), money(s.opening_cash))}
      ${line(t('shift.cash_in'), money(s.cash_in))}
      ${line(t('shift.expected'), money(s.expected_cash), 'r-total')}
      ${closed ? line(t('shift.counted_col'), money(s.counted_cash)) : ''}
      ${closed ? line(t('shift.difference'), signed(s.difference)) : ''}
      ${
        cur && (s.opening_cash2 || s.expected_cash2)
          ? `${line(`${t('shift.opening')} · ${cur.symbol}`, esc(formatSecond(s.opening_cash2)))}
             ${line(`${t('shift.cash_in')} · ${cur.symbol}`, esc(formatSecond(s.cash_in2)))}
             ${line(t('shift.expected_in', { c: cur.symbol }), esc(formatSecond(s.expected_cash2)), 'r-total')}
             ${closed ? line(t('shift.counted', { c: cur.symbol }), esc(formatSecond(s.counted_cash2))) : ''}
             ${closed ? line(`${t('shift.difference')} · ${cur.symbol}`, esc(signedSecond(s.difference2))) : ''}`
          : ''
      }
      ${(s.others || [])
        .map(
          (o) => `${heading(methodText(o.method))}
            ${
              o.expected || !o.expected2
                ? `${line(t('shift.expected'), money(o.expected))}
                   ${closed ? line(t('shift.counted_col'), money(o.counted)) : ''}
                   ${closed ? line(t('shift.difference'), signed(o.difference)) : ''}`
                : ''
            }
            ${
              cur && o.expected2
                ? `${line(t('shift.expected_in', { c: cur.symbol }), esc(formatSecond(o.expected2)))}
                   ${closed ? line(t('shift.counted', { c: cur.symbol }), esc(formatSecond(o.counted2))) : ''}
                   ${closed ? line(`${t('shift.difference')} · ${cur.symbol}`, esc(signedSecond(o.difference2))) : ''}`
                : ''
            }`,
        )
        .join('')}
      ${
        closed
          ? `<div class="r-rule"></div>${line(t('shift.total_difference'), signed(s.difference_total ?? s.difference), 'r-total')}
             ${cur && s.difference2_total !== null && s.difference2_total !== undefined
               ? line(`${t('shift.total_difference')} · ${cur.symbol}`, esc(signedSecond(s.difference2_total)), 'r-total')
               : ''}`
          : ''
      }
      ${[s.opening_note, s.closing_note].filter(Boolean).map((n) => `<div class="r-center">${esc(n)}</div>`).join('')}
      ${slipFoot()}
    </div>`;
}

/** Open the shift report and send it to the printer. */
export function printShiftReport(shift) {
  return modal({
    title: t('shift.report_title', { doc: shift.doc_no }),
    body: `<div class="receipt-page">${shiftReportHtml(shift)}</div>`,
    footer: `<button class="btn" data-close>${esc(t('common.close'))}</button>
             <button class="btn btn-primary no-print" data-print>${icon('print')} ${esc(t('common.print'))}</button>`,
    setup: (root) => {
      root.querySelector('[data-print]').addEventListener('click', () => window.print());
      // Give the report a moment to paint before the print dialog takes over.
      setTimeout(() => window.print(), 250);
    },
  });
}
