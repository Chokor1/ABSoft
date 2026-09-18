import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, methodText, t } from '../i18n.js';
import {
  confirmDialog,
  dateText,
  debounce,
  downloadCsv,
  emptyState,
  esc,
  filterSelect,
  initials,
  loadPaymentMethods,
  methodMark,
  METHOD_ICONS,
  money,
  pager,
  shrinkImage,
  pct,
  forgetSuggestions,
  formPage,
  number,
  qtyText,
  rangeBar,
  signClass,
  statTile,
  store,
  toast,
  todayISO,
  toTop,
} from '../ui.js';

/** Only people and companies get contact details; a unit is just a word. */
const KINDS = [
  { kind: 'customer', contact: true },
  { kind: 'supplier', contact: true },
  { kind: 'category', contact: false },
  { kind: 'unit', contact: false },
  { kind: 'expense_category', contact: false },
  // How people pay, each with an icon for the till.
  { kind: 'payment_method', contact: false, icon: true },
];

/** #/lists, #/lists/<kind>, #/lists/<kind>/new, #/lists/<kind>/<id>[/<tab>], #/lists/<kind>/<id>/edit */
export async function render(root, ctx) {
  const [kind, second, third] = ctx.params;
  const known = KINDS.some((k) => k.kind === kind);
  if (known && second === 'new') return renderForm(root, ctx, kind, null);
  if (known && third === 'edit') return renderForm(root, ctx, kind, Number(second));
  if (PARTY_TABS[kind] && /^\d+$/.test(second || '')) return renderParty(root, ctx, kind, Number(second), third);
  return renderList(root, ctx, known ? kind : 'customer');
}

