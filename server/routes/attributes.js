import { db, getSettings, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, num, str } from '../util.js';
import { recordPriceChange } from './price-lists.js';

/**
 * Attributes and variants.
 *
 * The shop keeps a list of attributes — Size: S, M, L, Bottle; Flavour: Mango,
 * Strawberry — and a product can be a *template* that comes in some of their
 * values. "Generate" makes one ordinary product per combination: "Mango juice
 * L", "Mango juice Bottle". Each variant has its own price, barcode, stock and
 * recipe; the template itself is never sold, bought or counted. At the till the
 * template is one card, and tapping it asks which variant.
 *
 * Off until switched on in Settings → POS. Off, nothing here is offered, and
 * any variants already made sell as the plain products they are.
 */

export const attributesEnabled = () => getSettings().attributes === '1';

const MAX_VALUES = 30;
const MAX_VARIANTS = 100;

/** Every attribute with its values, in the shop's order. */
export function listAttributes() {
  const attrs = db.prepare(`SELECT id, name, sort FROM attributes ORDER BY sort, id`).all();
  const values = db.prepare(`SELECT id, attribute_id, name, sort FROM attribute_values ORDER BY sort, id`).all();
  const used = new Set(db.prepare(`SELECT DISTINCT value_id FROM product_attribute_values`).all().map((r) => r.value_id));
  return attrs.map((a) => ({
    ...a,
    values: values.filter((v) => v.attribute_id === a.id).map((v) => ({ id: v.id, name: v.name, used: used.has(v.id) })),
  }));
}

function readAttribute(body) {
  const name = str(body.name);
  if (!name) throw badRequest('Give the attribute a name', 'ATTRIBUTE_NAME_REQUIRED');
  const list = Array.isArray(body.values) ? body.values : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const value = str(typeof raw === 'string' ? raw : raw?.name);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) throw badRequest(`"${value}" is listed twice`, 'ATTRIBUTE_VALUE_TWICE', { name: value });
    seen.add(key);
    out.push({ id: Number(raw?.id) || null, name: value });
  }
  if (!out.length) throw badRequest('An attribute needs at least one value', 'ATTRIBUTE_VALUES_REQUIRED');
  if (out.length > MAX_VALUES) throw badRequest(`At most ${MAX_VALUES} values`, 'ATTRIBUTE_VALUES_TOO_MANY', { n: MAX_VALUES });
  return { name, values: out };
}

function assertNameFree(name, ignoreId = 0) {
  if (db.prepare(`SELECT 1 FROM attributes WHERE name = ? COLLATE NOCASE AND id <> ?`).get(name, ignoreId)) {
    throw badRequest(`There is already an attribute called "${name}"`, 'ATTRIBUTE_TAKEN', { name });
  }
}

/**
 * Write an attribute's values. One sent with its id, or with the name of one it
 * already has, is kept (and renamed in place); new ones are added; one left out
 * is removed unless products use it.
 */
function setValues(attributeId, values) {
  const current = db.prepare(`SELECT id, name FROM attribute_values WHERE attribute_id = ?`).all(attributeId);
  for (const v of values) {
    if (!v.id) v.id = current.find((c) => c.name.toLowerCase() === v.name.toLowerCase())?.id || null;
  }
  const keep = new Set(values.filter((v) => v.id).map((v) => v.id));
  for (const row of db.prepare(`SELECT id, name FROM attribute_values WHERE attribute_id = ?`).all(attributeId)) {
    if (keep.has(row.id)) continue;
    if (db.prepare(`SELECT 1 FROM product_attribute_values WHERE value_id = ?`).get(row.id)) {
      throw badRequest(`"${row.name}" is used by products and cannot be removed`, 'ATTRIBUTE_VALUE_IN_USE', { name: row.name });
    }
    db.prepare(`DELETE FROM attribute_values WHERE id = ?`).run(row.id);
  }
  const update = db.prepare(`UPDATE attribute_values SET name = ?, sort = ? WHERE id = ? AND attribute_id = ?`);
  const insert = db.prepare(`INSERT INTO attribute_values (attribute_id, name, sort) VALUES (?, ?, ?)`);
  values.forEach((v, i) => {
    const updated = v.id ? update.run(v.name, i, v.id, attributeId).changes : 0;
    if (!updated) insert.run(attributeId, v.name, i);
  });
}

