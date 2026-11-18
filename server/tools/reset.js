/**
 * Wipes all business data — products, stock, sales, purchases, expenses, shifts,
 * recipes, attributes, add-ons, reconciliations, and the names typed into them —
 * but keeps the users, the settings, the price lists, the exchange rate and the
 * ways the shop takes payment.
 *
 *   npm run reset
 *
 * Take a backup first (npm run backup): there is no undo.
 */
import { db, transact } from '../db.js';

// Children before their parents, so no foreign key is left pointing nowhere.
const TABLES = [
  'held_sales',
  'estimated_use',
  'consumption_items',
  'consumptions',
  'recipe_lines',
  'product_attribute_values',
  'addon_links',
  'attribute_values',
  'attributes',
  'payments',
  'sale_items',
  'sales',
  'shifts',
  'purchase_items',
  'purchase_log',
  'purchases',
  'adjustment_items',
  'adjustments',
  'stock_moves',
  'expenses',
  'product_prices',
  'price_changes',
  'product_barcodes',
  'product_images',
  'product_sizes',
  'products',
  'addons',
  'addon_groups',
];

const exists = (name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

transact(() => {
  const wiped = TABLES.filter(exists);
  for (const table of wiped) db.exec(`DELETE FROM ${table}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${wiped.map((t) => `'${t}'`).join(',')})`);
  // Customers, suppliers, categories, units…: names that belonged to that data.
  // How the shop takes payment is a setting, and stays.
  if (exists('entities')) db.exec(`DELETE FROM entities WHERE kind <> 'payment_method'`);
});

console.log('All business data was deleted: products, stock, sales, purchases, expenses, shifts,');
console.log('recipes, attributes, add-ons and reconciliations.');
console.log('Users, settings, price lists, the exchange rate and payment methods were kept.');
