/**
 * Demo data: a juice, crêpe and saj bar, built from a real menu — fresh juices
 * in S, M, L and Bottle, milkshakes, smoothies, crêpes with toppings, saj
 * manakish and soft drinks — with a month of sales, the raw materials behind
 * them, and a consumption reconciliation already done.
 *
 * It shows what the optional features are for, so it switches them on:
 * attributes (each juice a template, each size a variant), recipes (made to
 * order, raw materials, estimated use), categories at the till, add-ons and a
 * second currency. Only on an empty catalogue; safe to skip entirely.
 *
 *   npm run seed
 */
import { db, saveSettings, transact } from '../db.js';
import { ensureSeedAdmin } from '../auth.js';
import { money, qty, shiftDays, today } from '../util.js';
import { rememberEntity } from '../entities.js';

ensureSeedAdmin();
const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();

const { n } = db.prepare(`SELECT COUNT(*) AS n FROM products`).get();
if (n > 0) {
  console.log('Database already has products - seeding skipped.');
  process.exit(0);
}

/* ------------------------------------------------------------- raw materials */

// name, unit, cost per unit
const RAW = [
  ['Oranges', 'kg', 0.9], ['Apples', 'kg', 1.4], ['Carrots', 'kg', 0.7], ['Lemons', 'kg', 1.2],
  ['Grapefruit', 'kg', 1.3], ['Strawberries', 'kg', 4], ['Mango', 'kg', 3.5], ['Mixed berries', 'kg', 7],
  ['Melon', 'kg', 0.9], ['Avocado', 'kg', 4.5], ['Pineapple', 'kg', 2.2], ['Passion fruit', 'kg', 6],
  ['Banana', 'kg', 1.2], ['Milk', 'l', 1.1], ['Vanilla ice cream', 'l', 4.5], ['Sugar', 'kg', 1],
  ['Flavour syrups', 'l', 6], ['Chocolate sauce', 'kg', 7], ['Dates', 'kg', 5], ['Oreo biscuits', 'kg', 8],
  ['Ice', 'kg', 0.15], ['Coffee', 'kg', 14], ['Crêpe batter', 'kg', 2.2], ['Nutella', 'kg', 9],
  ['Lotus spread', 'kg', 10], ['Pistachio cream', 'kg', 20], ['Brownies', 'kg', 7], ['Qashta', 'kg', 7],
  ['Honey', 'kg', 10], ['Saj dough', 'kg', 1.1], ['Zaatar', 'kg', 6], ['Olive oil', 'l', 8],
  ['Akkawi cheese', 'kg', 8], ['Mortadella', 'kg', 7], ['Sujuk', 'kg', 12], ['Smoked turkey', 'kg', 14],
  ['Pepperoni', 'kg', 13], ['Kishk', 'kg', 7], ['Labneh', 'kg', 5], ['Vegetables', 'kg', 1.5],
  ['Basterma', 'kg', 25], ['Makanek', 'kg', 12], ['Minced meat', 'kg', 11], ['Chicken', 'kg', 7],
];

/* -------------------------------------------------------------------- menu */

