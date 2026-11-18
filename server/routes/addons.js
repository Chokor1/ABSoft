import { db, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, num, required, str } from '../util.js';

/**
 * Add-ons: the extras a line can carry — toppings on a crêpe, protein in a shake —
 * each at its own price. They come in lists ("Crêpe toppings"), and a product
 * offers at most one list. A shop with no list, or a product without one, sells
 * exactly as before.
 *
 * A sale line keeps the add-ons it was made with by name and price, as text, so
 * an old invoice still reads "Lotus Biscuit +$1" after the list is changed or
 * removed. Add-ons are priced, not stocked: what they use comes out of stock
 * with recipes.
 */

const MAX_ADDONS = 40;

const groupRow = (id) => db.prepare(`SELECT * FROM addon_groups WHERE id = ?`).get(id) || null;

/** A list with its add-ons, in the shop's order, and how many products offer it. */
export function loadGroup(id) {
  const group = groupRow(id);
  if (!group) return null;
  const items = db
    .prepare(`SELECT id, name, price, cost FROM addons WHERE group_id = ? ORDER BY sort, id`)
    .all(group.id)
    .map((a) => ({ ...a, price: num(a.price), cost: num(a.cost) }));
  const products = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE addon_group_id = ?`).get(group.id).n;
  return { id: group.id, name: group.name, items, products };
}

/** The add-ons sent with a list, checked: each has a name, no two share one. */
function readItems(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = str(raw?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest(`"${name}" is listed twice`, 'ADDON_TWICE', { name });
    seen.add(key);
    out.push({ id: Number(raw.id) || null, name, price: money(Math.max(0, num(raw.price))), cost: money(Math.max(0, num(raw.cost))) });
  }
  if (out.length > MAX_ADDONS) throw badRequest(`A list can hold at most ${MAX_ADDONS} add-ons`, 'ADDONS_TOO_MANY', { n: MAX_ADDONS });
  return out;
}

/** Write a list's add-ons: kept ids are updated in place, the ones left out are removed. */
function setItems(groupId, items) {
  const keep = new Set(items.filter((a) => a.id).map((a) => a.id));
  const drop = db.prepare(`DELETE FROM addons WHERE id = ?`);
  for (const row of db.prepare(`SELECT id FROM addons WHERE group_id = ?`).all(groupId)) if (!keep.has(row.id)) drop.run(row.id);
  const update = db.prepare(`UPDATE addons SET name = ?, price = ?, cost = ?, sort = ? WHERE id = ? AND group_id = ?`);
  const insert = db.prepare(`INSERT INTO addons (group_id, name, price, cost, sort) VALUES (?, ?, ?, ?, ?)`);
  items.forEach((a, i) => {
    const updated = a.id ? update.run(a.name, a.price, a.cost, i, a.id, groupId).changes : 0;
    if (!updated) insert.run(groupId, a.name, a.price, a.cost, i);
  });
}

const assertFreeName = (name, ignoreId = 0) => {
  const clash = db.prepare(`SELECT id FROM addon_groups WHERE name = ? COLLATE NOCASE AND id <> ?`).get(name, ignoreId);
  if (clash) throw badRequest(`A list called "${name}" already exists`, 'ADDON_GROUP_EXISTS', { name });
};

/**
 * The add-ons a sale line was made with, from their ids: each must exist, and
 * comes back with the name and price it has now, ready to be written on the line.
 */
export function readLineAddons(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const out = [];
  const one = db.prepare(`SELECT id, name, price, cost FROM addons WHERE id = ?`);
  for (const id of list.slice(0, MAX_ADDONS)) {
    const row = one.get(num(id));
    if (!row) throw badRequest('One of the add-ons on the line no longer exists', 'ADDON_UNKNOWN');
    out.push({ id: row.id, name: row.name, price: num(row.price), cost: num(row.cost) });
  }
  return out;
}

export function register(router) {
  router.get('/api/addon-groups', () =>
    db
      .prepare(`SELECT id FROM addon_groups ORDER BY sort, name COLLATE NOCASE`)
      .all()
      .map((g) => loadGroup(g.id)),
  );

  router.post('/api/addon-groups', (ctx) => {
    const name = required(ctx.body.name, 'name');
    assertFreeName(name);
    const items = readItems(ctx.body.items);
    return transact(() => {
      const id = lastId(db.prepare(`INSERT INTO addon_groups (name) VALUES (?)`).run(name));
      setItems(id, items);
      return loadGroup(id);
    });
  });

  router.put('/api/addon-groups/:id', (ctx) => {
    const group = groupRow(ctx.params.id);
    if (!group) throw notFound('Add-on list not found', 'ADDON_GROUP_NOT_FOUND');
    const name = ctx.body.name === undefined ? group.name : required(ctx.body.name, 'name');
    assertFreeName(name, group.id);
    const items = ctx.body.items === undefined ? null : readItems(ctx.body.items);
    return transact(() => {
      db.prepare(`UPDATE addon_groups SET name = ? WHERE id = ?`).run(name, group.id);
      if (items) setItems(group.id, items);
      return loadGroup(group.id);
    });
  });

  router.delete('/api/addon-groups/:id', (ctx) => {
    const group = groupRow(ctx.params.id);
    if (!group) throw notFound('Add-on list not found', 'ADDON_GROUP_NOT_FOUND');
    return transact(() => {
      // Its products simply stop offering add-ons; sales keep what was written on them.
      db.prepare(`UPDATE products SET addon_group_id = NULL WHERE addon_group_id = ?`).run(group.id);
      db.prepare(`DELETE FROM addons WHERE group_id = ?`).run(group.id);
      db.prepare(`DELETE FROM addon_groups WHERE id = ?`).run(group.id);
      return { ok: true };
    });
  });

  /** Offer this list on every product in a category, in one go. */
  router.post('/api/addon-groups/:id/apply', (ctx) => {
    const group = groupRow(ctx.params.id);
    if (!group) throw notFound('Add-on list not found', 'ADDON_GROUP_NOT_FOUND');
    const category = required(ctx.body.category, 'category');
    const res = db
      .prepare(`UPDATE products SET addon_group_id = ? WHERE category = ? COLLATE NOCASE AND active = 1`)
      .run(group.id, category);
    return { applied: Number(res.changes) || 0, group: loadGroup(group.id) };
  });
}
