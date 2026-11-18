import { db, getSettings } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { num, str } from '../util.js';
import { recipeCost, recipesEnabled } from './recipes.js';

/**
 * Add-ons are items: Lotus Biscuit, Extra cheese, a shot of protein. An item
 * marked "add-on" has its own price and cost, can keep stock (or, made to order,
 * a recipe), and is never a card at the till: it is added to another item's
 * line. Each add-on says what it is offered with — every item, some categories,
 * or some items (a template's variants included).
 *
 * A sale line keeps its add-ons by name and price, as text, so an old invoice
 * still reads "+ Lotus Biscuit" after the add-on is renamed or removed. What an
 * add-on costs is part of the line's cost; its stock (or recipe) moves with the
 * sale like any item's.
 *
 * A shop with no add-on item sees no change: no line offers any.
 */

const MAX_ADDONS = 40;

/** Add-ons are switched on in Settings → POS. Off: none is offered, and none can be sold. */
export const addonsEnabled = () => getSettings().addons === '1';
const SCOPES = new Set(['all', 'categories', 'products']);

/** Every add-on in use, with what it is offered with: the till works out which lines take which. */
export function listAddons() {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.price, p.cost, p.unit, p.stocked, p.addon_scope AS scope FROM products p
       WHERE p.is_addon = 1 AND p.active = 1 ORDER BY p.name COLLATE NOCASE`,
    )
    .all();
  const links = db.prepare(`SELECT addon_id, category, product_id FROM addon_links`).all();
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    price: num(a.price),
    scope: SCOPES.has(a.scope) ? a.scope : 'all',
    categories: links.filter((l) => l.addon_id === a.id && l.category).map((l) => l.category),
    product_ids: links.filter((l) => l.addon_id === a.id && l.product_id).map((l) => l.product_id),
  }));
}

/** Is this add-on offered with that product? */
function offeredWith(addon, product) {
  if (!product) return true;
  if (addon.scope === 'all') return true;
  if (addon.scope === 'categories') {
    const cat = str(product.category).toLowerCase();
    return !!cat && addon.categories.some((c) => c.toLowerCase() === cat);
  }
  return addon.product_ids.includes(product.id) || (product.variant_of && addon.product_ids.includes(product.variant_of));
}

/**
 * The add-ons a sale line was made with, from their ids: each must be an add-on
 * item offered with the line's product. Comes back with today's name, price and
 * cost (its recipe's, when it is made to order and has one), ready for the line.
 */
export function readLineAddons(ids, product = null) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return [];
  if (!addonsEnabled()) throw badRequest('Add-ons are switched off in Settings', 'ADDONS_OFF');
  const all = new Map(listAddons().map((a) => [a.id, a]));
  const out = [];
  const one = db.prepare(`SELECT id, name, price, cost, stocked FROM products WHERE id = ? AND is_addon = 1`);
  for (const id of [...new Set(list.map(num))].slice(0, MAX_ADDONS)) {
    const row = one.get(id);
    const addon = all.get(id);
    if (!row || !addon) throw badRequest('One of the add-ons on the line is no longer an add-on', 'ADDON_UNKNOWN');
    if (product && product.id === row.id) throw badRequest('An add-on cannot be added to itself', 'ADDON_UNKNOWN');
    if (!offeredWith(addon, product)) {
      throw badRequest(`${row.name} is not offered with ${product.name}`, 'ADDON_NOT_OFFERED', { name: row.name, product: product.name });
    }
    const fromRecipe = recipesEnabled() ? recipeCost(row.id) : null;
    out.push({ id: row.id, name: row.name, price: num(row.price), cost: fromRecipe !== null ? fromRecipe : num(row.cost), stocked: row.stocked });
  }
  return out;
}

/** What an add-on is offered with, for its page. */
function loadScope(id) {
  const p = db.prepare(`SELECT id, is_addon, addon_scope FROM products WHERE id = ?`).get(num(id));
  if (!p) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
  const links = db.prepare(`SELECT category, product_id FROM addon_links WHERE addon_id = ?`).all(p.id);
  const ids = links.filter((l) => l.product_id).map((l) => l.product_id);
  return {
    scope: SCOPES.has(p.addon_scope) ? p.addon_scope : 'all',
    categories: links.filter((l) => l.category).map((l) => l.category),
    products: ids.length
      ? db.prepare(`SELECT id, name FROM products WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(...ids)
      : [],
  };
}

export function register(router) {
  router.get('/api/addons', () => (addonsEnabled() ? listAddons() : []));

  router.get('/api/products/:id/addon-for', (ctx) => loadScope(ctx.params.id));

  /** Offered with: { scope: 'all' | 'categories' | 'products', categories: [...], product_ids: [...] } */
  router.put('/api/products/:id/addon-for', (ctx) => {
    const p = db.prepare(`SELECT id, is_addon FROM products WHERE id = ?`).get(num(ctx.params.id));
    if (!p) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    if (!p.is_addon) throw badRequest('This item is not an add-on', 'NOT_ADDON');
    const scope = SCOPES.has(ctx.body.scope) ? ctx.body.scope : 'all';
    const categories = [...new Set((Array.isArray(ctx.body.categories) ? ctx.body.categories : []).map((c) => str(c)).filter(Boolean))].slice(0, 100);
    const productIds = [...new Set((Array.isArray(ctx.body.product_ids) ? ctx.body.product_ids : []).map(num).filter((n) => n > 0 && n !== p.id))].slice(0, 500);
    if (scope === 'categories' && !categories.length) throw badRequest('Choose at least one category', 'ADDON_SCOPE_EMPTY');
    if (scope === 'products' && !productIds.length) throw badRequest('Choose at least one item', 'ADDON_SCOPE_EMPTY');
    for (const id of productIds) {
      if (!db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(id)) throw badRequest('One of the items no longer exists', 'PRODUCT_NOT_FOUND');
    }
    db.prepare(`UPDATE products SET addon_scope = ? WHERE id = ?`).run(scope, p.id);
    db.prepare(`DELETE FROM addon_links WHERE addon_id = ?`).run(p.id);
    const insert = db.prepare(`INSERT INTO addon_links (addon_id, category, product_id) VALUES (?, ?, ?)`);
    if (scope === 'categories') for (const c of categories) insert.run(p.id, c, null);
    if (scope === 'products') for (const id of productIds) insert.run(p.id, null, id);
    return loadScope(p.id);
  });
}
