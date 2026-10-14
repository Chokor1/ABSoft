/**
 * Barcodes, drawn in the browser.
 *
 * A label printer takes an image, not a number, so the code has to be turned
 * into bars here. Two symbologies cover a shop: EAN-13 for the codes printed on
 * goods, and Code 128 for anything else — a shop's own codes, letters included.
 *
 * Everything below produces a string of '1' (bar) and '0' (space) modules, and
 * `barcodeSvg` draws that string at whatever size the label needs.
 */

/* ------------------------------------------------------------------ EAN-13 */

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// Which of the first six digits are encoded oddly (L) or evenly (G) is itself
// the thirteenth digit — that is how EAN-13 fits 13 digits into 12 positions.
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** The last digit of an EAN-13, worked out from the first twelve. */
export function eanCheckDigit(twelve) {
  const digits = String(twelve).slice(0, 12).split('').map(Number);
  if (digits.length !== 12 || digits.some(Number.isNaN)) return null;
  const sum = digits.reduce((total, d, i) => total + d * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/** True when this is 13 digits and the last one checks out. */
export const isEan13 = (code) => /^\d{13}$/.test(code) && eanCheckDigit(code) === Number(code[12]);

function ean13Modules(code) {
  const digits = code.split('').map(Number);
  const parity = EAN_PARITY[digits[0]];
  let out = '101'; // start guard
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[digits[i]];
  out += '01010'; // centre guard
  for (let i = 7; i <= 12; i++) out += EAN_R[digits[i]];
  return `${out}101`; // end guard
}

/* --------------------------------------------------------------- Code 128 */

// Bar/space widths for each of the 107 symbols, the last being the stop pattern.
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const STOP = 106;

/** Widths like "212222" become modules: bar, space, bar, space… */
const widthsToModules = (widths) =>
  widths
    .split('')
    .map((w, i) => (i % 2 ? '0' : '1').repeat(Number(w)))
    .join('');

/**
 * Code 128 for any printable ASCII. Runs of four or more digits switch to
 * subset C, which packs two digits into one symbol and keeps the code short.
 */
function code128Modules(text) {
  const value = String(text);
  const codes = [];
  let i = 0;
  const digitsAhead = (from) => {
    let n = 0;
    while (from + n < value.length && value[from + n] >= '0' && value[from + n] <= '9') n++;
    return n;
  };
  // An even run of digits at the start, or six anywhere, is worth subset C.
  let inC = digitsAhead(0) >= (value.length === digitsAhead(0) ? 4 : 6) && digitsAhead(0) % 2 === 0;
  codes.push(inC ? START_C : START_B);
  while (i < value.length) {
    if (inC) {
      const ahead = digitsAhead(i);
      if (ahead >= 2) {
        codes.push(Number(value.slice(i, i + 2)));
        i += 2;
        continue;
      }
      codes.push(CODE_B);
      inC = false;
      continue;
    }
    const ahead = digitsAhead(i);
    if (ahead >= 6 && ahead % 2 === 0) {
      codes.push(START_C - 1); // Code C
      inC = true;
      continue;
    }
    const ch = value.charCodeAt(i);
    // Subset B covers space (32) to DEL (127); anything else prints as a space.
    codes.push(ch >= 32 && ch <= 127 ? ch - 32 : 0);
    i++;
  }
  // The check symbol: the start value plus each symbol times its position.
  const check = codes.reduce((sum, code, index) => sum + code * (index === 0 ? 1 : index), 0) % 103;
  codes.push(check, STOP);
  return codes.map((code) => widthsToModules(C128[code])).join('');
}

/* ------------------------------------------------------------------ drawing */

/** The modules for a code, and which symbology drew them. */
export function barcodeModules(code) {
  const value = String(code || '').trim();
  if (!value) return null;
  if (isEan13(value)) return { kind: 'ean13', modules: ean13Modules(value), text: value };
  // Twelve digits are an EAN-13 waiting for its check digit.
  if (/^\d{12}$/.test(value)) {
    const full = value + eanCheckDigit(value);
    return { kind: 'ean13', modules: ean13Modules(full), text: full };
  }
  return { kind: 'code128', modules: code128Modules(value), text: value };
}

/**
 * A barcode as an SVG, sized in millimetres so a label printer puts it on paper
 * at the size asked for. Returns '' for a code that cannot be drawn.
 *
 *   barcodeSvg('5901234123457', { width: 34, height: 9 })
 */
export function barcodeSvg(code, { width = 34, height = 9, quiet = true } = {}) {
  const drawn = barcodeModules(code);
  if (!drawn) return '';
  const quietModules = quiet ? (drawn.kind === 'ean13' ? 9 : 10) : 0;
  const total = drawn.modules.length + quietModules * 2;
  const bars = [];
  let run = 0;
  for (let i = 0; i <= drawn.modules.length; i++) {
    if (drawn.modules[i] === '1') {
      run++;
      continue;
    }
    if (run) bars.push(`<rect x="${quietModules + i - run}" y="0" width="${run}" height="100" />`);
    run = 0;
  }
  return `<svg class="bc" viewBox="0 0 ${total} 100" preserveAspectRatio="none"
    width="${width}mm" height="${height}mm" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="0" y="0" width="${total}" height="100" fill="#fff"/>
    <g fill="#000">${bars.join('')}</g>
  </svg>`;
}

/** How a code reads under the bars: EAN-13 in its usual 1 · 6 · 6 grouping. */
export const barcodeText = (code) => {
  const drawn = barcodeModules(code);
  if (!drawn) return '';
  return drawn.kind === 'ean13'
    ? `${drawn.text[0]} ${drawn.text.slice(1, 7)} ${drawn.text.slice(7)}`
    : drawn.text;
};