// Fresh juices: prices per size, and what a Small takes; M, L and Bottle scale from it.
const SIZES = ['S', 'M', 'L', 'Bottle'];
const SCALE = { S: 1, M: 1.4, L: 2, Bottle: 4 };
const JUICES = [
  ['Orange Juice', { S: 2, M: 3, L: 4, Bottle: 6 }, { Oranges: 0.45 }],
  ['Apple Juice', { S: 3, M: 4, L: 5, Bottle: 7 }, { Apples: 0.4 }],
  ['Carrot Juice', { S: 3, M: 4, L: 5, Bottle: 7 }, { Carrots: 0.5 }],
  ['Lemonade', { S: 2, M: 3, L: 4, Bottle: 6 }, { Lemons: 0.12, Sugar: 0.03 }],
  ['Grapefruit Juice', { S: 3, M: 4, L: 5, Bottle: 7 }, { Grapefruit: 0.45 }],
  ['Strawberry Juice', { S: 3, M: 4, L: 5, Bottle: 7 }, { Strawberries: 0.18, Sugar: 0.02 }],
  ['Mango Juice', { S: 3, M: 4, L: 5, Bottle: 8 }, { Mango: 0.2 }],
  ['Berry Juice', { S: 3, M: 4, L: 5, Bottle: 8 }, { 'Mixed berries': 0.15, Sugar: 0.02 }],
  ['Melon Juice', { S: 3, M: 4, L: 5, Bottle: 7 }, { Melon: 0.3 }],
  ['Avocado Juice', { S: 5, M: 6, L: 8, Bottle: 15 }, { Avocado: 0.2, Milk: 0.15, Sugar: 0.02 }],
  ['Tasty Avocado', { S: 6, M: 8, L: 12 }, { Avocado: 0.25, Milk: 0.15, Banana: 0.1, Honey: 0.02 }],
  ['Cocktail Juice', { S: 3, M: 4, L: 5, Bottle: 8 }, { Banana: 0.08, Strawberries: 0.06, Mango: 0.06, Milk: 0.1 }],
  ['Cocktail Diced', { S: 4, M: 6, L: 8 }, { Banana: 0.1, Strawberries: 0.08, Mango: 0.08, Melon: 0.1 }],
  ['Red Sunrise', { S: 3.5, M: 4.5, L: 6, Bottle: 8 }, { Strawberries: 0.1, Oranges: 0.25 }],
  ['Hummer Juice', { S: 3.5, M: 4.5, L: 6, Bottle: 8 }, { Avocado: 0.1, Banana: 0.08, Strawberries: 0.06, Mango: 0.06, Milk: 0.1 }],
  ['Tahiti Squeeze', { S: 3, M: 4, L: 5, Bottle: 8 }, { Pineapple: 0.2, Oranges: 0.2 }],
  ['Polo Drink', { S: 4, M: 5, L: 6, Bottle: 8 }, { Mango: 0.1, Strawberries: 0.1, Oranges: 0.15 }],
  ['Passion Mix', { S: 4, M: 5, L: 6, Bottle: 10 }, { 'Passion fruit': 0.1, Mango: 0.1, Oranges: 0.15 }],
  ['Golden Blend', { S: 4, M: 5, L: 6, Bottle: 8 }, { Mango: 0.1, Pineapple: 0.15, Oranges: 0.15 }],
];

const SHAKE = { Milk: 0.25, 'Vanilla ice cream': 0.12 };
const MILKSHAKES = [
  ['Belgian Chocolate Milkshake', 5, { ...SHAKE, 'Chocolate sauce': 0.04 }],
  ['Vanilla Milkshake', 4, { Milk: 0.25, 'Vanilla ice cream': 0.15 }],
  ['Strawberry Milkshake', 4, { ...SHAKE, Strawberries: 0.08 }],
  ['Blue Raspberry Milkshake', 4, { ...SHAKE, 'Flavour syrups': 0.03 }],
  ['Mango Lassi', 5, { Milk: 0.2, Mango: 0.12, Sugar: 0.02 }],
  ['Lotus Milkshake', 5, { ...SHAKE, 'Lotus spread': 0.04 }],
  ['Pistachio Milkshake', 6, { ...SHAKE, 'Pistachio cream': 0.04 }],
  ['Caramel Milkshake', 5, { ...SHAKE, 'Flavour syrups': 0.03 }],
  ['Peach Milkshake', 4, { ...SHAKE, 'Flavour syrups': 0.03 }],
  ['Dates Mix Milkshake', 5, { ...SHAKE, Dates: 0.05 }],
  ['Oreo Milkshake', 5, { ...SHAKE, 'Oreo biscuits': 0.04 }],
];

