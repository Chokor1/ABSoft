/**
 * Read the first sheet of an .xlsx file into the same shape as parseCsv: an
 * array of rows, each an array of cell strings. No dependencies — an .xlsx is a
 * ZIP of XML, so we unzip with DecompressionStream and read it with DOMParser,
 * both of which every supported browser has.
 *
 * Only what an import needs is handled: shared strings, inline strings and plain
 * numbers, laid out by their cell reference so blank cells keep the columns
 * lined up. Takes an ArrayBuffer (file.arrayBuffer()); returns rows of strings.
 */

// --- the ZIP container -----------------------------------------------------

/** Find every entry in the archive, by name, as { method, size, offset }. */
function readDirectory(view) {
  // The End Of Central Directory record sits at the very end, after a comment
  // of at most 65535 bytes, and starts with the signature below.
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= 0 && i >= view.byteLength - 22 - 65535; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // start of the central directory
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true); // compressed size
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true); // local header offset
    const name = dec.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen));
    entries.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The raw (still-compressed) bytes of one entry, read from its local header. */
function rawBytes(view, entry) {
  // The local header repeats the name and extra fields, with their own lengths.
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  return new Uint8Array(view.buffer, view.byteOffset + start, entry.size);
}

async function readEntry(view, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const raw = rawBytes(view, entry);
  if (entry.method === 0) return new TextDecoder().decode(raw); // stored, not compressed
  if (entry.method !== 8) throw new Error(`unsupported zip method ${entry.method}`);
  const stream = new Response(raw).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// --- the spreadsheet -------------------------------------------------------

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

/** The shared-strings table: each <si> is one string, joined across its runs. */
function sharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''),
  );
}

/** Which sheet the workbook shows first, as a path inside the archive. */
function firstSheetPath(workbookXml, relsXml, entries) {
  try {
    const firstId = parseXml(workbookXml).getElementsByTagName('sheet')[0]?.getAttribute('r:id');
    const rels = [...parseXml(relsXml).getElementsByTagName('Relationship')];
    const target = rels.find((r) => r.getAttribute('Id') === firstId)?.getAttribute('Target');
    if (target) return `xl/${target.replace(/^\/?xl\//, '').replace(/^\.\//, '')}`;
  } catch {
    /* fall through to the guess below */
  }
  const sheets = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  return sheets[0] || null;
}

/** The column number (1-based) in a cell reference like "B7" → 2. */
function columnOf(ref) {
  let n = 0;
  for (const ch of String(ref)) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break; // stop at the first digit
    n = n * 26 + (code - 64);
  }
  return n;
}

export async function parseXlsx(buffer) {
  const view = new DataView(buffer);
  const entries = readDirectory(view);
  const [shared, workbook, rels] = await Promise.all([
    readEntry(view, entries, 'xl/sharedStrings.xml'),
    readEntry(view, entries, 'xl/workbook.xml'),
    readEntry(view, entries, 'xl/_rels/workbook.xml.rels'),
  ]);
  const strings = sharedStrings(shared);
  const sheetPath = firstSheetPath(workbook, rels, entries);
  const sheetXml = sheetPath && (await readEntry(view, entries, sheetPath));
  if (!sheetXml) throw new Error('no worksheet');

  const doc = parseXml(sheetXml);
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const col = columnOf(c.getAttribute('r') || '') || cells.length + 1;
      const type = c.getAttribute('t');
      let value = '';
      if (type === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        const raw = v ? v.textContent : '';
        value = type === 's' ? strings[Number(raw)] ?? '' : raw;
      }
      cells[col - 1] = value; // by column, so gaps stay aligned
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  // Blank lines at the end of a sheet are not products.
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}
