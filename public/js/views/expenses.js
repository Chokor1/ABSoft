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
  filterSelect,
  listSummary,
  pager,
  forgetSuggestions,
  formPage,
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

/** #/expenses, #/expenses/new, #/expenses/<id>/edit */
export async function render(root, ctx) {
  const [first, second] = ctx.params;
  if (first === 'new') return renderForm(root, ctx, null);
  if (second === 'edit') return renderForm(root, ctx, Number(first));
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  const state = { from: monthStart(), to: todayISO(), search: '', category: '', page: 1, per: 50 };
  let rows = [];
  let used = await suggestions('expense_category');

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('exp.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate('expenses/new'));
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
    refilter();
  });
  bar.classList.add('sticky-bar');
  const refilter = () => {
    state.page = 1;
    load();
  };
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

  bar.appendChild(
    filterSelect({
      label: t('filter.category'),
      value: state.category,
      options: [{ value: '', label: t('filter.all') }, ...used.map((c) => ({ value: c, label: c }))],
      onChange: (v) => {
        state.category = v;
        refilter();
      },
    }),
  );

  const summary = listSummary(bar);
  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(bar, body);

  async function load() {
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const result = await api.expenses({
      from: state.from,
      to: state.to,
      search: state.search,
      category: state.category,
      page: state.page,
      per: state.per,
    });
    rows = result.rows;
    // The badge and the breakdown cover the whole period; the table shows a page.
    const total = result.sums.total;
    const byCategory = result.byCategory.map((c) => ({ label: c.category, value: c.amount }));

    summary.innerHTML = `
      <span class="ls-count">${esc(count('exp', result.total))}</span>
      <span class="badge danger">${esc(t('exp.total_badge', { v: money(total) }))}</span>`;

    body.innerHTML = `
      <div class="grid cols-2 split-wide">
        <div class="card">
          <div class="card-body flush">
            ${
              rows.length
                ? `<div class="table-wrap table-scroll"><table class="data">
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

    if (rows.length) {
      body.querySelector('.card').append(
        pager(result, ({ page, per }) => {
          state.page = page;
          state.per = per;
          load();
        }),
      );
    }

    body.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => ctx.navigate(`expenses/${b.dataset.edit}/edit`)),
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

  await load();
}

/** The expense form on its own page. */
async function renderForm(root, ctx, id) {
  const [expense, used] = await Promise.all([
    id ? api.expense(id) : null,
    suggestions('expense_category'),
  ]);
  const isNew = !expense;
  const back = () => ctx.navigate('expenses');

  formPage(root, {
    title: isNew ? t('exp.new') : t('exp.edit'),
    submitLabel: isNew ? t('exp.save') : t('common.save_changes'),
    fields: [
      {
        name: 'amount', label: t('common.amount'), type: 'number', step: '0.01', min: 0,
        value: expense?.amount ?? '', required: true, autofocus: true,
      },
      { name: 'date', label: t('common.date'), type: 'date', value: expense?.date || todayISO() },
      {
        name: 'category', label: t('common.category'),
        value: expense?.category || t('exp.cat.general'),
        names: 'expense_category', choices: categorySuggestions(used),
      },
      {
        name: 'method', label: t('exp.paid_by'), type: 'select',
        value: expense?.method || 'cash',
        options: EXPENSE_METHODS.map((m) => ({ value: m, label: methodText(m) })),
      },
      {
        name: 'note', label: t('common.note'), type: 'textarea', span: 2,
        value: expense?.note || '', placeholder: t('exp.note_placeholder'),
      },
    ],
    onCancel: back,
    onSubmit: async (data) => {
      try {
        await api.saveExpense({ ...data, id: expense?.id });
        toast(isNew ? t('exp.saved') : t('exp.updated'), 'success');
        forgetSuggestions('expense_category');
        back();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}