const SMOOTHIES = [
  ['Peach Smoothie', 4, { Ice: 0.25, 'Flavour syrups': 0.04 }],
  ['Blue Raspberry Smoothie', 4, { Ice: 0.25, 'Flavour syrups': 0.04 }],
  ['Mango Smoothie', 4, { Ice: 0.2, Mango: 0.15 }],
  ['Blueberry Smoothie', 4, { Ice: 0.2, 'Mixed berries': 0.12 }],
  ['Caramel Frappe', 4, { Ice: 0.2, Milk: 0.15, Coffee: 0.015, 'Flavour syrups': 0.03 }],
  ['Vanilla Frappe', 4, { Ice: 0.2, Milk: 0.15, Coffee: 0.015, 'Vanilla ice cream': 0.05 }],
  ['Mocha Frappe', 4, { Ice: 0.2, Milk: 0.15, Coffee: 0.015, 'Chocolate sauce': 0.03 }],
];

const B = { 'Crêpe batter': 0.15 };
const CREPES = [
  ['Nutella Crêpe', 5, { ...B, Nutella: 0.05 }],
  ['Kinder Crêpe', 5, { ...B, Nutella: 0.03, 'Chocolate sauce': 0.02 }],
  ['Lotus Crêpe', 5, { ...B, 'Lotus spread': 0.05 }],
  ['Pistachio Crêpe', 8, { ...B, 'Pistachio cream': 0.06 }],
  ['Fettuccine Crêpe', 7, { 'Crêpe batter': 0.2, Nutella: 0.06 }],
  ['Special Combo Crêpe', 8, { ...B, Nutella: 0.04, 'Lotus spread': 0.03, 'Pistachio cream': 0.02 }],
  ['Dark / White Crêpe', 5, { ...B, 'Chocolate sauce': 0.05 }],
  ['Crêpe Roll', 10, { 'Crêpe batter': 0.3, Nutella: 0.08, 'Lotus spread': 0.04 }],
  ['Mini Pancake', 7, { 'Crêpe batter': 0.2, Nutella: 0.05 }],
  ['Brownie Cup', 5, { Brownies: 0.12, Nutella: 0.03 }],
  ['Pistachio Cup', 5, { 'Pistachio cream': 0.06, Qashta: 0.05 }],
  ['Qashta Cup', 5, { Qashta: 0.1 }],
  ['Brownie Plate', 8, { Brownies: 0.2, Nutella: 0.04 }],
  ['Waffle & Fruits Plate', 7, { 'Crêpe batter': 0.18, Strawberries: 0.06, Banana: 0.08 }],
  ['Belgian Waffle', 10, { 'Crêpe batter': 0.25, Nutella: 0.06 }],
  ['Pistachio & Strawberry Plate', 10, { ...B, 'Pistachio cream': 0.06, Strawberries: 0.1 }],
  ['Pizza Crêpe', 10, { 'Crêpe batter': 0.2, 'Akkawi cheese': 0.08, Pepperoni: 0.03 }],
  ['Special Brownies Crêpe', 8, { ...B, Brownies: 0.08, Nutella: 0.03 }],
  ['Juice Fuel Crêpe', 8, { ...B, Nutella: 0.03, 'Lotus spread': 0.03, 'Pistachio cream': 0.02, Banana: 0.05 }],
  ['Special Mini Pancake', 8, { 'Crêpe batter': 0.2, Nutella: 0.04, 'Lotus spread': 0.03 }],
  ['Belgian Crêpe', 7, { ...B, Nutella: 0.06 }],
];
// Qashta Plate comes in four plate sizes, each its own price and recipe.
const PLATES = ['Small', 'Medium', 'Large', 'XLarge'];
const QASHTA_PLATE = { Small: [8, 0.2, 0.02], Medium: [15, 0.4, 0.04], Large: [18, 0.5, 0.05], XLarge: [22, 0.65, 0.06] };

