import { db, getSettings, lastId, transact } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { money, nextDocNo, num, pageParams, pageResult, qty, str } from '../util.js';

/**
 * Recipes and consumption reconciliation.
 *
 * Some shops make what they sell: a banana shake is milk, banana and ice, and
 * not the same amount every time. For them a product can be *made to order*
 * (it keeps no stock of its own) with a *recipe*: the ingredients one usually
 * takes, as an estimate. Ingredients are *raw materials*: bought and counted
 * like any stock, but not sold at the till.
 *
 * A sale writes down what it probably used, at that moment. The ingredients'
 * stock does not move then: it moves when the shop reconciles, on a day of its
 * choosing, the ingredients of its choosing. Each ingredient keeps its own
 * cutoff, so one reconciled on Monday starts again from Monday while another
 * goes on from wherever it was last reconciled — nothing is counted twice and
 * nothing is missed.
 *
 * All of it is off until switched on in Settings → POS. Off, every product
 * moves stock exactly as it always has, whatever it was marked.
 */

export const recipesEnabled = () => getSettings().recipes === '1';

/** The shop's own clock, so a reconciliation at 22:00 reads 22:00. */
export const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * The same clock to the millisecond, for what a sale used and where a
 * reconciliation stops: a sale rung up in the same second as a submit still
 * falls on one side of it, never neither.
 */
export const useStamp = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace('T', ' ');
};

/**
 * SQL: the products that sit on a shelf, so can run low. Not a template (its
 * variants are what is stocked), nor — with recipes on — something made to order.
 * With neither feature in use, that is every product, as before.
 */
export const onShelf = (alias = 'p') =>
  `${alias}.has_variants = 0${recipesEnabled() ? ` AND ${alias}.stocked <> 0` : ''}`;

/** Does this product keep stock of its own? Always, while recipes are switched off. */
export const keepsStock = (product) => !recipesEnabled() || num(product?.stocked ?? 1) !== 0;

/** What one of this product is expected to use. A variant has a recipe of its own. */
export function recipeFor(productId) {
  return db
    .prepare(
      `SELECT r.ingredient_id, r.qty, p.name, p.unit, p.cost FROM recipe_lines r
       JOIN products p ON p.id = r.ingredient_id
       WHERE r.product_id = ? AND r.qty > 0 ORDER BY r.sort, r.id`,
    )
    .all(productId);
}

/** What a recipe's ingredients cost at today's average costs, or null when there is none. */
export function recipeCost(productId) {
  const lines = recipeFor(productId);
  if (!lines.length) return null;
  return money(lines.reduce((s, l) => s + num(l.qty) * num(l.cost), 0));
}

/** Write down what a sale line probably used: its quantity times its recipe. */
export function recordEstimatedUse({ saleId, saleItemId, productId, quantity, stamp }) {
  if (!recipesEnabled()) return;
  const lines = recipeFor(productId);
  if (!lines.length) return;
  const insert = db.prepare(
    `INSERT INTO estimated_use (sale_id, sale_item_id, ingredient_id, qty, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const l of lines) insert.run(saleId, saleItemId, l.ingredient_id, qty(quantity * num(l.qty)), stamp);
}

/* ---------------------------------------------------------------- the recipe */

function readRecipe(productId, body) {
  const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(productId);
  if (!product) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const ingredientId = num(raw?.ingredient_id);
    if (!ingredientId) continue;
    if (ingredientId === product.id) throw badRequest('A product cannot be one of its own ingredients', 'RECIPE_SELF');
    if (!db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(ingredientId)) {
      throw badRequest('One of the ingredients no longer exists', 'RECIPE_UNKNOWN_INGREDIENT');
    }
    if (seen.has(ingredientId)) continue;
    seen.add(ingredientId);
    const amount = qty(Math.max(0, num(raw.qty)));
    if (amount > 0) out.push({ ingredient_id: ingredientId, qty: amount });
  }
  return { product, lines: out };
}

/** A product's recipe for its page: each ingredient with what it takes, and the whole recipe's cost. */
export function loadRecipe(productId) {
  const lines = db
    .prepare(
      `SELECT r.ingredient_id, r.qty, p.name, p.unit, p.cost FROM recipe_lines r
       JOIN products p ON p.id = r.ingredient_id WHERE r.product_id = ? ORDER BY r.sort, r.id`,
    )
    .all(productId)
    .map((r) => ({ ingredient: { id: r.ingredient_id, name: r.name, unit: r.unit, cost: num(r.cost) }, qty: num(r.qty) }));
  return { lines, cost: recipeCost(productId) };
}

/* ---------------------------------------------------------------- reconciling */

/** Where an ingredient's unreconciled use starts: its last cutoff, or the beginning. */
const cutoffOf = (ingredientId) =>
  db.prepare(`SELECT consumed_until FROM products WHERE id = ?`).get(ingredientId)?.consumed_until || '';

/** What the sales say an ingredient used after its cutoff, up to `until`. */
function suggestedUse(ingredientId, until) {
  const since = cutoffOf(ingredientId);
  const row = db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM estimated_use WHERE ingredient_id = ? AND created_at > ? AND created_at <= ?`)
    .get(ingredientId, since, until);
  return { since, suggested: qty(num(row.q)) };
}

