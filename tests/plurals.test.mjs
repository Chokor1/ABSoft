/** Counted strings take the right plural form: English one/other, Arabic one, two, few, many, other. No server needed. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };

// i18n.js reads the saved language and sets <html dir> as it loads.
const saved = {};
globalThis.localStorage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => (saved[k] = String(v)) };
globalThis.document = { documentElement: {} };
const { t, setLang } = await import('../public/js/i18n.js');

setLang('en');
check('English, 1', t('dash.restock_warning', { n: 1 }) === '1 product needs restocking', t('dash.restock_warning', { n: 1 }));
check('English, 3', t('dash.restock_warning', { n: 3 }) === '3 products need restocking');
check('English, 0 is plural', t('pos.item_count', { n: 0 }) === '0 items');
check('English "once"', t('buy.edited_times', { n: 1 }) === 'Edited once' && t('buy.edited_times', { n: 4 }) === 'Edited 4 times');
check('a formatted count still picks its form', t('pos.item_count', { n: '1,234' }) === '1,234 items' && t('pos.item_count', { n: '1' }) === '1 item');

setLang('ar');
const ar = (n) => t('dash.restock_warning', { n });
check('Arabic 0 → other', ar(0) === '0 منتج بحاجة إلى إعادة تعبئة', ar(0));
check('Arabic 1 → one, spelled out', ar(1) === 'منتج واحد بحاجة إلى إعادة تعبئة', ar(1));
check('Arabic 2 → dual', ar(2) === 'منتجان بحاجة إلى إعادة تعبئة', ar(2));
check('Arabic 3 → few (plural)', ar(3) === '3 منتجات بحاجة إلى إعادة تعبئة', ar(3));
check('Arabic 10 → few', ar(10) === '10 منتجات بحاجة إلى إعادة تعبئة', ar(10));
check('Arabic 11 → many (singular, accusative)', ar(11) === '11 منتجاً بحاجة إلى إعادة تعبئة', ar(11));
check('Arabic 99 → many', ar(99) === '99 منتجاً بحاجة إلى إعادة تعبئة', ar(99));
check('Arabic 100 → other', ar(100) === '100 منتج بحاجة إلى إعادة تعبئة', ar(100));
check('Arabic 103 → few again', ar(103) === '103 منتجات بحاجة إلى إعادة تعبئة', ar(103));
check('Arabic formatted "1٬203" → few', ar('1٬203') === '1٬203 منتجات بحاجة إلى إعادة تعبئة', ar('1٬203'));
check('Arabic twice', t('buy.edited_times', { n: 2 }) === 'عُدّل مرتين');
check('Arabic placeholders still fill', t('pos.payment_sub', { n: 2, t: '$5.00' }) === 'بندان · الإجمالي $5.00', t('pos.payment_sub', { n: 2, t: '$5.00' }));
check('a plain string is untouched', t('nav.expenses') === 'المصاريف');

// The dictionary itself: read the literal, since the module keeps it private.
const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../public/js/i18n.js'), 'utf8');
const DICT = new Function(`return ${src.slice(src.indexOf('const DICT = {') + 'const DICT = '.length, src.indexOf('\n};\n') + 2)}`)();
const holes = (s) => (s.match(/\{\w+\}/g) || []).filter((p) => p !== '{n}').sort().join(' ');
const problems = [];
for (const [lng, table] of Object.entries(DICT)) {
  for (const [key, v] of Object.entries(table)) {
    if (typeof v === 'string') {
      if (/\((s|es)\)/.test(v)) problems.push(`${lng} ${key}: "(s)"`);
      continue;
    }
    const need = lng === 'ar' ? ['one', 'two', 'few', 'many', 'other'] : ['one', 'other'];
    for (const f of need) if (typeof v[f] !== 'string') problems.push(`${lng} ${key}: no ${f}`);
    for (const f of ['few', 'many', 'other']) if (v[f] && !v[f].includes('{n}')) problems.push(`${lng} ${key}.${f}: no {n}`);
    const want = holes(v.other || '');
    for (const [f, s] of Object.entries(v)) if (holes(s) !== want) problems.push(`${lng} ${key}.${f}: placeholders differ`);
    const other = lng === 'en' ? DICT.ar[key] : DICT.en[key];
    if (typeof other !== 'object') problems.push(`${key}: plural in ${lng} only`);
  }
}
check('every counted string has all its forms, keeps its placeholders, and is plural in both languages', !problems.length, '\n    ' + problems.join('\n    '));
const counted = Object.values(DICT.ar).filter((v) => typeof v === 'object').length;
check(`no "(s)" left; ${counted} counted strings`, counted >= 40);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