const D = { 'Saj dough': 0.15 };
const SAJ = [
  ['بقعة', 0.35, { 'Saj dough': 0.1 }],
  ['زعتر', 1, { ...D, Zaatar: 0.03, 'Olive oil': 0.02 }],
  ['جبنة', 2.5, { ...D, 'Akkawi cheese': 0.1 }],
  ['جبنة و زعتر', 2.5, { ...D, 'Akkawi cheese': 0.06, Zaatar: 0.02 }],
  ['جبنة و مرتديلا', 3, { ...D, 'Akkawi cheese': 0.07, Mortadella: 0.05 }],
  ['جبنة و سجق', 3, { ...D, 'Akkawi cheese': 0.07, Sujuk: 0.05 }],
  ['٣ انواع جبنة', 3.5, { ...D, 'Akkawi cheese': 0.12 }],
  ['جبنة و حبش مدخن', 3, { ...D, 'Akkawi cheese': 0.07, 'Smoked turkey': 0.05 }],
  ['جبنة و بيبروني', 3, { ...D, 'Akkawi cheese': 0.07, Pepperoni: 0.04 }],
  ['كشك', 1.5, { ...D, Kishk: 0.05 }],
  ['كشك و جبنة', 2.5, { ...D, Kishk: 0.04, 'Akkawi cheese': 0.05 }],
  ['لبنة', 1.5, { ...D, Labneh: 0.08 }],
  ['لبنة مع خضرة', 2, { ...D, Labneh: 0.08, Vegetables: 0.06 }],
  ['زعتر مع خضرة', 2, { ...D, Zaatar: 0.03, Vegetables: 0.06 }],
  ['جبنة و حرحورة', 2.5, { ...D, 'Akkawi cheese': 0.08 }],
  ['جبنة و بسطرمة', 3.5, { ...D, 'Akkawi cheese': 0.07, Basterma: 0.04 }],
  ['صاج مقانق', 5, { ...D, Makanek: 0.1 }],
  ['ميكس صاج', 3.5, { ...D, 'Akkawi cheese': 0.06, Zaatar: 0.02, Kishk: 0.02 }],
  ['سبيشل ميكس', 5, { ...D, 'Akkawi cheese': 0.08, Mortadella: 0.03, Sujuk: 0.03 }],
  ['منقوشة المحل', 5, { ...D, 'Akkawi cheese': 0.08, Sujuk: 0.03, Vegetables: 0.04 }],
  ['صاج همبرغر', 5, { ...D, 'Minced meat': 0.1, Vegetables: 0.04 }],
  ['بيتزا صاج', 5, { ...D, 'Akkawi cheese': 0.08, Pepperoni: 0.03, Vegetables: 0.04 }],
  ['Chicken BBQ Cheese', 5, { ...D, Chicken: 0.1, 'Akkawi cheese': 0.06 }],
  ['بندورة وبصل', 1.5, { ...D, Vegetables: 0.1 }],
  ['جبنة و بندورة وبصل', 2, { ...D, 'Akkawi cheese': 0.07, Vegetables: 0.06 }],
  ['بوك', 2.5, { ...D, 'Akkawi cheese': 0.06 }],
  ['لحمة', 3, { ...D, 'Minced meat': 0.08 }],
  ['كفتة', 3, { ...D, 'Minced meat': 0.08 }],
  ['كفتة مع خضرة', 5, { ...D, 'Minced meat': 0.1, Vegetables: 0.06 }],
  ['صحن لبنة', 3, { Labneh: 0.2, 'Olive oil': 0.02 }],
  ['صحن خضرا', 3.5, { Vegetables: 0.3 }],
  ['بوك و عسل', 3.5, { ...D, 'Akkawi cheese': 0.05, Honey: 0.03 }],
  ['نوتيلا', 4, { ...D, Nutella: 0.05 }],
  ['نوتيلا، لوتس، موز', 5, { ...D, Nutella: 0.03, 'Lotus spread': 0.03, Banana: 0.06 }],
  ['قشطة و عسل', 6, { ...D, Qashta: 0.12, Honey: 0.04 }],
  ['Hawsa Sandwich', 5, { ...D, Chicken: 0.12, Vegetables: 0.05 }],
];

// Bought and sold as they are: name, barcode (in-store range), cost, price
const DRINKS = [
  ['Pepsi', '2000000000015', 0.45, 1],
  ['Miranda', '2000000000022', 0.45, 1],
  ['7-UP', '2000000000039', 0.45, 1],
  ['Top Juice', '2000000000046', 0.2, 0.5],
];

const TOPPINGS = ['Twix', 'Crunch', 'Milka', 'Oreo', 'Galaxy', 'KitKat', 'Lotus Biscuit', 'Strawberry', 'Snickers', 'Kiwi', 'Banana'];

