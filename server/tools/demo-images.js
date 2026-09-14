/**
 * Demo pictures for products, drawn rather than downloaded: a soft gradient in a
 * colour of the product's own, with an emoji that matches what it is (a drink,
 * rice, chocolate, a battery…). Enough to try the till's picture cards without
 * photographing a shop.
 *
 *   npm run demo:images               add a picture to every product that has none
 *   npm run demo:images -- --refresh  redraw the demo pictures (real photos are left alone)
 *   npm run demo:images -- --remove   take the demo pictures out again
 *
 * They are stored as SVG, which only this tool writes: uploads through the app
 * stay limited to JPEG, PNG and WebP.
 */
import { pathToFileURL } from 'node:url';

import { db, transact } from '../db.js';

export const DEMO_MIME = 'image/svg+xml';

// First match wins, so the specific words come before the general ones.
const PICTURES = [
  [/tobacco|معسل/, '💨'],
  [/charcoal|فحم/, '🔥'],
  [/lighter|قداحة/, '🔥'],
  [/ice cream|آيس/, '🍨'],
  [/energy|red bull|xxl/, '⚡'],
  [/cola|pepsi|7up|mirinda|soda|غازية/, '🥤'],
  [/juice|عصير/, '🧃'],
  [/water|مياه/, '💧'],
  [/coffee|nescafe|قهوة|بن/, '☕'],
  [/tea|chamomile|شاي|بابونج/, '🍵'],
  [/milk|laban|حليب|لبن/, '🥛'],
  [/cheese|labneh|halloumi|akkawi|جبنة|لبنة|حلوم/, '🧀'],
  [/croissant|كرواسون/, '🥐'],
  [/muffin|cake|كيك/, '🧁'],
  [/bread|kaak|pita|خبز|كعك/, '🍞'],
  [/chips|pringles|تشيبس|برينغلز/, '🥔'],
  [/fries|frozen|بطاطا/, '🍟'],
  [/chocolate|twix|snickers|galaxy|cadbury|kitkat|mars|شوكولا|سنيكرز|تويكس|غالاكسي/, '🍫'],
  [/biscuit|oreo|cookie|digestive|بسكويت|أوريو/, '🍪'],
  [/rice|أرز/, '🍚'],
  [/bulgur|lentil|chickpea|beans|برغل|عدس|حمص|فول/, '🫘'],
  [/pasta|spaghetti|معكرونة/, '🍝'],
  [/flour|طحين/, '🌾'],
  [/sugar|سكر/, '🍬'],
  [/salt|spice|sumac|zaatar|pepper|ملح|بهارات|سماق|زعتر/, '🧂'],
  [/oil|زيت/, '🫒'],
  [/tuna|sardine|تونا|سردين/, '🐟'],
  [/egg|بيض/, '🥚'],
  [/honey|عسل/, '🍯'],
  [/jam|مربى/, '🍓'],
  [/diaper|formula|baby|حفاض|أطفال/, '🍼'],
  [/shampoo|shower|soap|lotion|شامبو|صابون|جل/, '🧴'],
  [/toothpaste|toothbrush|معجون|فرشاة/, '🪥'],
  [/razor|شفرات/, '🪒'],
  [/tissue|napkin|toilet|محارم|مناديل/, '🧻'],
  [/sponge|detergent|bleach|clean|إسفنج|منظف|كلور/, '🧽'],
  [/garbage|bags|نفايات|أكياس/, '🗑️'],
  [/batter|بطاريات/, '🔋'],
  [/earphone|headphone|سماعات/, '🎧'],
  [/cable|charg|power bank|كابل|شاحن|باور/, '🔌'],
  [/cups|أكواب/, '🥤'],
  [/drink|مشروب/, '🥤'],
];

const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7);

/** The emoji for a product, from its name, description and category. */
export function pictureFor(product) {
  const text = [product.name, product.description, product.category].filter(Boolean).join(' ').toLowerCase();
  return PICTURES.find(([pattern]) => pattern.test(text))?.[1] || '🛒';
}

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A 400×300 SVG: a gradient tinted by the category, soft circles, and the emoji towards the lower
 *  end corner, clear of the name and description that sit over the top of a till card. */
export function demoPicture(product) {
  const hue = hash(product.category || product.name || '') % 360;
  const shift = (hash(product.name || '') % 40) - 20;
  const emoji = escapeXml(pictureFor(product));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 75%, 78%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40 + shift + 360) % 360}, 70%, 60%)"/>
    </linearGradient>
  </defs>
  <rect width="400" height="300" fill="url(#g)"/>
  <circle cx="345" cy="45" r="95" fill="#ffffff" opacity="0.18"/>
  <circle cx="40" cy="275" r="80" fill="#ffffff" opacity="0.14"/>
  <text x="292" y="188" font-size="140" text-anchor="middle" dominant-baseline="middle"
        font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">${emoji}</text>
</svg>`;
}

/** Give demo pictures to the products listed (or every product), skipping real photos. */
export function addDemoPictures({ ids = null, refresh = false } = {}) {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.category, i.mime FROM products p
       LEFT JOIN product_images i ON i.product_id = p.id`,
    )
    .all()
    .filter((p) => !ids || ids.includes(p.id));
  const upsert = db.prepare(
    `INSERT INTO product_images (product_id, mime, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  );
  let added = 0;
  transact(() => {
    for (const p of rows) {
      const isDemo = p.mime === DEMO_MIME;
      if (p.mime && !(refresh && isDemo)) continue; // a real photo, or already has a demo one
      upsert.run(p.id, DEMO_MIME, Buffer.from(demoPicture(p), 'utf8'));
      added++;
    }
  });
  return added;
}

export function removeDemoPictures() {
  return Number(db.prepare(`DELETE FROM product_images WHERE mime = ?`).run(DEMO_MIME).changes);
}

// Run as a command.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--remove')) {
    console.log(`Demo pictures removed: ${removeDemoPictures()}`);
  } else {
    const n = addDemoPictures({ refresh: process.argv.includes('--refresh') });
    console.log(`Demo pictures added: ${n}`);
  }
}