/** Every ingredient a recipe uses, with where it stands now: the start of a reconciliation. */
function ingredientsNow(until = useStamp()) {
  return db
    .prepare(
      `SELECT DISTINCT p.id, p.name, p.unit, p.cost, p.raw, COALESCE(s.stock, 0) AS stock
       FROM products p JOIN recipe_lines r ON r.ingredient_id = p.id
       LEFT JOIN product_stock s ON s.product_id = p.id
       ORDER BY p.name COLLATE NOCASE`,
    )
    .all()
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit, cost: num(p.cost), stock: qty(num(p.stock)), ...suggestedUse(p.id, until) }));
}

/** The lines a reconciliation is given: chosen ingredients, their actual use and what was counted. */
function readItems(body) {
  const list = Array.isArray(body.items) ? body.items : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = num(raw?.product_id);
    if (!id || seen.has(id)) continue;
    const product = db.prepare(`SELECT id, name FROM products WHERE id = ?`).get(id);
    if (!product) throw badRequest('One of the ingredients no longer exists', 'RECIPE_UNKNOWN_INGREDIENT');
    seen.add(id);
    const counted = raw.counted === '' || raw.counted === null || raw.counted === undefined ? null : qty(Math.max(0, num(raw.counted)));
    out.push({ product_id: id, actual: qty(Math.max(0, num(raw.actual))), counted });
  }
  if (!out.length) throw badRequest('Choose at least one ingredient to reconcile', 'CONSUMPTION_EMPTY');
  return out;
}

/**
 * How far a reconciliation reaches. A day in the past: the end of that day.
 * Today, or no day at all: up to the moment it is submitted — so a draft
 * started on Monday and submitted on Wednesday covers Wednesday too.
 */
const docUntil = (body) => {
  const day = str(body.until);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= localNow().slice(0, 10)) return null;
  return `${day} 23:59:59.999`;
};

/** A reconciliation's reach right now: its fixed end, or this moment for a draft that runs to now. */
const reachOf = (doc) => doc.until || useStamp();

