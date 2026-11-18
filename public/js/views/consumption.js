import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, t } from '../i18n.js';
import { confirmDialog, dateTimeText, emptyState, esc, money, pager, qtyText, signClass, store, toast, todayISO } from '../ui.js';

/**
 * Consumption reconciliation: what the ingredients really went down by, beside
 * what the recipes say the sales used.
 *
 * A reconciliation covers the ingredients chosen, each from its own last
 * reconciliation up to the day chosen (or up to the moment it is submitted).
 * Count what is left and ABSoft works out what was used; or type what was used.
 * Saved, it is a draft and moves nothing; submitted, each ingredient's stock
 * goes down by what was really used, and its next reconciliation starts there.
 *
 *   #/consumption, #/consumption/new, #/consumption/<id>
 */
export async function render(root, ctx) {
  const [first] = ctx.params;
  if (first === 'new') return renderEditor(root, ctx, null);
  if (first && /^\d+$/.test(first)) {
    let doc;
    try {
      doc = await api.consumption(Number(first));
    } catch (err) {
      toast(errorText(err), 'error');
      return ctx.navigate('consumption');
    }
    return doc.status === 'draft' ? renderEditor(root, ctx, doc) : renderDocument(root, ctx, doc);
  }
  return renderList(root, ctx);
}

const sinceText = (since) => (since ? dateTimeText(since) : t('con.never'));
const untilText = (doc) => (doc.until ? dateTimeText(doc.until) : t('con.until_submit'));
const statusBadge = (doc) =>
  `<span class="badge ${doc.status === 'submitted' ? 'success' : 'warn'}">${esc(t(`con.status.${doc.status}`))}</span>`;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/* ------------------------------------------------------------------ list -- */

