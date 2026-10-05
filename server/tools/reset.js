/**
 * Wipes all business data but keeps users and settings.
 *
 *   npm run reset
 */
import { db, transact } from '../db.js';

transact(() => {
  // Held sales first: they name products, and a cart of products that are gone is no use.
  for (const table of ['held_sales', 'sale_items', 'sales', 'purchase_items', 'purchases', 'stock_moves', 'expenses', 'products']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN
    ('held_sales','sale_items','sales','purchase_items','purchases','stock_moves','expenses','products')`);
});

console.log('All products, sales, purchases, stock movements and expenses were deleted.');
console.log('Users and settings were kept.');