/** A reconciliation with its lines. A draft's figures are live; a submitted one's are kept. */
export function loadConsumption(id) {
  const doc = db
    .prepare(`SELECT c.*, u.username FROM consumptions c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`)
    .get(id);
  if (!doc) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name, p.unit, p.cost, COALESCE(s.stock, 0) AS stock FROM consumption_items i
       JOIN products p ON p.id = i.product_id LEFT JOIN product_stock s ON s.product_id = p.id
       WHERE i.consumption_id = ? ORDER BY i.sort, i.id`,
    )
    .all(doc.id)
    .map((i) => {
      const live = doc.status === 'draft' ? suggestedUse(i.product_id, reachOf(doc)) : null;
      const suggested = live ? live.suggested : num(i.suggested);
      const actual = num(i.actual);
      const unitCost = doc.status === 'draft' ? num(i.cost) : num(i.unit_cost);
      return {
        id: i.id,
        product_id: i.product_id,
        name: i.name,
        unit: i.unit,
        since: live ? live.since : i.since,
        suggested,
        actual,
        counted: i.counted === null ? null : num(i.counted),
        stock: qty(num(i.stock)),
        difference: qty(actual - suggested),
        unit_cost: unitCost,
        value: money(actual * unitCost),
        difference_value: money((actual - suggested) * unitCost),
      };
    });
  return {
    ...doc,
    items,
    value: money(items.reduce((s, i) => s + i.value, 0)),
    difference_value: money(items.reduce((s, i) => s + i.difference_value, 0)),
  };
}

function writeItems(consumptionId, items, until = useStamp()) {
  db.prepare(`DELETE FROM consumption_items WHERE consumption_id = ?`).run(consumptionId);
  const insert = db.prepare(
    `INSERT INTO consumption_items (consumption_id, product_id, since, suggested, actual, counted, unit_cost, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  items.forEach((it, i) => {
    const { since, suggested } = suggestedUse(it.product_id, until);
    const cost = num(db.prepare(`SELECT cost FROM products WHERE id = ?`).get(it.product_id).cost);
    insert.run(consumptionId, it.product_id, since, suggested, it.actual, it.counted, cost, i);
  });
}

function assertEnabled() {
  if (!recipesEnabled()) throw badRequest('Recipes are switched off in Settings', 'RECIPES_OFF');
}

export function register(router) {
  router.get('/api/products/:id/recipe', (ctx) => {
    if (!db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(ctx.params.id)) throw notFound('Product not found', 'PRODUCT_NOT_FOUND');
    return loadRecipe(Number(ctx.params.id));
  });

  router.put('/api/products/:id/recipe', (ctx) => {
    assertEnabled();
    const { product, lines } = readRecipe(Number(ctx.params.id), ctx.body);
    transact(() => {
      db.prepare(`DELETE FROM recipe_lines WHERE product_id = ?`).run(product.id);
      const insert = db.prepare(`INSERT INTO recipe_lines (product_id, ingredient_id, qty, sort) VALUES (?, ?, ?, ?)`);
      lines.forEach((l, i) => insert.run(product.id, l.ingredient_id, l.qty, i));
    });
    return loadRecipe(product.id);
  });

  /** Every ingredient a recipe uses, with its use since its own last reconciliation. */
  router.get('/api/consumption/ingredients', () => {
    assertEnabled();
    return ingredientsNow();
  });

  router.get('/api/consumptions', (ctx) => {
    const paging = pageParams({ page: str(ctx.query.page) || '1', per: ctx.query.per }, { per: 25 });
    const total = db.prepare(`SELECT COUNT(*) AS n FROM consumptions`).get().n;
    const rows = db
      .prepare(`SELECT id FROM consumptions ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(paging.per, paging.offset)
      .map((r) => {
        const d = loadConsumption(r.id);
        return { ...d, lines: d.items.length, items: undefined };
      });
    return pageResult(rows, total, paging);
  });

  router.get('/api/consumptions/:id', (ctx) => {
    const doc = loadConsumption(ctx.params.id);
    if (!doc) throw notFound('Reconciliation not found', 'CONSUMPTION_NOT_FOUND');
    return doc;
  });

  /** A new reconciliation, kept as a draft until it is submitted. */
  router.post('/api/consumptions', (ctx) => {
    assertEnabled();
    const items = readItems(ctx.body);
    const until = docUntil(ctx.body);
    return transact(() => {
      const res = db
        .prepare(`INSERT INTO consumptions (doc_no, until, note, status, user_id, created_at) VALUES (?, ?, ?, 'draft', ?, ?)`)
        .run(nextDocNo(db, 'consumptions', 'CON'), until, str(ctx.body.note), ctx.user.id, localNow());
      const id = lastId(res);
      writeItems(id, items, until || undefined);
      return loadConsumption(id);
    });
  });

  router.put('/api/consumptions/:id', (ctx) => {
    assertEnabled();
    const doc = db.prepare(`SELECT * FROM consumptions WHERE id = ?`).get(ctx.params.id);
    if (!doc) throw notFound('Reconciliation not found', 'CONSUMPTION_NOT_FOUND');
    if (doc.status !== 'draft') throw badRequest('A submitted reconciliation cannot be changed', 'CONSUMPTION_SUBMITTED');
    const items = readItems(ctx.body);
    const until = docUntil(ctx.body);
    return transact(() => {
      db.prepare(`UPDATE consumptions SET until = ?, note = ? WHERE id = ?`).run(until, str(ctx.body.note), doc.id);
      writeItems(doc.id, items, until || undefined);
      return loadConsumption(doc.id);
    });
  });

  router.delete('/api/consumptions/:id', (ctx) => {
    const doc = db.prepare(`SELECT * FROM consumptions WHERE id = ?`).get(ctx.params.id);
    if (!doc) throw notFound('Reconciliation not found', 'CONSUMPTION_NOT_FOUND');
    if (doc.status !== 'draft') throw badRequest('A submitted reconciliation cannot be removed', 'CONSUMPTION_SUBMITTED');
    db.prepare(`DELETE FROM consumptions WHERE id = ?`).run(doc.id);
    return { ok: true };
  });

  /**
   * Submit: each ingredient's stock goes down by what was actually used, and its
   * cutoff moves to this reconciliation, so the next one starts here. An
   * ingredient reconciled elsewhere since this draft was made is refused rather
   * than counted twice.
   */
  router.post('/api/consumptions/:id/submit', (ctx) => {
    assertEnabled();
    const doc = db.prepare(`SELECT * FROM consumptions WHERE id = ?`).get(ctx.params.id);
    if (!doc) throw notFound('Reconciliation not found', 'CONSUMPTION_NOT_FOUND');
    if (doc.status !== 'draft') throw badRequest('This reconciliation was already submitted', 'CONSUMPTION_SUBMITTED');
    const items = db.prepare(`SELECT * FROM consumption_items WHERE consumption_id = ?`).all(doc.id);
    const until = reachOf(doc);
    for (const it of items) {
      const cutoff = cutoffOf(it.product_id);
      // Reconciled elsewhere since this draft was saved: its figures are stale,
      // and submitting it would take the same use out twice.
      if (cutoff && (cutoff >= until || cutoff !== it.since)) {
        const name = db.prepare(`SELECT name FROM products WHERE id = ?`).get(it.product_id).name;
        throw badRequest(`${name} was already reconciled up to ${cutoff.slice(0, 16)}`, 'CONSUMPTION_ALREADY', { name, until: cutoff.slice(0, 16) });
      }
    }
    return transact(() => {
      const move = db.prepare(
        `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
         VALUES (?, ?, ?, 'consumption', 'consumptions', ?, ?, ?, ?)`,
      );
      for (const it of items) {
        // Figures are fixed now: what the sales said, and what was really used.
        const { since, suggested } = suggestedUse(it.product_id, until);
        const cost = num(db.prepare(`SELECT cost FROM products WHERE id = ?`).get(it.product_id).cost);
        db.prepare(`UPDATE consumption_items SET since = ?, suggested = ?, unit_cost = ? WHERE id = ?`).run(since, suggested, cost, it.id);
        if (num(it.actual) > 0) move.run(it.product_id, -num(it.actual), cost, doc.id, doc.doc_no, ctx.user.id, until);
        db.prepare(`UPDATE products SET consumed_until = ? WHERE id = ?`).run(until, it.product_id);
      }
      // Its reach is fixed now, for good.
      db.prepare(`UPDATE consumptions SET status = 'submitted', submitted_at = ?, until = ? WHERE id = ?`).run(localNow(), until, doc.id);
      return loadConsumption(doc.id);
    });
  });
}
