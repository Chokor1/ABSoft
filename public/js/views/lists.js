import { api } from '../api.js';
import { icon } from '../icons.js';
import { count, errorText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  pager,
  forgetSuggestions,
  formPage,
  number,
  store,
  toast,
} from '../ui.js';

/** Only people and companies get contact details; a unit is just a word. */
const KINDS = [
  { kind: 'customer', contact: true },
  { kind: 'supplier', contact: true },
  { kind: 'category', contact: false },
  { kind: 'unit', contact: false },
  { kind: 'expense_category', contact: false },
];

/** #/lists, #/lists/<kind>, #/lists/<kind>/new, #/lists/<kind>/<id>/edit */
export async function render(root, ctx) {
  const [kind, second, third] = ctx.params;
  const known = KINDS.some((k) => k.kind === kind);
  if (known && second === 'new') return renderForm(root, ctx, kind, null);
  if (known && third === 'edit') return renderForm(root, ctx, kind, Number(second));
  return renderList(root, ctx, known ? kind : 'customer');
}

async function renderList(root, ctx, startKind) {
  const state = { kind: startKind, search: '', rows: [], page: 1, per: 50 };
  const isAdmin = store.user.role === 'admin';
  const meta = () => KINDS.find((k) => k.kind === state.kind);
  const one = () => t(`lists.one.${state.kind}`);

  ctx.actions.innerHTML = `
    <button class="btn" id="export">${icon('download')} ${esc(t('common.export'))}</button>
    <button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('lists.add', { one: one() }))}</button>`;

  const tabs = document.createElement('div');
  tabs.className = 'toolbar sticky-bar';
  tabs.innerHTML = `
    <div class="seg">${KINDS.map((k) => `<button data-kind="${k.kind}">${esc(t(`lists.tab.${k.kind}`))}</button>`).join(
      '',
    )}</div>
    <div class="input-icon" style="min-width:230px">${icon('search')}
      <input class="input" data-search id="list-search" placeholder="${esc(t('lists.search'))}"/>
    </div>
    <div class="spacer"></div>`;

  const body = document.createElement('div');
  root.innerHTML = '';
  root.append(tabs, body);

  // A new tab or a new search starts again at the first page.
  const refilter = () => {
    state.page = 1;
    load();
  };
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]');
    if (!btn) return;
    state.kind = btn.dataset.kind;
    state.search = '';
    state.page = 1;
    tabs.querySelector('#list-search').value = '';
    ctx.actions.querySelector('#new').innerHTML = `${icon('plus')} ${esc(t('lists.add', { one: one() }))}`;
    load();
  });
  tabs.querySelector('#list-search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      refilter();
    }, 220),
  );

  ctx.actions.querySelector('#new').addEventListener('click', () => ctx.navigate(`lists/${state.kind}/new`));
  ctx.actions.querySelector('#export').addEventListener('click', () =>
    downloadCsv(
      `absoft-${state.kind}.csv`,
      state.rows.map((r) => ({
        name: r.name,
        phone: r.phone,
        email: r.email,
        address: r.address,
        tax_id: r.tax_id,
        note: r.note,
        times_used: r.used_count,
        on_record: r.in_use,
        active: r.active ? 'yes' : 'no',
      })),
    ),
  );

  async function load() {
    tabs.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.kind));
    body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;

    const result = await api.entities(state.kind, { search: state.search, all: '1', page: state.page, per: state.per });
    state.rows = result.rows;
    const showContact = meta().contact;

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${esc(t(`lists.tab.${state.kind}`))}</h3>
            <div class="sub">${esc(count('lists', result.total))}</div></div>
        </div>
        <div class="card-body flush">
          ${
            state.rows.length
              ? `<div class="table-wrap table-scroll"><table class="data">
                  <thead><tr>
                    <th>${esc(t('lists.name'))}</th>
                    ${showContact ? `<th>${esc(t('lists.contact'))}</th>` : ''}
                    <th>${esc(t('common.note'))}</th>
                    <th class="right">${esc(t('lists.used'))}</th>
                    <th class="right">${esc(t('lists.in_use'))}</th>
                    <th></th>
                  </tr></thead>
                  <tbody>${state.rows
                    .map(
                      (r) => `<tr class="${isAdmin ? 'row-click' : ''}" data-edit="${r.id}">
                        <td>
                          <div class="cell-title">${esc(r.name)} ${
                            r.active ? '' : `<span class="badge">${esc(t('lists.hidden'))}</span>`
                          }</div>
                          ${r.address ? `<div class="cell-sub">${esc(r.address)}</div>` : ''}
                        </td>
                        ${
                          showContact
                            ? `<td class="cell-sub">${
                                [r.phone, r.email].filter(Boolean).map(esc).join('<br/>') ||
                                `<span class="muted">${t('common.none')}</span>`
                              }</td>`
                            : ''
                        }
                        <td class="cell-sub">${esc(r.note || '')}</td>
                        <td class="right muted">${number(r.used_count)}</td>
                        <td class="right">${
                          r.in_use
                            ? `<span class="badge success">${number(r.in_use)}</span>`
                            : `<span class="muted">0</span>`
                        }</td>
                        <td class="right nowrap">${
                          isAdmin
                            ? `<button class="btn btn-sm btn-ghost" data-open="${r.id}" title="${esc(
                                t('common.edit'),
                              )}">${icon('edit')}</button>
                               <button class="btn btn-sm btn-ghost" data-del="${r.id}" title="${esc(
                                 t('common.remove'),
                               )}">${icon('trash')}</button>`
                            : ''
                        }</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : emptyState(
                  state.search ? t('lists.none_match') : t('lists.none'),
                  state.search ? t('lists.none_match_sub') : t('lists.none_sub'),
                  meta().contact ? 'users' : 'box',
                )
          }
        </div>
      </div>
      <p class="muted" style="font-size:12.5px;margin-top:14px;max-width:70ch">${esc(t('lists.hint'))}</p>`;

    if (!isAdmin) return;
    if (state.rows.length) {
      body.querySelector('.card').append(
        pager(result, ({ page, per }) => {
          state.page = page;
          state.per = per;
          load();
        }),
      );
    }

    body.querySelectorAll('[data-edit]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        ctx.navigate(`lists/${state.kind}/${tr.dataset.edit}/edit`);
      }),
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        remove(state.rows.find((r) => r.id === Number(b.dataset.del)));
      }),
    );
  }

  async function remove(entry) {
    const ok = await confirmDialog({
      title: t('lists.delete_title', { name: entry.name }),
      message: t('lists.delete_msg'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteEntity(state.kind, entry.id);
      toast(t('lists.deleted'), 'success');
      forgetSuggestions(state.kind);
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  await load();
}

/** A directory entry on its own page; contact fields only where they make sense. */
async function renderForm(root, ctx, kind, id) {
  const rows = await api.entities(kind, { all: '1' });
  const entry = id ? rows.find((r) => r.id === id) : null;
  const isNew = !entry;
  const showContact = KINDS.find((k) => k.kind === kind)?.contact;
  const one = t(`lists.one.${kind}`);
  const back = () => ctx.navigate(`lists/${kind}`);
  if (id && !entry) return back();

  formPage(root, {
    title: isNew ? t('lists.add', { one }) : t('lists.edit', { one }),
    subtitle: isNew ? '' : entry.name,
    submitLabel: isNew ? t('common.save') : t('common.save_changes'),
    fields: [
      { name: 'name', label: t('lists.name'), required: true, span: 2, value: entry?.name, autofocus: true },
      ...(showContact
        ? [
            { name: 'phone', label: t('lists.phone'), value: entry?.phone || '' },
            { name: 'email', label: t('lists.email'), type: 'email', value: entry?.email || '' },
            { name: 'address', label: t('lists.address'), span: 2, value: entry?.address || '' },
            { name: 'tax_id', label: t('lists.tax_id'), span: 2, value: entry?.tax_id || '' },
          ]
        : []),
      { name: 'note', label: t('common.note'), type: 'textarea', span: 2, value: entry?.note || '' },
      ...(isNew
        ? []
        : [{ name: 'active', label: t('lists.active'), type: 'checkbox', value: !!entry.active, span: 2 }]),
      ...(!isNew && entry.in_use
        ? [
            {
              type: 'static',
              span: 2,
              html: `<div class="help" style="color:var(--info)">${esc(
                t('lists.rename_note', { n: entry.in_use }),
              )}</div>`,
            },
          ]
        : []),
    ],
    onCancel: back,
    onSubmit: async (data) => {
      try {
        await api.saveEntity(kind, { ...data, id: entry?.id });
        toast(isNew ? t('lists.created') : t('lists.updated'), 'success');
        forgetSuggestions(kind);
        back();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}
