/** The chart's value axis: round steps that always take in zero. No server needed. */
import { niceStep, niceTicks, stepDecimals } from '../public/js/chart-scale.js';

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l} ${d}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRound = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-9;

check('steps are 1, 2 or 5 times a power of ten', same([0.07, 0.3, 1.5, 3, 7, 135, 316, 4200].map(niceStep), [0.1, 0.5, 2, 5, 10, 200, 500, 5000]));
check('a step that is already round stays', same([1, 2, 5, 10, 200].map(niceStep), [1, 2, 5, 10, 200]));

// The dashboard before this change: revenue up to 541, net profit down to -723 on rent day.
const old = niceTicks(-723, 541);
check('a range across zero includes zero', old.ticks.includes(0), JSON.stringify(old.ticks));
check('…and every tick is a whole step', old.ticks.every((v) => isRound(v, old.step)), JSON.stringify(old.ticks));

// After: gross profit never below zero, so the axis starts at 0.
const now = niceTicks(0, 541);
check('revenue up to 541 reads 0 / 200 / 400 / 600', same(now.ticks, [0, 200, 400, 600]), JSON.stringify(now.ticks));
check('a maximum on a whole step adds no empty step', same(niceTicks(0, 600).ticks, [0, 200, 400, 600]), JSON.stringify(niceTicks(0, 600).ticks));
check('all-positive values still start at zero', niceTicks(120, 480).ticks[0] === 0);
check('all-negative values still end at zero', niceTicks(-480, -120).ticks.at(-1) === 0);
check('nothing at all still gives an axis', same(niceTicks(0, 0).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]), JSON.stringify(niceTicks(0, 0).ticks));

// A slow product: a few dollars a day.
const small = niceTicks(0, 9);
check('a narrow range steps by a round number', small.ticks.every((v) => isRound(v, small.step)) && small.step === 2, JSON.stringify(small));
const tiny = niceTicks(0, 1.3);
check('below one, ticks are exact decimals', same(tiny.ticks, [0, 0.5, 1, 1.5]), JSON.stringify(tiny.ticks));
check('no floating-point dust in ticks', niceTicks(0, 0.7).ticks.every((v) => String(v).length <= 4), JSON.stringify(niceTicks(0, 0.7).ticks));

check('labels get the decimals their step needs', same([500, 1, 0.5, 0.2, 0.05, 0.01].map(stepDecimals), [0, 0, 1, 1, 2, 2]));

// Neighbouring labels never read the same, across a wide sweep of ranges.
let clash = null;
for (let hi = 0.3; hi < 5e6 && !clash; hi *= 1.37) {
  const s = niceTicks(0, hi), d = stepDecimals(s.step);
  const labels = s.ticks.map((v) => v.toFixed(d));
  if (new Set(labels).size !== labels.length) clash = { hi, labels };
}
check('no two ticks share a label from 0.3 to 5,000,000', !clash, JSON.stringify(clash));
check('three to six steps, never fewer or more', (() => {
  for (let hi = 0.3; hi < 5e6; hi *= 1.37) { const n = niceTicks(-hi / 3, hi).ticks.length - 1; if (n < 3 || n > 6) return false; }
  return true;
})());

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