/* ---------------------------------------------------------------- variants */

/** A variant's values, by attribute order: "L", "Mango L". */
function valuesOf(productId) {
  return db
    .prepare(
      `SELECT v.id, v.name, a.id AS attribute_id, a.name AS attribute FROM product_attribute_values pv
       JOIN attribute_values v ON v.id = pv.value_id JOIN attributes a ON a.id = v.attribute_id
       WHERE pv.product_id = ? ORDER BY a.sort, a.id, v.sort, v.id`,
    )
    .all(productId);
}

/** A template's values and its variants, for its page and the till's picker. */
export function loadVariants(templateId, { activeOnly = false } = {}) {
  const variants = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.price, p.cost, p.active, p.stocked, p.raw, p.unit, p.addon_group_id, p.has_variants, COALESCE(s.stock, 0) AS stock
       FROM products p LEFT JOIN product_stock s ON s.product_id = p.id
       WHERE p.variant_of = ? ${activeOnly ? 'AND p.active = 1' : ''} ORDER BY p.id`,
    )
    .all(templateId)
    .map((v) => {
      const values = valuesOf(v.id);
      return { ...v, values, label: values.map((x) => x.name).join(' · ') };
    });
  // In the attributes' order, not the order they happened to be generated in.
  const order = new Map(
    db.prepare(`SELECT v.id, (a.sort * 1000 + v.sort) AS o FROM attribute_values v JOIN attributes a ON a.id = v.attribute_id`).all().map((r) => [r.id, r.o]),
  );
  const rank = (v) => v.values.map((x) => String(order.get(x.id) ?? 0).padStart(8, '0')).join('|');
  variants.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : a.id - b.id));
  return { value_ids: valuesOf(templateId).map((v) => v.id), variants };
}

const keyOf = (ids) => [...ids].sort((a, b) => a - b).join('-');

/** Every combination of a template's values, one value from each attribute it uses. */
function combinations(valueIds) {
  const rows = valueIds.length
    ? db
        .prepare(
          `SELECT v.id, v.name, v.attribute_id FROM attribute_values v JOIN attributes a ON a.id = v.attribute_id
           WHERE v.id IN (${valueIds.map(() => '?').join(',')}) ORDER BY a.sort, a.id, v.sort, v.id`,
        )
        .all(...valueIds)
    : [];
  const groups = [];
  for (const r of rows) {
    let g = groups.find((x) => x.attribute_id === r.attribute_id);
    if (!g) groups.push((g = { attribute_id: r.attribute_id, values: [] }));
    g.values.push(r);
  }
  return groups.reduce((acc, g) => acc.flatMap((combo) => g.values.map((v) => [...combo, v])), groups.length ? [[]] : []);
}

function readValueIds(body) {
  const ids = [...new Set((Array.isArray(body.value_ids) ? body.value_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of ids) {
    if (!db.prepare(`SELECT 1 FROM attribute_values WHERE id = ?`).get(id)) {
      throw badRequest('One of the values no longer exists', 'ATTRIBUTE_VALUE_UNKNOWN');
    }
  }
  return ids;
}

function assertEnabled() {
  if (!attributesEnabled()) throw badRequest('Attributes are switched off in Settings', 'ATTRIBUTES_OFF');
}

function templateOf(id) {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  if (!p) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (!p.has_variants) throw badRequest('This product is not a template', 'PRODUCT_NOT_TEMPLATE');
  return p;
}

export function register(router) {
  router.get('/api/attributes', () => listAttributes());

  router.post('/api/attributes', (ctx) => {
    assertEnabled();
    const a = readAttribute(ctx.body);
    assertNameFree(a.name);
    return transact(() => {
      const sort = num(db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM attributes`).get().s);
      const id = lastId(db.prepare(`INSERT INTO attributes (name, sort) VALUES (?, ?)`).run(a.name, sort));
      setValues(id, a.values);
      return listAttributes().find((x) => x.id === id);
    });
  });

  router.put('/api/attributes/:id', (ctx) => {
    assertEnabled();
    const existing = db.prepare(`SELECT * FROM attributes WHERE id = ?`).get(ctx.params.id);
    if (!existing) throw notFound('Attribute not found', 'ATTRIBUTE_NOT_FOUND');
    const a = readAttribute(ctx.body);
    assertNameFree(a.name, existing.id);
    return transact(() => {
      db.prepare(`UPDATE attributes SET name = ? WHERE id = ?`).run(a.name, existing.id);
      setValues(existing.id, a.values);
      return listAttributes().find((x) => x.id === existing.id);
    });
  });

  router.delete('/api/attributes/:id', (ctx) => {
    const existing = db.prepare(`SELECT * FROM attributes WHERE id = ?`).get(ctx.params.id);
    if (!existing) throw notFound('Attribute not found', 'ATTRIBUTE_NOT_FOUND');
    const used = db
      .prepare(`SELECT 1 FROM product_attribute_values pv JOIN attribute_values v ON v.id = pv.value_id WHERE v.attribute_id = ? LIMIT 1`)
      .get(existing.id);
    if (used) throw badRequest(`"${existing.name}" is used by products`, 'ATTRIBUTE_IN_USE', { name: existing.name });
    db.prepare(`DELETE FROM attributes WHERE id = ?`).run(existing.id);
    return { ok: true };
  });

  /** A template's chosen values and its variants. The till asks for the active ones. */
  router.get('/api/products/:id/variants', (ctx) => {
    const p = db.prepare(`SELECT id FROM products WHERE id = ?`).get(ctx.params.id);
    if (!p) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    return loadVariants(p.id, { activeOnly: ctx.query.active === '1' });
  });

  /**
   * Generate: keep the values chosen for the template, and make each missing
   * combination a product of its own. Variants already made are left as they
   * are — their prices, barcodes and stock — and none is ever removed here.
   */
  router.post('/api/products/:id/variants', (ctx) => {
    assertEnabled();
    const template = templateOf(ctx.params.id);
    const valueIds = readValueIds(ctx.body);
    const combos = combinations(valueIds);
    if (!combos.length) throw badRequest('Choose the values this product comes in', 'VARIANTS_NO_VALUES');
    if (combos.length > MAX_VARIANTS) throw badRequest(`At most ${MAX_VARIANTS} variants`, 'VARIANTS_TOO_MANY', { n: MAX_VARIANTS });
    return transact(() => {
      // The template's own values: those chosen now, and any its variants still use.
      db.prepare(`DELETE FROM product_attribute_values WHERE product_id = ?`).run(template.id);
      const link = db.prepare(`INSERT OR IGNORE INTO product_attribute_values (product_id, value_id) VALUES (?, ?)`);
      for (const id of valueIds) link.run(template.id, id);
      const insert = db.prepare(
        `INSERT INTO products (name, description, category, unit, cost, price, min_stock, active, stocked, raw, addon_group_id, variant_of, variant_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
      );
      let created = 0;
      for (const combo of combos) {
        const key = keyOf(combo.map((v) => v.id));
        if (db.prepare(`SELECT 1 FROM products WHERE variant_of = ? AND variant_key = ?`).get(template.id, key)) continue;
        const id = lastId(
          insert.run(
            `${template.name} ${combo.map((v) => v.name).join(' ')}`,
            template.description || '',
            template.category,
            template.unit,
            money(template.cost),
            money(template.price),
            template.min_stock,
            template.stocked ?? 1,
            template.addon_group_id ?? null,
            template.id,
            key,
          ),
        );
        for (const v of combo) link.run(id, v.id);
        created++;
      }
      return { ...loadVariants(template.id), created };
    });
  });

  /** The variants' prices, all at once from the template's page. */
  router.put('/api/products/:id/variants', (ctx) => {
    const template = templateOf(ctx.params.id);
    const prices = ctx.body.prices && typeof ctx.body.prices === 'object' ? ctx.body.prices : {};
    transact(() => {
      const update = db.prepare(`UPDATE products SET price = ? WHERE id = ? AND variant_of = ?`);
      for (const [id, price] of Object.entries(prices)) {
        if (price === '' || price === null) continue;
        const was = db.prepare(`SELECT price FROM products WHERE id = ? AND variant_of = ?`).get(Number(id), template.id);
        if (!was) continue;
        const now = money(Math.max(0, num(price)));
        update.run(now, Number(id), template.id);
        recordPriceChange(Number(id), null, 'price', was.price, now, ctx.user.id);
      }
    });
    return loadVariants(template.id);
  });
}
