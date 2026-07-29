import { api } from '../api.js';
import { icon } from '../icons.js';
import { DEFAULT_EXPENSE_CATEGORIES, EXPENSE_METHODS, count, errorText, methodText, t } from '../i18n.js';
import {
  barList,
  confirmDialog,
  dateText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  forgetSuggestions,
  formModal,
  money,
  monthStart,
  rangeBar,
  suggestions,
  toast,
  todayISO,
} from '../ui.js';

/** Suggestions come from the current language; anything already used is kept as typed. */
const categorySuggestions = (used) => [
  ...new Set([...DEFAULT_EXPENSE_CATEGORIES.map((c) => t(`exp.cat.${c}`)), ...used]),
];

export async function render(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '' };
  let rows = [];
  let used = await suggestions('expense_category');

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('exp.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => edit(null));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-expenses-${state.from}-to-${state.to}.csv`,
      rows.map((e) => ({
        date: e.date,
        category: e.category,
        note: e.note,
        amount: e.amount,
        method: e.method,
        user: e.username || '',
      })),
    ),
  );

  const bar = rangeBar(state, (r) => {
    Object.assign(state, r);
    load();
  });
  const searchWrap = document.createElement('div');
  searchWrap.className = 'input-icon';
  searchWrap.style.minWidth = '230px';
  searchWrap.innerHTML = `${icon('search')}<input class="input" data-search placeholder="${esc(t('exp.search'))}"/>`;
  searchWrap.querySelector('input').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      load();
    }, 250),
  );
  bar.appendChild(searchWrap);

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    rows = await api.expenses({ from: state.from, to: state.to, search: state.search });

    const total = rows.reduce((s, e) => s + e.amount, 0);
    const byCategory = Object.entries(
      rows.reduce((acc, e) => ({ ...acc, [e.category]: (acc[e.category] || 0) + e.amount }), {}),
    )
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    body.innerHTML = `
      <div class="grid cols-2 split-wide">
        <div class="card">
          <div class="card-head">
            <div><h3>${esc(count('exp', rows.length))}</h3>
              <div class="sub">${dateText(state.from)} → ${dateText(state.to)}</div></div>
            <div class="spacer"></div>
            <span class="badge danger">${esc(t('exp.total_badge', { v: money(total) }))}</span>
          </div>
          <div class="card-body flush">
            ${
              rows.length
                ? `<div class="table-wrap"><table class="data">
                    <thead><tr><th>${esc(t('common.date'))}</th><th>${esc(t('common.category'))}</th>
                      <th>${esc(t('common.note'))}</th><th>${esc(t('exp.paid_by'))}</th>
                      <th class="right">${esc(t('common.amount'))}</th><th>${esc(t('common.user'))}</th><th></th></tr></thead>
                    <tbody>${rows
                      .map(
                        (e) => `<tr>
                          <td class="nowrap">${dateText(e.date)}</td>
                          <td><span class="badge">${esc(e.category)}</span></td>
                          <td>${esc(e.note || t('common.none'))}</td>
                          <td class="muted">${esc(methodText(e.method))}</td>
                          <td class="right"><b class="money-neg">${money(e.amount)}</b></td>
                          <td class="muted">${esc(e.username || t('common.none'))}</td>
                          <td class="right nowrap">
                            <button class="btn btn-sm btn-ghost" data-edit="${e.id}" title="${esc(
                              t('common.edit'),
                            )}">${icon('edit')}</button>
                            <button class="btn btn-sm btn-ghost" data-del="${e.id}" title="${esc(
                              t('common.delete'),
                            )}">${icon('trash')}</button>
                          </td>
                        </tr>`,
                      )
                      .join('')}</tbody>
                    <tfoot><tr><td colspan="4">${esc(t('common.total'))}</td>
                      <td class="right">${money(total)}</td><td colspan="2"></td></tr></tfoot>
                  </table></div>`
                : emptyState(t('exp.none'), t('exp.none_sub'), 'wallet')
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>${esc(t('exp.by_category'))}</h3>
            <div class="sub">${esc(t('exp.by_category_sub'))}</div></div></div>
          <div class="card-body">
            ${byCategory.length ? barList(byCategory) : emptyState(t('exp.nothing'), t('exp.nothing_sub'), 'chart')}
          </div>
        </div>
      </div>`;

    body.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => edit(rows.find((e) => e.id === Number(b.dataset.edit)))),
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('exp.delete_title'),
          message: t('exp.delete_msg'),
          confirmLabel: t('common.delete'),
          danger: true,
        });
        if (!ok) return;
        await api.deleteExpense(b.dataset.del);
        toast(t('exp.deleted'), 'success');
        load();
      }),
    );
  }

  async function edit(expense) {
    const isNew = !expense;
    const data = await formModal({
      title: isNew ? t('exp.new') : t('exp.edit'),
      submitLabel: isNew ? t('exp.save') : t('common.save_changes'),
      fields: [
        {
          name: 'amount',
          label: t('common.amount'),
          type: 'number',
          step: '0.01',
          min: 0,
          value: expense?.amount ?? '',
          required: true,
          autofocus: true,
        },
        { name: 'date', label: t('common.date'), type: 'date', value: expense?.date || todayISO() },
        {
          name: 'category',
          label: t('common.category'),
          value: expense?.category || t('exp.cat.general'),
          list: 'exp-cats',
          datalist: categorySuggestions(used),
        },
        {
          name: 'method',
          label: t('exp.paid_by'),
          type: 'select',
          value: expense?.method || 'cash',
          options: EXPENSE_METHODS.map((m) => ({ value: m, label: methodText(m) })),
        },
        {
          name: 'note',
          label: t('common.note'),
          type: 'textarea',
          span: 2,
          value: expense?.note || '',
          placeholder: t('exp.note_placeholder'),
        },
      ],
    });
    if (!data) return;
    try {
      await api.saveExpense({ ...data, id: expense?.id });
      toast(isNew ? t('exp.saved') : t('exp.updated'), 'success');
      forgetSuggestions('expense_category');
      used = await suggestions('expense_category');
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  await load();
}
