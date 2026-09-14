/**
 * Adds a large demo catalogue: 131 products across 20 categories, with opening
 * stock, so the till, the item search and the reports can be tried at a
 * realistic size.
 *
 *   npm run demo:products              add them (anything already there is skipped)
 *   npm run demo:products -- --remove  take them out again
 *
 * Names are Arabic with an English description, so the item search finds them
 * in either language. Barcodes are valid EAN-13 codes in the 200 in-store range,
 * which is reserved for shops' own labels and never clashes with a real product.
 *
 * Removing is careful: a demo product that has already been sold or bought is
 * archived instead of deleted, so no invoice ever loses its line.
 */
import { db, transact, lastId } from '../db.js';
import { rememberAll } from '../entities.js';
import { money } from '../util.js';
import { addDemoPictures } from './demo-images.js';

// [category, unit, [ [arabic name, english description, price], ... ]]
const CATALOGUE = [
  ['معسل', 'box', [
    ['معسل نخلة تفاحتين', 'Nakhla tobacco, double apple, 250g', 6.5],
    ['معسل نخلة نعنع', 'Nakhla tobacco, mint, 250g', 6.5],
    ['معسل نخلة عنب', 'Nakhla tobacco, grape, 250g', 6.5],
    ['معسل نخلة ليمون ونعنع', 'Nakhla tobacco, lemon mint, 250g', 6.5],
    ['معسل نخلة بطيخ', 'Nakhla tobacco, watermelon, 250g', 6.5],
    ['معسل نخلة توت', 'Nakhla tobacco, blueberry, 250g', 6.5],
    ['معسل الفاخر تفاحتين', 'Al Fakher tobacco, double apple, 250g', 7.5],
    ['معسل الفاخر نعنع', 'Al Fakher tobacco, mint, 250g', 7.5],
    ['معسل الفاخر عنب ونعنع', 'Al Fakher tobacco, grape mint, 250g', 7.5],
    ['معسل الفاخر علكة', 'Al Fakher tobacco, gum, 250g', 7.5],
    ['معسل الفاخر برتقال', 'Al Fakher tobacco, orange, 250g', 7.5],
    ['معسل الفاخر خوخ', 'Al Fakher tobacco, peach, 250g', 7.5],
    ['معسل أداليا ليدي كيلر', 'Adalya tobacco, lady killer, 250g', 8],
    ['معسل أداليا لوف 66', 'Adalya tobacco, love 66, 250g', 8],
    ['معسل أداليا مانغو', 'Adalya tobacco, mango, 250g', 8],
    ['معسل أداليا بطيخ ونعنع', 'Adalya tobacco, watermelon mint, 250g', 8],
    ['معسل أداليا قهوة', 'Adalya tobacco, coffee, 250g', 8],
    ['معسل أداليا فراولة', 'Adalya tobacco, strawberry, 250g', 8],
  ]],
  ['فحم', 'pack', [
    ['فحم جوز الهند', 'Coconut charcoal cubes, 1kg', 5.5],
    ['فحم سريع الاشتعال', 'Quick-light charcoal, 10 rolls', 3],
    ['فحم ليمون', 'Lemon wood charcoal, 3kg', 7],
  ]],
  ['مشروبات غازية', 'pcs', [
    ['بيبسي علبة', 'Pepsi can, 330ml', 0.75],
    ['بيبسي قنينة', 'Pepsi bottle, 1.25L', 1.5],
    ['سفن أب علبة', '7Up can, 330ml', 0.75],
    ['سفن أب قنينة', '7Up bottle, 1.25L', 1.5],
    ['ميريندا علبة', 'Mirinda orange can, 330ml', 0.75],
    ['ميريندا قنينة', 'Mirinda orange bottle, 1.25L', 1.5],
    ['كوكا كولا علبة', 'Coca-Cola can, 330ml', 0.8],
    ['كوكا كولا قنينة', 'Coca-Cola bottle, 1.25L', 1.6],
  ]],
  ['مياه', 'pcs', [
    ['مياه صحة صغيرة', 'Sohat water, 500ml', 0.35],
    ['مياه صحة كبيرة', 'Sohat water, 1.5L', 0.7],
    ['مياه صحة غالون', 'Sohat water gallon, 10L', 3],
    ['مياه تنورين صغيرة', 'Tannourine water, 500ml', 0.35],
    ['مياه تنورين كبيرة', 'Tannourine water, 1.5L', 0.7],
    ['مياه تنورين غالون', 'Tannourine water gallon, 10L', 3],
  ]],
  ['عصائر', 'pcs', [
    ['عصير برتقال', 'Orange juice, 1L', 2.2],
    ['عصير تفاح', 'Apple juice, 1L', 2.2],
    ['عصير مانغو', 'Mango juice, 1L', 2.4],
    ['عصير أناناس', 'Pineapple juice, 1L', 2.4],
  ]],
  ['مشروبات طاقة', 'pcs', [
    ['ريد بول', 'Red Bull, 250ml', 2],
    ['مونستر', 'Monster Energy, 500ml', 2.5],
    ['إكس إكس إل', 'XXL Energy, 250ml', 1.2],
  ]],
  ['قهوة', 'pcs', [
    ['بن نجار 200غ', 'Najjar coffee with cardamom, 200g', 3.5],
    ['بن نجار 450غ', 'Najjar coffee with cardamom, 450g', 7],
    ['نسكافيه كلاسيك 50غ', 'Nescafé Classic, 50g', 3],
    ['نسكافيه كلاسيك 100غ', 'Nescafé Classic, 100g', 5.5],
    ['نسكافيه 3 في 1', 'Nescafé 3-in-1, 30 sachets', 6],
  ]],
  ['شاي', 'box', [
    ['شاي ليبتون 25 كيس', 'Lipton Yellow Label, 25 bags', 1.8],
    ['شاي ليبتون 100 كيس', 'Lipton Yellow Label, 100 bags', 5],
    ['شاي أخضر', 'Green tea, 25 bags', 2.5],
    ['بابونج', 'Chamomile tea, 25 bags', 2.5],
  ]],
  ['سناكس', 'pcs', [
    ['تشيبس ليز ملح', 'Lay\'s salted chips, 70g', 1],
    ['تشيبس ليز جبنة', 'Lay\'s cheese chips, 70g', 1],
    ['تشيبس ليز كاتشب', 'Lay\'s ketchup chips, 70g', 1],
    ['دوريتوس', 'Doritos nacho cheese, 80g', 1.2],
    ['برينغلز أصلي', 'Pringles original, 165g', 3],
    ['برينغلز كريمة وبصل', 'Pringles sour cream & onion, 165g', 3],
    ['تشيبس ماستر', 'Master chips, 45g', 0.5],
  ]],
  ['شوكولا', 'pcs', [
    ['كيت كات', 'KitKat, 4 fingers', 0.9],
    ['سنيكرز', 'Snickers, 50g', 0.9],
    ['تويكس', 'Twix, 50g', 0.9],
    ['مارس', 'Mars, 51g', 0.9],
    ['غالاكسي', 'Galaxy smooth milk, 40g', 1],
    ['كيندر بوينو', 'Kinder Bueno, 43g', 1.3],
    ['كادبوري ديري ميلك', 'Cadbury Dairy Milk, 90g', 1.8],
  ]],
  ['بسكويت', 'pack', [
    ['أوريو', 'Oreo biscuits, 133g', 1.2],
    ['بسكويت دايجستف', 'Digestive biscuits, 400g', 2.5],
    ['تاك', 'TUC crackers, 100g', 1],
    ['معمول تمر', 'Date maamoul, 12 pieces', 4],
  ]],
  ['مخبوزات', 'pcs', [
    ['خبز عربي', 'Arabic bread, large bag', 1],
    ['كرواسون زعتر', 'Zaatar croissant', 1.2],
    ['منقوشة جبنة', 'Cheese manakish', 2],
    ['كعك', 'Kaak sesame bread', 1.5],
  ]],
  ['ألبان وأجبان', 'pcs', [
    ['حليب طازج', 'Fresh milk, 1L', 1.6],
    ['لبنة', 'Labneh, 500g', 3],
    ['لبن', 'Plain yoghurt, 1kg', 2.5],
    ['حلوم', 'Halloumi cheese, 250g', 4],
    ['جبنة عكاوي', 'Akkawi cheese, 500g', 5],
    ['زبدة', 'Butter, 200g', 2.8],
  ]],
  ['مواد غذائية', 'pcs', [
    ['أرز 1 كغ', 'Egyptian rice, 1kg', 1.8],
    ['أرز 5 كغ', 'Egyptian rice, 5kg', 8],
    ['سكر 1 كغ', 'White sugar, 1kg', 1.2],
    ['طحين 1 كغ', 'All-purpose flour, 1kg', 1],
    ['معكرونة', 'Spaghetti, 500g', 1],
    ['عدس', 'Red lentils, 1kg', 2],
    ['برغل', 'Coarse bulgur, 1kg', 1.8],
    ['زيت زيتون', 'Extra virgin olive oil, 1L', 9],
    ['زيت دوار الشمس', 'Sunflower oil, 1.8L', 4.5],
    ['رب البندورة', 'Tomato paste, 400g', 1.2],
    ['تونا', 'Tuna in oil, 160g', 2],
    ['حمص معلب', 'Hummus tahini, 400g', 1.5],
    ['حمص حب', 'Chickpeas can, 400g', 0.9],
  ]],
  ['بهارات', 'pack', [
    ['زعتر', 'Zaatar mix, 250g', 3],
    ['سماق', 'Sumac, 100g', 1.8],
    ['سبع بهارات', 'Seven spices, 100g', 1.8],
    ['ملح', 'Table salt, 1kg', 0.6],
  ]],
  ['تنظيف', 'pcs', [
    ['سائل جلي', 'Dishwashing liquid, 1L', 2],
    ['مسحوق غسيل', 'Laundry powder, 3kg', 9],
    ['كلور', 'Bleach, 1L', 1.5],
    ['منظف أرضيات', 'Floor cleaner, 2L', 3],
    ['منظف زجاج', 'Glass cleaner, 500ml', 2.2],
    ['إسفنج جلي', 'Kitchen sponges, pack of 5', 1.2],
    ['أكياس نفايات', 'Garbage bags, 30 pieces', 2],
    ['محارم', 'Facial tissues, box of 200', 1.5],
    ['ورق تواليت', 'Toilet paper, 10 rolls', 5],
    ['محارم مطبخ', 'Kitchen towels, 2 rolls', 2.5],
  ]],
  ['عناية شخصية', 'pcs', [
    ['شامبو', 'Shampoo, 400ml', 4.5],
    ['جل استحمام', 'Shower gel, 500ml', 4],
    ['معجون أسنان', 'Toothpaste, 100ml', 2.2],
    ['فرشاة أسنان', 'Toothbrush, medium', 1.5],
    ['مزيل عرق', 'Deodorant spray, 150ml', 3.5],
    ['شفرات حلاقة', 'Disposable razors, pack of 5', 3],
    ['صابون يدين', 'Liquid hand soap, 500ml', 2],
    ['مناديل مبللة', 'Wet wipes, 80 pieces', 2],
  ]],
  ['أطفال', 'pack', [
    ['حفاضات مقاس 3', 'Diapers size 3, 50 pieces', 14],
    ['حفاضات مقاس 4', 'Diapers size 4, 46 pieces', 14],
    ['مناديل أطفال', 'Baby wipes, 72 pieces', 2.5],
    ['حليب أطفال', 'Infant formula, 400g', 18],
  ]],
  ['إكسسوارات', 'pcs', [
    ['كابل شحن تايب سي', 'USB-C charging cable, 1m', 4],
    ['كابل شحن آيفون', 'Lightning charging cable, 1m', 5],
    ['باور بانك', 'Power bank, 10000mAh', 18],
    ['سماعات', 'Wired earphones', 6],
    ['بطاريات AA', 'AA batteries, pack of 4', 3],
    ['بطاريات AAA', 'AAA batteries, pack of 4', 3],
    ['قداحة', 'Lighter', 0.5],
    ['نبريش أرجيلة', 'Hookah hose', 4],
    ['رأس أرجيلة فخار', 'Clay hookah head', 3],
    ['ورق ألمنيوم', 'Aluminium foil, 30m', 2.5],
  ]],
  ['مجلدات', 'pack', [
    ['بطاطا مقلية مجلدة', 'Frozen french fries, 2.5kg', 6],
    ['ناغتس دجاج', 'Chicken nuggets, 1kg', 7.5],
    ['آيس كريم', 'Vanilla ice cream tub, 2L', 6.5],
  ]],
];