/** Open a customer's or supplier's page from a name on a document. */
export async function openParty(ctx, kind, name) {
  const rows = await api.entities(kind, { search: name, all: '1' });
  const hit = rows.find((r) => r.name.toLowerCase() === String(name).toLowerCase());
  if (hit) ctx.navigate(`lists/${kind}/${hit.id}`);
  else toast(t('party.not_listed', { name }), 'warn');
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
        <div class="card-body flush">
          ${
            state.rows.length
              ? `<div class="table-wrap table-scroll"><table class="data">
                  <thead><tr>
                    <th>${esc(t('lists.name'))}</th>
                    ${showContact ? `<th>${esc(t('lists.contact'))}</th>` : ''}
                    ${meta().icon ? `<th>${esc(t('lists.icon'))}</th>` : ''}
                    <th>${esc(t('common.note'))}</th>
                    <th class="right">${esc(t('lists.used'))}</th>
                    <th class="right">${esc(t('lists.in_use'))}</th>
                    <th></th>
                  </tr></thead>
                  <tbody>${state.rows
                    .map(
                      (r) => `<tr class="${isAdmin ? 'row-click' : ''}" data-edit="${r.id}">
                        <td>
                          <div class="cell-title">${esc(meta().icon ? methodText(r.name) : r.name)} ${
                            r.active ? '' : `<span class="badge">${esc(t('lists.hidden'))}</span>`
                          }${r.builtin ? `<span class="badge accent">${esc(t('lists.builtin'))}</span>` : ''}</div>
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
                        ${meta().icon ? `<td class="method-icon">${methodMark(r.icon)}</td>` : ''}
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
                               ${
                                 r.builtin
                                   ? ''
                                   : `<button class="btn btn-sm btn-ghost" data-del="${r.id}" title="${esc(
                                       t('common.remove'),
                                     )}">${icon('trash')}</button>`
                               }`
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

    // A customer or supplier opens on their own page; other names go straight to editing.
    body.querySelectorAll('[data-edit]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        const page = PARTY_TABS[state.kind] && !e.target.closest('[data-open]');
        ctx.navigate(`lists/${state.kind}/${tr.dataset.edit}${page ? '' : '/edit'}`);
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
      if (state.kind === 'payment_method') await loadPaymentMethods();
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
  const showIcon = KINDS.find((k) => k.kind === kind)?.icon;
  const one = t(`lists.one.${kind}`);
  // Editing a customer or supplier returns to their page.
  const back = () => ctx.navigate(entry && PARTY_TABS[kind] ? `lists/${kind}/${entry.id}` : `lists/${kind}`);
  if (id && !entry) return ctx.navigate(`lists/${kind}`);

  const form = formPage(root, {
    title: isNew ? t('lists.add', { one }) : t('lists.edit', { one }),
    subtitle: isNew ? '' : entry.name,
    submitLabel: isNew ? t('common.save') : t('common.save_changes'),
    fields: [
      {
        name: 'name',
        label: t('lists.name'),
        required: true,
        span: showIcon ? 1 : 2,
        value: entry?.name,
        autofocus: true,
        // Cash and On account are written on every past document; only their icon
        // and whether they are offered can change.
        readonly: !!entry?.builtin,
        help: entry?.builtin ? t('lists.builtin_help') : '',
      },
      ...(showIcon
        ? [
            {
              name: 'icon',
              label: t('lists.icon'),
              type: 'static',
              html: `<label>${esc(t('lists.icon'))}</label>
                <div class="method-pick">
                  <span class="method-preview" id="icon-preview">${methodMark(entry?.icon)}</span>
                  <select class="select" id="icon-choice" style="max-width:190px">${METHOD_ICONS.map(
                    (name) => `<option value="${name}" ${entry?.icon === name ? 'selected' : ''}>${esc(t(`lists.icon.${name}`))}</option>`,
                  ).join('')}</select>
                  <label class="btn btn-sm">${icon('image')} <span>${esc(t('lists.logo_upload'))}</span>
                    <input type="file" id="icon-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden/>
                  </label>
                  <button type="button" class="btn btn-sm btn-ghost" id="icon-clear" ${
                    String(entry?.icon || '').startsWith('data:') ? '' : 'hidden'
                  }>${esc(t('lists.logo_remove'))}</button>
                  <input type="hidden" name="icon" value="${esc(entry?.icon || 'coins')}"/>
                </div>
                <div class="help">${esc(t('lists.logo_help'))}</div>`,
            },
          ]
        : []),
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
        // The icon control is markup of its own, so its value is read here.
        const chosen = root.querySelector('input[name=icon]');
        await api.saveEntity(kind, { ...data, ...(chosen ? { icon: chosen.value } : {}), id: entry?.id });
        toast(isNew ? t('lists.created') : t('lists.updated'), 'success');
        forgetSuggestions(kind);
        // Every screen reads one copy of the ways to pay; keep it in step.
        if (kind === 'payment_method') await loadPaymentMethods();
        back();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
  if (showIcon) wireIconPicker(form);
}

/** The icon control: a drawn icon to choose, or the method's real logo uploaded. */
function wireIconPicker(form) {
  const hidden = form.querySelector('input[name=icon]');
  if (!hidden) return;
  const preview = form.querySelector('#icon-preview');
  const choice = form.querySelector('#icon-choice');
  const clear = form.querySelector('#icon-clear');
  const set = (value) => {
    hidden.value = value;
    preview.innerHTML = methodMark(value);
    clear.hidden = !value.startsWith('data:');
  };
  choice.addEventListener('change', () => set(choice.value));
  form.querySelector('#icon-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Shrunk to a small square here, so the logo travels with a backup.
      set(await shrinkImage(file, 96));
    } catch {
      toast(t('lists.logo_unreadable'), 'error');
    }
    e.target.value = '';
  });
  clear.addEventListener('click', () => set(choice.value || 'coins'));
}

/* ---------------------------------------------------- customer / supplier -- */

const PARTY_TABS = { customer: ['statement', 'invoices', 'items'], supplier: ['statement', 'purchases', 'items'] };

/** A customer's or supplier's own page: where they stand, their statement, their documents, what they bought. */
async function renderParty(root, ctx, kind, id, initialTab) {
  let party;
  try {
    party = await api.partySummary(kind, id);
  } catch (err) {
    toast(errorText(err), 'error');
    return ctx.navigate(`lists/${kind}`);
  }
  const { entity } = party;
  const tabs = PARTY_TABS[kind];
  const first = () => party.summary.first_date || todayISO();
  const state = { tab: tabs.includes(initialTab) ? initialTab : 'statement', from: first(), to: todayISO(), status: '', page: 1, per: 50 };
  let drop = () => {};

  ctx.actions.innerHTML = `
    ${kind === 'customer' ? `<button class="btn" id="to-analysis">${icon('chart')} ${esc(t('party.open_analysis'))}</button>` : ''}
    <button class="btn" id="edit">${icon('edit')} ${esc(t('common.edit'))}</button>`;
  ctx.actions.querySelector('#edit').addEventListener('click', () => ctx.navigate(`lists/${kind}/${id}/edit`));
  ctx.actions.querySelector('#to-analysis')?.addEventListener('click', () =>
    ctx.navigate(`reports/analysis/customer/${encodeURIComponent(entity.name)}/from/${state.from}/to/${state.to}/group/item`),
  );

  root.innerHTML = `
    <div class="card product-hero sticky-bar party-hero" id="hero"></div>
    <div class="stats party-stats" id="party-stats"></div>
    <div id="tab-body"></div>`;
  const hero = root.querySelector('#hero');
  const body = root.querySelector('#tab-body');

  const contact = [entity.phone, entity.email, entity.address, entity.tax_id ? `${t('lists.tax_id')} ${entity.tax_id}` : '']
    .filter(Boolean)
    .map((c) => `<span>${esc(c)}</span>`)
    .join('');
  hero.innerHTML = `
    <div class="ph-row">
      <button type="button" class="btn btn-ghost btn-icon" id="back" aria-label="${esc(t('common.back'))}">${icon('back')}</button>
      <span class="party-avatar ${kind}">${esc(initials(entity.name))}</span>
      <div class="ph-text">
        <h2>${esc(entity.name)}</h2>
        <div class="ph-badges">
          <span class="badge accent">${esc(t(`lists.one_title.${kind}`))}</span>
          ${entity.active ? '' : `<span class="badge">${esc(t('lists.hidden'))}</span>`}
          ${contact ? `<span class="party-contact">${contact}</span>` : ''}
        </div>
      </div>
      <div class="spacer"></div>
      <div class="seg" id="tabs">${tabs.map((k) => `<button data-tab="${k}">${esc(t(`party.tab.${k}`))}</button>`).join('')}</div>
    </div>`;
  hero.querySelector('#back').addEventListener('click', () => ctx.navigate(`lists/${kind}`));
  hero.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    state.page = 1;
    history.replaceState(null, '', `#/lists/${kind}/${id}/${state.tab}`);
    toTop();
    showTab();
  });

  const s = party.summary;
  root.querySelector('#party-stats').innerHTML =
    kind === 'customer'
      ? `${statTile({
          label: t('party.balance'),
          value: `<span class="${s.balance > 0.004 ? 'money-neg' : ''}">${money(s.balance)}</span>`,
          foot: s.open_invoices ? t('party.open_invoices', { n: number(s.open_invoices) }) : t('party.settled'),
          iconName: 'wallet',
          tint: s.balance > 0.004 ? 'danger' : 'success',
        })}
        ${statTile({
          label: t('party.total_sales'),
          value: money(s.total),
          foot: t('party.invoices_avg', { n: number(s.invoices), v: money(s.avg_invoice) }),
          iconName: 'receipt',
          tint: 'info',
        })}
        ${statTile({
          label: t('pay.paid'),
          value: money(s.paid),
          foot: s.last_payment ? t('party.last_payment', { v: money(s.last_payment.amount), d: dateText(s.last_payment.date) }) : t('pay.no_payments'),
          iconName: 'coins',
        })}
        ${statTile({
          label: t('common.profit'),
          value: `<span class="${signClass(s.profit)}">${money(s.profit)}</span>`,
          foot: `${t('common.margin')} ${pct(s.margin)}`,
          iconName: 'trendUp',
          tint: s.profit >= 0 ? 'success' : 'danger',
        })}
        ${statTile({
          label: t('party.last_sale'),
          value: s.last_date ? dateText(s.last_date) : t('common.none'),
          foot: s.first_date ? t('party.since', { d: dateText(s.first_date) }) : t('party.no_sales'),
          iconName: 'history',
        })}`
      : `${statTile({
          label: t('party.total_purchased'),
          value: money(s.total),
          foot: t('party.purchases_n', { n: number(s.purchases) }),
          iconName: 'truck',
          tint: 'info',
        })}
        ${statTile({ label: t('party.avg_purchase'), value: money(s.avg_purchase), iconName: 'receipt' })}
        ${statTile({ label: t('party.items_bought'), value: number(s.items), foot: t('party.items_bought_foot'), iconName: 'box' })}
        ${statTile({
          label: t('party.last_purchase'),
          value: s.last_date ? dateText(s.last_date) : t('common.none'),
          foot: s.first_date ? t('party.since_supplier', { d: dateText(s.first_date) }) : t('party.no_purchases'),
          iconName: 'history',
        })}`;

  const loading = () =>
    (body.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(t('common.loading'))}</p></div></div></div>`);

  /** The date bar shared by the statement and items tabs, with a way back to everything. */
  function datesBar(reload) {
    const bar = rangeBar(state, (r) => {
      Object.assign(state, r);
      reload();
    });
    bar.querySelector('.seg').insertAdjacentHTML('beforeend', `<button data-all>${esc(t('party.all_time'))}</button>`);
    bar.querySelector('[data-all]').addEventListener('click', () => {
      Object.assign(state, { from: first(), to: todayISO() });
      reload();
    });
    return bar;
  }

  function showTab() {
    drop();
    drop = () => {};
    hero.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    loading();
    ({ statement: tabStatement, invoices: tabInvoices, purchases: tabPurchases, items: tabItems })[state.tab]();
  }

  /* The statement: brought forward, every document and payment, the balance after each. */
  async function tabStatement() {
    const st = await api.partyStatement(kind, id, { from: state.from, to: state.to });
    if (state.tab !== 'statement') return;
    const customer = kind === 'customer';
    const heads = customer
      ? [t('common.date'), t('party.type'), t('party.document'), t('party.method'), t('party.invoiced'), t('pay.paid'), t('pay.balance')]
      : [t('common.date'), t('party.document'), t('common.lines'), t('common.note'), t('common.amount'), t('party.running_total')];
    const nums = customer ? 3 : 2; // how many columns at the end are amounts
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div><h3>${esc(t(customer ? 'party.statement' : 'party.statement_supplier'))}</h3>
          <div class="sub">${dateText(st.from)} → ${dateText(st.to)} · ${esc(t('party.entries', { n: number(st.entries.length) }))}</div></div>
        <div class="spacer"></div>
        <span class="badge">${esc(t('party.opening_badge', { v: money(st.opening) }))}</span>
        <span class="badge ${customer && st.closing > 0.004 ? 'warn' : 'accent'}">${esc(t(customer ? 'party.closing_badge' : 'party.total_badge', { v: money(st.closing) }))}</span>
      </div>
      <div class="card-body flush">${
        st.entries.length || st.opening
          ? `<div class="table-wrap table-scroll"><table class="data party-statement">
              <thead><tr>${heads.map((h, i) => `<th class="${i >= heads.length - nums ? 'right' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
              <tbody>
                <tr class="st-opening"><td class="nowrap">${dateText(st.from)}</td>
                  <td colspan="${heads.length - 2}">${esc(t('party.brought_forward'))}</td>
                  <td class="right"><b>${money(st.opening)}</b></td></tr>
                ${st.entries
                  .map((e) =>
                    customer
                      ? `<tr class="row-click" data-sale="${e.sale_id}">
                          <td class="nowrap">${dateText(e.date)}</td>
                          <td><span class="badge ${e.type === 'invoice' ? 'accent' : 'success'}">${esc(t(`party.entry.${e.type}`))}</span></td>
                          <td class="mono nowrap">${esc(e.doc_no)}</td>
                          <td class="muted">${e.type === 'payment' ? esc(methodText(e.method)) : ''}</td>
                          <td class="right">${e.debit ? money(e.debit) : ''}</td>
                          <td class="right money-pos">${e.credit ? money(e.credit) : ''}</td>
                          <td class="right"><b class="${e.balance > 0.004 ? '' : 'muted'}">${money(e.balance)}</b></td>
                        </tr>`
                      : `<tr class="row-click" data-purchase="${e.purchase_id}">
                          <td class="nowrap">${dateText(e.date)}</td>
                          <td class="mono nowrap">${esc(e.doc_no)}</td>
                          <td>${number(e.lines)}</td>
                          <td class="muted">${esc(e.note || '')}</td>
                          <td class="right">${money(e.debit)}</td>
                          <td class="right"><b>${money(e.balance)}</b></td>
                        </tr>`,
                  )
                  .join('')}
              </tbody>
              <tfoot><tr>
                <td colspan="${heads.length - nums}">${esc(t(customer ? 'party.closing' : 'party.total_to', { d: dateText(st.to) }))}</td>
                ${customer ? `<td class="right">${money(st.debit)}</td><td class="right">${money(st.credit)}</td>` : `<td class="right">${money(st.debit)}</td>`}
                <td class="right">${money(st.closing)}</td>
              </tr></tfoot>
            </table></div>`
          : emptyState(t('party.no_entries'), t('party.no_entries_sub'), 'history')
      }</div>
      ${customer ? '' : `<div class="card-body party-note muted">${esc(t('party.supplier_note'))}</div>`}`;
    body.innerHTML = '';
    body.append(datesBar(tabStatement), card);
    card.querySelectorAll('[data-sale]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`sales/${tr.dataset.sale}`)));
    card.querySelectorAll('[data-purchase]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`purchases/${tr.dataset.purchase}`)),
    );
  }

  /* A customer's invoices, with what is still owed on each. */
  async function tabInvoices() {
    const result = await api.sales({ customer: entity.name, status: state.status, page: state.page, per: state.per });
    if (state.tab !== 'invoices') return;
    const sum = result.sums || {};
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    bar.append(
      filterSelect({
        label: t('filter.status'),
        value: state.status,
        options: [
          { value: '', label: t('filter.all') },
          { value: 'unpaid', label: t('pay.status_unpaid') },
          { value: 'partial', label: t('pay.status_partial') },
          { value: 'paid', label: t('pay.status_paid') },
        ],
        onChange: (v) => {
          state.status = v;
          state.page = 1;
          tabInvoices();
        },
      }),
    );
    const status = (r) =>
      r.balance <= 0.004
        ? `<span class="badge success">${esc(t('pay.status_paid'))}</span>`
        : r.paid > 0.004
          ? `<span class="badge warn">${esc(t('pay.status_partial'))}</span>`
          : `<span class="badge danger">${esc(t('pay.status_unpaid'))}</span>`;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div><h3>${esc(t('party.tab.invoices'))}</h3><div class="sub">${esc(t('party.invoices_n', { n: number(result.total) }))}</div></div>
        <div class="spacer"></div>
        <span class="badge accent">${esc(t('sales.revenue_badge', { v: money(sum.total || 0) }))}</span>
        ${sum.balance > 0.004 ? `<span class="badge warn">${esc(t('pay.owed_badge', { v: money(sum.balance) }))}</span>` : ''}
      </div>
      <div class="card-body flush">${
        result.rows.length
          ? `<div class="table-wrap table-scroll"><table class="data">
              <thead><tr><th>${esc(t('sales.invoice'))}</th><th>${esc(t('common.date'))}</th>
                <th class="right">${esc(t('common.items'))}</th><th class="right">${esc(t('common.total'))}</th>
                <th class="right">${esc(t('pay.paid'))}</th><th class="right">${esc(t('pay.balance'))}</th>
                <th>${esc(t('pay.status'))}</th><th class="right">${esc(t('common.profit'))}</th></tr></thead>
              <tbody>${result.rows
                .map(
                  (r) => `<tr class="row-click" data-sale="${r.id}">
                    <td class="mono nowrap">${esc(r.doc_no)}</td>
                    <td class="nowrap">${dateText(r.date)}</td>
                    <td class="right muted">${number(r.line_count)}</td>
                    <td class="right"><b>${money(r.total)}</b></td>
                    <td class="right">${money(r.paid)}</td>
                    <td class="right ${r.balance > 0.004 ? 'money-neg' : 'muted'}">${money(r.balance)}</td>
                    <td>${status(r)}</td>
                    <td class="right ${signClass(r.profit)}">${money(r.profit)}</td>
                  </tr>`,
                )
                .join('')}</tbody>
              <tfoot><tr><td colspan="3">${esc(result.pages > 1 ? t('an.totals_all') : t('common.totals'))}</td>
                <td class="right">${money(sum.total || 0)}</td><td class="right">${money((sum.total || 0) - (sum.balance || 0))}</td>
                <td class="right">${money(sum.balance || 0)}</td><td></td>
                <td class="right">${money(sum.profit || 0)}</td></tr></tfoot>
            </table></div>`
          : emptyState(t('party.no_invoices'), t('party.no_invoices_sub'), 'receipt')
      }</div>`;
    if (result.rows.length) {
      card.append(
        pager(result, ({ page, per }) => {
          Object.assign(state, { page, per });
          tabInvoices();
        }),
      );
    }
    body.innerHTML = '';
    body.append(bar, card);
    card.querySelectorAll('[data-sale]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`sales/${tr.dataset.sale}`)));
  }

  /* A supplier's purchases. */
  async function tabPurchases() {
    const result = await api.purchases({ supplier: entity.name, page: state.page, per: state.per });
    if (state.tab !== 'purchases') return;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div><h3>${esc(t('party.tab.purchases'))}</h3><div class="sub">${esc(t('party.purchases_n', { n: number(result.total) }))}</div></div>
        <div class="spacer"></div>
        <span class="badge accent">${money(result.sums?.total || 0)}</span>
      </div>
      <div class="card-body flush">${
        result.rows.length
          ? `<div class="table-wrap table-scroll"><table class="data">
              <thead><tr><th>${esc(t('party.document'))}</th><th>${esc(t('common.date'))}</th>
                <th class="right">${esc(t('common.lines'))}</th><th class="right">${esc(t('common.qty'))}</th>
                <th class="right">${esc(t('common.total'))}</th><th>${esc(t('common.note'))}</th></tr></thead>
              <tbody>${result.rows
                .map(
                  (r) => `<tr class="row-click" data-purchase="${r.id}">
                    <td class="mono nowrap">${esc(r.doc_no)}</td>
                    <td class="nowrap">${dateText(r.date)}</td>
                    <td class="right muted">${number(r.line_count)}</td>
                    <td class="right">${qtyText(r.total_qty)}</td>
                    <td class="right"><b>${money(r.total)}</b></td>
                    <td class="muted">${esc(r.note || '')}</td>
                  </tr>`,
                )
                .join('')}</tbody>
              <tfoot><tr><td colspan="4">${esc(result.pages > 1 ? t('an.totals_all') : t('common.totals'))}</td>
                <td class="right">${money(result.sums?.total || 0)}</td><td></td></tr></tfoot>
            </table></div>`
          : emptyState(t('party.no_purchases'), t('party.no_purchases_sub'), 'truck')
      }</div>`;
    if (result.rows.length) {
      card.append(
        pager(result, ({ page, per }) => {
          Object.assign(state, { page, per });
          tabPurchases();
        }),
      );
    }
    body.innerHTML = '';
    body.append(card);
    card.querySelectorAll('[data-purchase]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`purchases/${tr.dataset.purchase}`)),
    );
  }

  /* What they bought from us, or what we bought from them. */
  async function tabItems() {
    const customer = kind === 'customer';
    const range = { from: state.from, to: state.to };
    const result = customer
      ? await api.salesAnalysis({ ...range, customer: entity.name, group: 'item', all: '1' })
      : await api.supplierItems(id, range);
    if (state.tab !== 'items') return;
    const rows = result.rows;
    const card = document.createElement('div');
    card.className = 'card';
    const tot = customer ? result.totals : result.totals;
    card.innerHTML = `
      <div class="card-head">
        <div><h3>${esc(t(customer ? 'party.items_customer' : 'party.items_supplier'))}</h3>
          <div class="sub">${dateText(result.from)} → ${dateText(result.to)} · ${esc(t('party.products_n', { n: number(rows.length) }))}</div></div>
      </div>
      <div class="card-body flush">${
        rows.length
          ? customer
            ? `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('an.item'))}</th><th class="right">${esc(t('common.qty'))}</th>
                  <th class="right">${esc(t('an.invoices'))}</th><th class="right">${esc(t('an.avg_price'))}</th>
                  <th class="right">${esc(t('an.sales'))}</th><th class="right">${esc(t('common.profit'))}</th>
                  <th class="right">${esc(t('common.margin'))}</th></tr></thead>
                <tbody>${rows
                  .map(
                    (r) => `<tr class="row-click" data-product="${r.product_id}">
                      <td><div class="cell-title">${esc(r.name)}</div><div class="cell-sub">${esc(r.category || '')}</div></td>
                      <td class="right nowrap">${qtyText(r.qty)} <span class="muted">${esc(r.unit)}</span></td>
                      <td class="right muted">${number(r.invoices)}</td>
                      <td class="right">${r.qty ? money(r.sales / r.qty) : ''}</td>
                      <td class="right"><b>${money(r.sales)}</b></td>
                      <td class="right ${signClass(r.profit)}">${money(r.profit)}</td>
                      <td class="right">${pct(r.margin)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr><td>${esc(t('common.totals'))}</td><td class="right">${qtyText(tot.qty)}</td>
                  <td class="right">${number(tot.invoices)}</td><td></td>
                  <td class="right">${money(tot.sales)}</td><td class="right">${money(tot.profit)}</td>
                  <td class="right">${pct(tot.margin)}</td></tr></tfoot>
              </table></div>`
            : `<div class="table-wrap table-scroll"><table class="data">
                <thead><tr><th>${esc(t('an.item'))}</th><th class="right">${esc(t('common.qty'))}</th>
                  <th class="right">${esc(t('party.tab.purchases'))}</th><th class="right">${esc(t('party.avg_cost'))}</th>
                  <th class="right">${esc(t('party.last_cost'))}</th><th class="right">${esc(t('common.total'))}</th>
                  <th>${esc(t('party.last_bought'))}</th></tr></thead>
                <tbody>${rows
                  .map(
                    (r) => `<tr class="row-click" data-product="${r.product_id}">
                      <td><div class="cell-title">${esc(r.name)}</div><div class="cell-sub">${esc(r.category || '')}</div></td>
                      <td class="right nowrap">${qtyText(r.qty)} <span class="muted">${esc(r.unit)}</span></td>
                      <td class="right muted">${number(r.purchases)}</td>
                      <td class="right">${money(r.avg_cost)}</td>
                      <td class="right muted">${money(r.last_cost)}</td>
                      <td class="right"><b>${money(r.total)}</b></td>
                      <td class="nowrap">${dateText(r.last_date)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
                <tfoot><tr><td>${esc(t('common.totals'))}</td><td class="right">${qtyText(tot.qty)}</td>
                  <td colspan="3"></td><td class="right">${money(tot.total)}</td><td></td></tr></tfoot>
              </table></div>`
          : emptyState(t('party.no_items'), t('party.no_items_sub'), 'box')
      }</div>`;
    body.innerHTML = '';
    body.append(datesBar(tabItems), card);
    card.querySelectorAll('[data-product]').forEach((tr) =>
      tr.addEventListener('click', () => ctx.navigate(`products/${tr.dataset.product}/${customer ? 'sales' : 'purchases'}`)),
    );
  }

  showTab();
  return () => drop();
}