async function renderList(root, ctx) {
  const admin = store.user?.role === 'admin';
  ctx.actions.innerHTML = `<button class="btn btn-primary" id="con-new">${icon('plus')} ${esc(t('con.new'))}</button>`;
  ctx.actions.querySelector('#con-new').addEventListener('click', () => ctx.navigate('consumption/new'));
  root.innerHTML = `<div class="card"><div class="card-body flush" id="con-list"></div></div>`;
  const box = root.querySelector('#con-list');
  let page = 1;
  let per = 25;
  async function load() {
    const res = await api.consumptions({ page, per });
    box.innerHTML = res.rows.length
      ? `<div class="table-wrap"><table class="data" id="con-table">
          <thead><tr><th>${esc(t('con.doc'))}</th><th>${esc(t('common.date'))}</th><th>${esc(t('con.until'))}</th>
            <th>${esc(t('common.status'))}</th><th class="right">${esc(t('con.lines'))}</th>
            ${admin ? `<th class="right">${esc(t('common.value'))}</th><th class="right">${esc(t('con.difference_value'))}</th>` : ''}</tr></thead>
          <tbody>${res.rows
            .map(
              (d) => `<tr class="clickable" data-open="${d.id}">
                <td><b>${esc(d.doc_no)}</b>${d.note ? `<div class="cell-sub">${esc(d.note)}</div>` : ''}</td>
                <td>${esc(dateTimeText(d.created_at))}</td>
                <td>${esc(untilText(d))}</td>
                <td>${statusBadge(d)}</td>
                <td class="right">${d.lines}</td>
                ${admin ? `<td class="right">${money(d.value)}</td><td class="right ${signClass(-d.difference_value)}">${money(d.difference_value, { sign: true })}</td>` : ''}
              </tr>`,
            )
            .join('')}</tbody></table></div>`
      : emptyState(t('con.none'), t('con.none_sub'), 'clipboard');
    box.querySelectorAll('[data-open]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`consumption/${tr.dataset.open}`)));
    if (res.rows.length) {
      box.append(
        pager(res, (next) => {
          page = next.page;
          per = next.per;
          load();
        }),
      );
    }
  }
  await load();
}

/* ---------------------------------------------------------------- editor -- */

/**
 * A new reconciliation, or a draft: every ingredient a recipe uses, with what
 * the sales say it used since its last reconciliation. Tick the ones being
 * reconciled; type what is left (the use follows) or what was used.
 */
async function renderEditor(root, ctx, doc) {
  const admin = store.user?.role === 'admin';
  let ingredients;
  try {
    ingredients = await api.consumptionIngredients();
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.navigate('consumption');
  }
  // A draft brings what was typed into it; its figures are live, like a new one's.
  const rows = ingredients.map((i) => {
    const mine = doc?.items.find((x) => x.product_id === i.id);
    return {
      ...i,
      on: !!mine,
      actual: mine ? mine.actual : '',
      counted: mine && mine.counted !== null ? mine.counted : '',
    };
  });
  // An ingredient in the draft that no recipe uses any more still belongs to it.
  for (const it of doc?.items || []) {
    if (!rows.some((r) => r.id === it.product_id)) {
      rows.push({ id: it.product_id, name: it.name, unit: it.unit, cost: it.unit_cost, stock: it.stock, since: it.since, suggested: it.suggested, on: true, actual: it.actual, counted: it.counted ?? '' });
    }
  }
  const untilDay = doc?.until ? doc.until.slice(0, 10) : '';

  ctx.actions.innerHTML = `
    <button class="btn" id="con-back">${icon('back')} ${esc(t('common.back'))}</button>
    ${doc ? `<button class="btn btn-ghost" id="con-delete" title="${esc(t('common.delete'))}">${icon('trash')}</button>` : ''}
    <button class="btn" id="con-save">${icon('check')} ${esc(t('con.save_draft'))}</button>
    ${admin ? `<button class="btn btn-primary" id="con-submit">${icon('check')} ${esc(t('con.submit'))}</button>` : ''}`;

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>${esc(doc ? t('con.draft_title', { no: doc.doc_no }) : t('con.new'))}</h3>
        <div class="sub">${esc(t('con.editor_sub'))}</div></div></div>
      <div class="card-body"><div class="form-grid">
        <div class="field"><label for="con-until">${esc(t('con.until'))}</label>
          <input class="input" type="date" id="con-until" value="${esc(untilDay)}" max="${todayISO()}"/>
          <div class="help">${esc(t('con.until_help'))}</div></div>
        <div class="field"><label for="con-note">${esc(t('common.note'))}</label>
          <input class="input" id="con-note" maxlength="200" value="${esc(doc?.note || '')}"/></div>
      </div></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>${esc(t('con.ingredients'))}</h3>
        <div class="sub">${esc(t('con.ingredients_sub'))}</div></div>
        <div class="spacer"></div>
        <label class="check"><input type="checkbox" id="con-all"/> ${esc(t('con.all'))}</label></div>
      <div class="card-body flush">${
        rows.length
          ? `<div class="table-wrap table-scroll"><table class="data" id="con-lines">
              <thead><tr><th style="width:36px"></th><th>${esc(t('recipe.ingredient'))}</th><th>${esc(t('con.since'))}</th>
                <th class="right">${esc(t('con.suggested'))}</th><th class="right">${esc(t('con.on_hand'))}</th>
                <th class="right" style="width:130px">${esc(t('con.counted'))}</th><th class="right" style="width:130px">${esc(t('con.actual'))}</th>
                <th class="right">${esc(t('con.difference'))}</th></tr></thead>
              <tbody>${rows
                .map(
                  (r, i) => `<tr data-row="${i}" class="${r.on ? '' : 'con-off'}">
                    <td><input type="checkbox" data-on="${i}" ${r.on ? 'checked' : ''} aria-label="${esc(r.name)}"/></td>
                    <td><div class="cell-title">${esc(r.name)}</div></td>
                    <td class="muted nowrap">${esc(sinceText(r.since))}</td>
                    <td class="right">${qtyText(r.suggested)} <span class="muted">${esc(r.unit || '')}</span></td>
                    <td class="right">${qtyText(r.stock)}</td>
                    <td class="right"><input class="input price-input" type="number" step="any" min="0" data-counted="${i}" value="${r.counted}"
                      placeholder="—" aria-label="${esc(t('con.counted'))}"/></td>
                    <td class="right"><input class="input price-input" type="number" step="any" min="0" data-actual="${i}" value="${r.actual}"
                      placeholder="${esc(qtyText(r.suggested))}" aria-label="${esc(t('con.actual'))}"/></td>
                    <td class="right" data-diff="${i}"></td>
                  </tr>`,
                )
                .join('')}</tbody></table></div>`
          : emptyState(t('con.no_ingredients'), t('con.no_ingredients_sub'), 'clipboard')
      }</div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  // The buttons sit in the page's header, beside its title.
  const act = (sel) => ctx.actions.querySelector(sel);
  /** What was used: what was typed, or — with nothing typed — what the sales say. */
  const usedOf = (r) => (r.actual === '' ? Number(r.suggested) || 0 : Number(r.actual) || 0);
  const paintDiff = (i) => {
    const r = rows[i];
    const el = root.querySelector(`[data-diff="${i}"]`);
    if (!el) return;
    if (!r.on) {
      el.innerHTML = '';
      return;
    }
    const d = round3(usedOf(r) - (Number(r.suggested) || 0));
    // More used than the recipes say is a loss: shown as such.
    el.innerHTML = `<span class="${signClass(-d)}">${d > 0 ? '+' : ''}${qtyText(d)}</span>`;
  };
  const turnOn = (i, on = true) => {
    rows[i].on = on;
    root.querySelector(`[data-on="${i}"]`).checked = on;
    root.querySelector(`[data-row="${i}"]`).classList.toggle('con-off', !on);
    paintDiff(i);
  };
  rows.forEach((_, i) => paintDiff(i));

  root.querySelectorAll('[data-on]').forEach((el) => el.addEventListener('change', () => turnOn(+el.dataset.on, el.checked)));
  $('#con-all')?.addEventListener('change', (e) => rows.forEach((_, i) => turnOn(i, e.target.checked)));
  // Counted what is left: what was used is what there was, less what is left.
  root.querySelectorAll('[data-counted]').forEach((el) =>
    el.addEventListener('input', () => {
      const i = +el.dataset.counted;
      const r = rows[i];
      r.counted = el.value.trim();
      if (r.counted !== '') {
        r.actual = String(Math.max(0, round3((Number(r.stock) || 0) - (Number(r.counted) || 0))));
        root.querySelector(`[data-actual="${i}"]`).value = r.actual;
      }
      turnOn(i);
    }),
  );
  root.querySelectorAll('[data-actual]').forEach((el) =>
    el.addEventListener('input', () => {
      const i = +el.dataset.actual;
      rows[i].actual = el.value.trim();
      turnOn(i);
    }),
  );

  const payload = () => ({
    id: doc?.id,
    until: $('#con-until').value,
    note: $('#con-note').value.trim(),
    items: rows.filter((r) => r.on).map((r) => ({ product_id: r.id, actual: usedOf(r), counted: r.counted === '' ? null : Number(r.counted) })),
  });
  const saveDraft = async () => {
    const saved = await api.saveConsumption(payload());
    doc = saved;
    return saved;
  };

  act('#con-back')?.addEventListener('click', () => ctx.navigate('consumption'));
  act('#con-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const saved = await saveDraft();
      toast(t('con.saved'), 'success');
      ctx.navigate(`consumption/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });
  act('#con-submit')?.addEventListener('click', async () => {
    const n = rows.filter((r) => r.on).length;
    if (!n) return toast(errorText({ code: 'CONSUMPTION_EMPTY' }), 'error');
    const ok = await confirmDialog({
      title: t('con.submit_title'),
      message: t('con.submit_msg', { n }),
      confirmLabel: t('con.submit'),
    });
    if (!ok) return;
    try {
      const saved = await saveDraft();
      await api.submitConsumption(saved.id);
      toast(t('con.submitted'), 'success');
      ctx.navigate(`consumption/${saved.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
      // Saved as a draft before it was refused: stay on it.
      if (doc?.id) history.replaceState(null, '', `#/consumption/${doc.id}`);
    }
  });
  act('#con-delete')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('con.delete_title', { no: doc.doc_no }), message: t('con.delete_msg'), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try {
      await api.deleteConsumption(doc.id);
      toast(t('con.deleted'), 'success');
      ctx.navigate('consumption');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

/* -------------------------------------------------------------- document -- */

/** A submitted reconciliation: its figures as they were when it was submitted. */
function renderDocument(root, ctx, doc) {
  const admin = store.user?.role === 'admin';
  ctx.actions.innerHTML = `<button class="btn" id="con-back">${icon('back')} ${esc(t('common.back'))}</button>`;
  ctx.actions.querySelector('#con-back').addEventListener('click', () => ctx.navigate('consumption'));
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>${esc(doc.doc_no)} ${statusBadge(doc)}</h3>
        <div class="sub">${esc(t('con.doc_sub', { until: untilText(doc), at: dateTimeText(doc.submitted_at), by: doc.username || '' }))}</div></div></div>
      ${doc.note ? `<div class="card-body"><p>${esc(doc.note)}</p></div>` : ''}
      <div class="card-body flush"><div class="table-wrap"><table class="data" id="con-doc">
        <thead><tr><th>${esc(t('recipe.ingredient'))}</th><th>${esc(t('con.since'))}</th>
          <th class="right">${esc(t('con.suggested'))}</th><th class="right">${esc(t('con.counted'))}</th>
          <th class="right">${esc(t('con.actual'))}</th><th class="right">${esc(t('con.difference'))}</th>
          ${admin ? `<th class="right">${esc(t('common.value'))}</th><th class="right">${esc(t('con.difference_value'))}</th>` : ''}</tr></thead>
        <tbody>${doc.items
          .map(
            (i) => `<tr>
              <td><div class="cell-title">${esc(i.name)}</div></td>
              <td class="muted nowrap">${esc(sinceText(i.since))}</td>
              <td class="right">${qtyText(i.suggested)} <span class="muted">${esc(i.unit || '')}</span></td>
              <td class="right">${i.counted === null ? '<span class="muted">—</span>' : qtyText(i.counted)}</td>
              <td class="right"><b>${qtyText(i.actual)}</b></td>
              <td class="right ${signClass(-i.difference)}">${i.difference > 0 ? '+' : ''}${qtyText(i.difference)}</td>
              ${admin ? `<td class="right">${money(i.value)}</td><td class="right ${signClass(-i.difference_value)}">${money(i.difference_value, { sign: true })}</td>` : ''}
            </tr>`,
          )
          .join('')}</tbody>
        ${
          admin
            ? `<tfoot><tr><td colspan="6">${esc(t('common.totals'))}</td><td class="right">${money(doc.value)}</td>
                <td class="right ${signClass(-doc.difference_value)}">${money(doc.difference_value, { sign: true })}</td></tr></tfoot>`
            : ''
        }
      </table></div></div>
    </div>`;
}