const EXPENSES = [
  ['Rent', 'Shop rent', 600],
  ['Salaries', 'Counter and kitchen staff', 1400],
  ['Utilities', 'Electricity and generator subscription', 220],
  ['Utilities', 'Gas cylinders', 60],
  ['Supplies', 'Cups, straws, boxes and napkins', 180],
  ['Marketing', 'Instagram promotion', 50],
];
const CUSTOMERS = ['Ali H.', 'Rana K.', 'Hussein M.', 'Zeinab S.', 'Mohammad A.', 'Fatima B.'];
const NOTES = ['no sugar', 'less ice', 'cut in four', 'extra crispy', 'no ice', 'well done'];

/* ---------------------------------------------------------------- helpers */

const day = (offset) => shiftDays(today(), -offset);
const between = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};
const pad = (n) => String(n).padStart(2, '0');
const clock = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(Math.floor(minutes % 60))}:${pad(Math.floor(Math.random() * 60))}`;
const scaled = (recipe, k) => Object.fromEntries(Object.entries(recipe).map(([name, q]) => [name, qty(q * k)]));

saveSettings({
  store_name: 'Juice Fuel',
  receipt_footer: 'Crepe • Juice • Waffle • Saj — thank you!',
  pos_categories: '1',
  attributes: '1',
  recipes: '1',
  currency2_enabled: '1',
  currency2_symbol: 'L.L',
  currency2_rate: '89500',
  currency2_decimals: '0',
});

transact(() => {
  const insertProduct = db.prepare(
    `INSERT INTO products (name, barcode, category, unit, cost, price, min_stock, stocked, raw, has_variants, variant_of, variant_key, addon_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const product = (p) =>
    Number(
      insertProduct.run(
        p.name, p.barcode ?? null, p.category, p.unit ?? 'pcs', money(p.cost ?? 0), money(p.price ?? 0), p.min ?? 0,
        p.stocked ?? 1, p.raw ?? 0, p.template ? 1 : 0, p.of ?? null, p.key ?? null, p.addons ?? null,
      ).lastInsertRowid,
    );

  // Raw materials, by name.
  const raw = new Map();
  for (const [name, unit, cost] of RAW) {
    raw.set(name, { id: product({ name, category: 'Raw materials', unit, cost, raw: 1, min: unit === 'kg' || unit === 'l' ? 2 : 0 }), cost, unit });
  }
  const insertRecipe = db.prepare(`INSERT INTO recipe_lines (product_id, ingredient_id, qty, sort) VALUES (?, ?, ?, ?)`);
  const recipeCost = (recipe) => money(Object.entries(recipe).reduce((s, [name, q]) => s + q * raw.get(name).cost, 0));
  // Everything sold, with what it takes: { id, name, price, cost, recipe, category, toppings }
  const sellable = [];
  const made = (name, category, price, recipe, extra = {}) => {
    const cost = recipeCost(recipe);
    const id = product({ name, category, price, cost, stocked: 0, ...extra });
    Object.entries(recipe).forEach(([ing, q], i) => insertRecipe.run(id, raw.get(ing).id, q, i));
    const item = { id, name, price, cost, recipe, category };
    sellable.push(item);
    return item;
  };

  // Attributes: juice sizes and plate sizes.
  const insertAttr = db.prepare(`INSERT INTO attributes (name, sort) VALUES (?, ?)`);
  const insertValue = db.prepare(`INSERT INTO attribute_values (attribute_id, name, sort) VALUES (?, ?, ?)`);
  const valueIds = (attrName, sort, names) => {
    const attrId = Number(insertAttr.run(attrName, sort).lastInsertRowid);
    return Object.fromEntries(names.map((v, i) => [v, Number(insertValue.run(attrId, v, i).lastInsertRowid)]));
  };
  const sizeIds = valueIds('Size', 0, SIZES);
  const plateIds = valueIds('Plate', 1, PLATES);
  const linkValue = db.prepare(`INSERT INTO product_attribute_values (product_id, value_id) VALUES (?, ?)`);

  /** A template and one variant per value, each with its price and recipe. */
  const template = (name, category, values, ids, priceOf, recipeOf, extra = {}) => {
    const first = values[0];
    const templateId = product({ name, category, price: priceOf(first), stocked: 0, template: true, ...extra });
    const variants = [];
    for (const v of values) {
      linkValue.run(templateId, ids[v]);
      const variant = made(`${name} ${v}`, category, priceOf(v), recipeOf(v), { of: templateId, key: String(ids[v]), ...extra });
      linkValue.run(variant.id, ids[v]);
      variants.push({ ...variant, size: v });
    }
    return variants;
  };

  // Toppings for crêpes and waffles.
  const groupId = Number(db.prepare(`INSERT INTO addon_groups (name, sort) VALUES ('Crêpe toppings', 0)`).run().lastInsertRowid);
  const insertAddon = db.prepare(`INSERT INTO addons (group_id, name, price, cost, sort) VALUES (?, ?, 1, 0.25, ?)`);
  const toppings = TOPPINGS.map((name, i) => ({ id: Number(insertAddon.run(groupId, name, i).lastInsertRowid), name, price: 1, cost: 0.25 }));

  const juices = JUICES.map(([name, prices, recipe]) =>
    template(name, 'Fresh Juices', SIZES.filter((z) => prices[z] !== undefined), sizeIds, (z) => prices[z], (z) => scaled(recipe, SCALE[z])),
  );
  const shakes = MILKSHAKES.map(([name, price, recipe]) => made(name, 'Milkshakes', price, recipe));
  const smoothies = SMOOTHIES.map(([name, price, recipe]) => made(name, 'Smoothies', price, recipe));
  const crepes = CREPES.map(([name, price, recipe]) => made(name, 'Crêpes & More', price, recipe, { addons: groupId }));
  const plates = template('Qashta Plate', 'Crêpes & More', PLATES, plateIds, (z) => QASHTA_PLATE[z][0], (z) => ({ Qashta: QASHTA_PLATE[z][1], Honey: QASHTA_PLATE[z][2] }), { addons: groupId });
  const saj = SAJ.map(([name, price, recipe]) => made(name, 'Saj Manakish', price, recipe));
  const drinks = DRINKS.map(([name, barcode, cost, price]) => {
    const item = { id: product({ name, barcode, category: 'Soft Drinks', cost, price, min: 12 }), name, price, cost, recipe: null, category: 'Soft Drinks' };
    sellable.push(item);
    return item;
  });
  for (const v of [...juices.flat(), ...shakes, ...smoothies, ...crepes, ...plates, ...saj]) v.toppings = v.category === 'Crêpes & More';

  /* ------------------------------------------------------------ the month */

  // What sells: juices most (and M and L most of all), then crêpes and saj.
  const juiceSize = { S: 25, M: 35, L: 30, Bottle: 10 };
  const choose = () =>
    weighted([
      [() => {
        const sizes = pick(juices);
        return weighted(sizes.map((v) => [v, juiceSize[v.size]]));
      }, 40],
      [() => pick(crepes), 18],
      [() => weighted(plates.map((v, i) => [v, [4, 3, 2, 1][i]])), 3],
      [() => pick(saj), 20],
      [() => pick(shakes), 10],
      [() => pick(smoothies), 5],
      [() => pick(drinks), 8],
    ])();

  const tickets = [];
  const use = new Map(); // ingredient -> total estimated use, for the restocks
  const drinkSold = new Map();
  for (let offset = 35; offset >= 0; offset--) {
    const date = day(offset);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    if (weekday === 1) continue; // closed on Mondays
    const busy = weekday === 5 || weekday === 6 || weekday === 0 ? 1.4 : 1;
    const count = Math.round(between(28, 55) * busy);
    const minutes = Array.from({ length: count }, () => between(8 * 60, 23 * 60 + 50)).sort((a, b) => a - b);
    for (const m of minutes) {
      const lines = [];
      for (let i = 0, k = Math.round(between(1, 3.4)); i < k; i++) {
        const item = choose();
        const addons = item.toppings && Math.random() < 0.4 ? [...new Set([pick(toppings), pick(toppings)])].slice(0, Math.random() < 0.5 ? 1 : 2) : [];
        const line = {
          item,
          qty: Math.random() < 0.15 ? 2 : 1,
          addons,
          note: Math.random() < 0.06 ? pick(NOTES) : '',
        };
        line.unit_price = money(item.price + addons.reduce((s, a) => s + a.price, 0));
        line.unit_cost = money(item.cost + addons.reduce((s, a) => s + a.cost, 0));
        lines.push(line);
        if (item.recipe) for (const [ing, q] of Object.entries(item.recipe)) use.set(ing, (use.get(ing) || 0) + q * line.qty);
        else drinkSold.set(item.id, (drinkSold.get(item.id) || 0) + line.qty);
      }
      tickets.push({ date, at: `${date} ${clock(m)}`, lines, customer: Math.random() < 0.08 ? pick(CUSTOMERS) : '' });
    }
  }

  const insertMove = db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, ref_table, ref_id, note, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /* ---- purchases: produce weekly from the market, the rest from the wholesaler, enough to cover the month */
  const insertPurchase = db.prepare(`INSERT INTO purchases (doc_no, supplier, date, total, note, user_id) VALUES (?, ?, ?, ?, '', ?)`);
  const insertPurchaseItem = db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, total) VALUES (?, ?, ?, ?, ?)`);
  const FRESH = new Set(['Oranges', 'Apples', 'Carrots', 'Lemons', 'Grapefruit', 'Strawberries', 'Mango', 'Melon', 'Avocado', 'Pineapple', 'Passion fruit', 'Banana', 'Milk', 'Vegetables', 'Chicken', 'Minced meat', 'Labneh', 'Ice']);
  let purchaseNo = 0;
  const buy = (date, supplier, lines) => {
    if (!lines.length) return;
    const total = money(lines.reduce((s, l) => s + l.qty * l.cost, 0));
    const docNo = `PO-${String(++purchaseNo).padStart(6, '0')}`;
    const id = Number(insertPurchase.run(docNo, supplier, date, total, admin.id).lastInsertRowid);
    for (const l of lines) {
      insertPurchaseItem.run(id, l.id, l.qty, l.cost, money(l.qty * l.cost));
      insertMove.run(l.id, l.qty, l.cost, 'purchase', 'purchases', id, docNo, admin.id, `${date} 07:30:00`);
    }
  };
  const share = (name, part) => {
    const r = raw.get(name);
    const q = Math.ceil((use.get(name) || 0) * part * 10) / 10;
    return q > 0 ? { id: r.id, qty: q, cost: r.cost } : null;
  };
  for (const offset of [37, 30, 23, 16, 9, 2]) {
    buy(day(offset), 'Nabatieh Vegetable Market', [...FRESH].map((name) => share(name, 0.21)).filter(Boolean));
  }
  for (const offset of [38, 20]) {
    buy(day(offset), 'Wholesale Food Depot', RAW.map(([name]) => name).filter((name) => !FRESH.has(name)).map((name) => share(name, 0.65)).filter(Boolean));
    buy(day(offset), 'Beverage Distributor', drinks.map((d) => ({ id: d.id, qty: Math.ceil((drinkSold.get(d.id) || 0) * 0.6 + 12), cost: d.cost })));
  }

  /* ---- the sales themselves, each with what it probably used */
  const insertSale = db.prepare(
    `INSERT INTO sales (doc_no, customer, date, subtotal, discount, tax, total, cogs, paid, method, note, user_id, created_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, '', ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost, discount, total, addons, note) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  const insertPayment = db.prepare(`INSERT INTO payments (sale_id, amount, method, date, note, user_id, created_at) VALUES (?, ?, ?, ?, '', ?, ?)`);
  const insertUse = db.prepare(`INSERT INTO estimated_use (sale_id, sale_item_id, ingredient_id, qty, created_at) VALUES (?, ?, ?, ?, ?)`);
  let saleNo = 0;
  for (const tk of tickets) {
    const subtotal = money(tk.lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
    const cogs = money(tk.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
    const docNo = `INV-${String(++saleNo).padStart(6, '0')}`;
    const method = weighted([['cash', 85], ['card', 10], ['transfer', 5]]);
    const saleId = Number(insertSale.run(docNo, tk.customer, tk.date, subtotal, subtotal, cogs, subtotal, method, admin.id, tk.at).lastInsertRowid);
    insertPayment.run(saleId, subtotal, method, tk.date, admin.id, tk.at);
    for (const l of tk.lines) {
      const itemId = Number(
        insertItem.run(
          saleId, l.item.id, l.qty, l.unit_price, l.unit_cost, money(l.qty * l.unit_price),
          l.addons.length ? JSON.stringify(l.addons.map(({ id, name, price }) => ({ id, name, price }))) : '', l.note,
        ).lastInsertRowid,
      );
      if (l.item.recipe) {
        for (const [ing, q] of Object.entries(l.item.recipe)) insertUse.run(saleId, itemId, raw.get(ing).id, qty(q * l.qty), `${tk.at}.000`);
      } else {
        insertMove.run(l.item.id, -l.qty, l.item.cost, 'sale', 'sales', saleId, docNo, admin.id, tk.at);
      }
    }
  }

  /* ---- a reconciliation a week ago: every ingredient, a little over what the recipes said */
  const cutoff = `${day(7)} 23:59:59.999`;
  const conId = Number(
    db
      .prepare(`INSERT INTO consumptions (doc_no, until, note, status, user_id, created_at, submitted_at) VALUES ('CON-000001', ?, 'Weekly count', 'submitted', ?, ?, ?)`)
      .run(cutoff, admin.id, `${day(7)} 23:50:00`, `${day(6)} 08:05:00`).lastInsertRowid,
  );
  const insertConItem = db.prepare(
    `INSERT INTO consumption_items (consumption_id, product_id, since, suggested, actual, counted, unit_cost, sort) VALUES (?, ?, '', ?, ?, NULL, ?, ?)`,
  );
  let sort = 0;
  for (const [name, r] of raw) {
    const suggested = qty(db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM estimated_use WHERE ingredient_id = ? AND created_at <= ?`).get(r.id, cutoff).q);
    if (suggested <= 0) continue;
    const actual = qty(suggested * between(0.97, 1.12));
    insertConItem.run(conId, r.id, suggested, actual, r.cost, sort++);
    insertMove.run(r.id, -actual, r.cost, 'consumption', 'consumptions', conId, 'CON-000001', admin.id, cutoff);
    db.prepare(`UPDATE products SET consumed_until = ? WHERE id = ?`).run(cutoff, r.id);
    void name;
  }

  /* ---- running costs, twice over the period */
  const insertExpense = db.prepare(`INSERT INTO expenses (date, category, note, amount, method, user_id) VALUES (?, ?, ?, ?, 'cash', ?)`);
  EXPENSES.forEach(([category, note, amount], i) => {
    for (const offset of [33 - i, 3 + (i % 3)]) insertExpense.run(day(offset), category, note, money(amount * between(0.9, 1.1)), admin.id);
  });

  const names = (sql) => db.prepare(sql).all().map((r) => r.name).filter(Boolean);
  for (const [kind, sql] of [
    ['category', `SELECT DISTINCT category AS name FROM products`],
    ['unit', `SELECT DISTINCT unit AS name FROM products`],
    ['supplier', `SELECT DISTINCT supplier AS name FROM purchases`],
    ['customer', `SELECT DISTINCT customer AS name FROM sales`],
    ['expense_category', `SELECT DISTINCT category AS name FROM expenses`],
  ]) {
    names(sql).forEach((name) => rememberEntity(kind, name));
  }
});

const counts = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM products WHERE raw = 0 AND variant_of IS NULL) AS menu_items,
            (SELECT COUNT(*) FROM products WHERE variant_of IS NOT NULL) AS variants,
            (SELECT COUNT(*) FROM products WHERE raw = 1) AS raw_materials,
            (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM purchases) AS purchases,
            (SELECT COUNT(*) FROM expenses) AS expenses`,
  )
  .get();
console.log('Juice bar demo created:', { ...counts });
