/**
 * The value axis of a chart: round steps (1, 2 or 5 × 10ⁿ) that always take in zero,
 * so every label is a number a person would write and the zero line is always drawn.
 * Kept apart from ui.js so it has no browser dependencies and can be tested on its own.
 */

/** The round step nearest above `raw`: 1, 2 or 5 times a power of ten. */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power;
}

/**
 * Ticks covering [lo, hi] and zero, in about `count` round steps.
 * Returns the ticks (lowest first), the step between them and the range they span.
 */
export function niceTicks(lo, hi, count = 5) {
  let min = Math.min(Number(lo) || 0, 0);
  let max = Math.max(Number(hi) || 0, 0);
  if (max - min < 1e-9) max = min + 1;
  const step = niceStep((max - min) / count);
  // The small allowance keeps a value that is already a whole step (600 / 200) from
  // growing an extra, empty step through floating-point noise.
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const ticks = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { ticks, step, min: ticks[0], max: ticks[ticks.length - 1] };
}

/** How many decimals a tick label needs so that neighbouring ticks never read the same. */
export const stepDecimals = (step) => (step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)));