/** EAN-13 check digit for the first twelve digits. */
function ean13(twelve) {
  const sum = [...twelve].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
}

/** Small deterministic generator, so every run produces the same shop. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function build() {
  const random = rng(20260914);
  const out = [];
  let n = 1;
  for (const [category, unit, items] of CATALOGUE) {
    for (const [name, description, price] of items) {
      const margin = 0.55 + random() * 0.2; // cost is 55-75% of price
      out.push({
        name,
        description,
        category,
        unit,
        price: money(price),
        cost: money(price * margin),
        barcode: ean13(`200${String(n).padStart(9, '0')}`),
        min_stock: 3 + Math.floor(random() * 12),
        opening: 10 + Math.floor(random() * 110),
      });
      n++;
    }
  }
  return out;
}

const products = build();
const remove = process.argv.includes('--remove');
const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1`).get();

if (remove) {
  let deleted = 0;
  let archived = 0;
  transact(() => {
    for (const p of products) {
      const row = db.prepare(`SELECT id FROM products WHERE barcode = ?`).get(p.barcode);
      if (!row) continue;
      const { used } = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = ?)
                + (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?) AS used`,
        )
        .get(row.id, row.id);
      if (used > 0) {
        db.prepare(`UPDATE products SET active = 0 WHERE id = ?`).run(row.id);
        archived++;
      } else {
        db.prepare(`DELETE FROM products WHERE id = ?`).run(row.id); // stock moves go with it
        deleted++;
      }
    }
  });
  console.log(`Demo products removed: ${deleted} deleted, ${archived} archived (already on a sale or purchase).`);
  process.exit(0);
}

let added = 0;
let skipped = 0;
const addedIds = [];
transact(() => {
  const insert = db.prepare(
    `INSERT INTO products (name, description, barcode, category, unit, cost, price, min_stock, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const opening = db.prepare(
    `INSERT INTO stock_moves (product_id, qty, unit_cost, kind, note, user_id)
     VALUES (?, ?, ?, 'opening', 'Opening balance', ?)`,
  );
  for (const p of products) {
    if (db.prepare(`SELECT 1 FROM products WHERE barcode = ?`).get(p.barcode)) {
      skipped++;
      continue;
    }
    const id = lastId(
      insert.run(p.name, p.description, p.barcode, p.category, p.unit, p.cost, p.price, p.min_stock),
    );
    opening.run(id, p.opening, p.cost, admin?.id ?? null);
    addedIds.push(id);
    rememberAll([
      ['category', p.category],
      ['unit', p.unit],
    ]);
    added++;
  }
});

// Each new demo product gets a drawn picture, for the till's picture cards.
const pictures = addedIds.length ? addDemoPictures({ ids: addedIds }) : 0;

const categories = new Set(products.map((p) => p.category)).size;
if (pictures) console.log(`Demo pictures: ${pictures} drawn.`);
console.log(`Demo products: ${added} added, ${skipped} already there (${products.length} in the set, ${categories} categories).`);
console.log('Remove them again with:  npm run demo:products -- --remove');
