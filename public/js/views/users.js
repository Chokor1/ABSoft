import { api } from '../api.js';
import { icon } from '../icons.js';
import { errorText, roleText, t } from '../i18n.js';
import { confirmDialog, dateText, emptyState, esc, formModal, initials, number, store, toast } from '../ui.js';

export async function render(root, ctx) {
  ctx.actions.innerHTML = `<button class="btn btn-primary" id="new">${icon('plus')} ${esc(t('users.new'))}</button>`;
  ctx.actions.querySelector('#new').addEventListener('click', () => edit(null));

  async function load() {
    root.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><p>${esc(
      t('common.loading'),
    )}</p></div></div></div>`;
    const rows = await api.users();

    root.innerHTML = `
      <div class="card"><div class="card-body flush">
        ${
          rows.length
            ? `<div class="table-wrap"><table class="data">
                <thead><tr><th>${esc(t('common.user'))}</th><th>${esc(t('users.role'))}</th>
                  <th>${esc(t('users.status'))}</th><th class="right">${esc(t('users.sales'))}</th>
                  <th>${esc(t('users.added'))}</th><th></th></tr></thead>
                <tbody>${rows
                  .map(
                    (u) => `<tr>
                      <td><div style="display:flex;align-items:center;gap:10px">
                        <div class="avatar">${esc(initials(u.full_name || u.username))}</div>
                        <div><div class="cell-title">${esc(u.full_name || u.username)}</div>
                          <div class="cell-sub">${esc(u.username)}${u.id === store.user.id ? esc(t('users.you')) : ''}</div></div>
                      </div></td>
                      <td><span class="badge ${u.role === 'admin' ? 'accent' : ''}">${esc(roleText(u.role))}</span></td>
                      <td><span class="badge ${u.active ? 'success' : 'danger'}">${esc(
                        u.active ? t('users.active') : t('users.disabled'),
                      )}</span></td>
                      <td class="right">${number(u.sales_count)}</td>
                      <td class="muted nowrap">${dateText(u.created_at)}</td>
                      <td class="right nowrap">
                        <button class="btn btn-sm btn-ghost" data-edit="${u.id}" title="${esc(t('common.edit'))}">${icon(
                          'edit',
                        )}</button>
                        <button class="btn btn-sm btn-ghost" data-del="${u.id}" title="${esc(
                          t('common.remove'),
                        )}">${icon('trash')}</button>
                      </td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>`
            : emptyState(t('users.none'), t('users.none_sub'), 'users')
        }
      </div></div>`;

    root.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => edit(rows.find((u) => u.id === Number(b.dataset.edit)))),
    );
    root.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const user = rows.find((u) => u.id === Number(b.dataset.del));
        const ok = await confirmDialog({
          title: t('users.remove_title', { name: user.username }),
          message: t('users.remove_msg'),
          confirmLabel: t('users.remove_confirm'),
          danger: true,
        });
        if (!ok) return;
        try {
          const res = await api.deleteUser(user.id);
          toast(res.archived ? t('users.archived') : t('users.removed'), 'success');
          load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }),
    );
  }

  async function edit(user) {
    const isNew = !user;
    const data = await formModal({
      title: isNew ? t('users.new') : t('users.edit', { name: user.username }),
      subtitle: isNew ? t('users.add_sub') : '',
      submitLabel: isNew ? t('users.create') : t('common.save_changes'),
      fields: [
        ...(isNew
          ? [
              {
                name: 'username',
                label: t('login.username'),
                required: true,
                autofocus: true,
                placeholder: t('users.username_placeholder'),
              },
            ]
          : [
              {
                type: 'static',
                html: `<label>${esc(t('login.username'))}</label><input class="input" value="${esc(
                  user.username,
                )}" disabled/>`,
              },
            ]),
        { name: 'full_name', label: t('users.full_name'), value: user?.full_name || '', placeholder: t('users.name_placeholder') },
        {
          name: 'role',
          label: t('users.role'),
          type: 'select',
          value: user?.role || 'cashier',
          options: [
            { value: 'cashier', label: roleText('cashier') },
            { value: 'admin', label: roleText('admin') },
          ],
        },
        {
          name: 'password',
          label: isNew ? t('login.password') : t('users.new_password'),
          type: 'password',
          required: isNew,
          help: isNew ? t('users.password_help') : t('users.password_keep'),
        },
        ...(isNew ? [] : [{ name: 'active', label: t('users.active_label'), type: 'checkbox', value: !!user.active, span: 2 }]),
      ],
    });
    if (!data) return;
    try {
      await api.saveUser({ ...data, id: user?.id });
      toast(isNew ? t('users.created') : t('users.updated'), 'success');
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  await load();
}
