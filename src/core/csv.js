import { fail } from './errors.js';

export function parseCsv(text, options = {}) {
  const {
    maxCellLength = 1024 * 1024,
    maxRows = 1_000_000,
    maxColumns = 1000
  } = options;
  if (typeof text !== 'string') fail('INVALID_CSV', 'CSV input must be a string');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
    row.push(cell);
    cell = '';
    if (row.length > maxColumns) fail('TOO_MANY_COLUMNS', `CSV exceeds ${maxColumns} columns`);
  };
  const pushRow = () => {
    pushCell();
    // Ignore one terminal blank row from a trailing newline.
    rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) fail('TOO_MANY_ROWS', `CSV exceeds ${maxRows} data rows`);
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += ch;
      if (cell.length > maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
      i += 1;
      continue;
    }
    if (ch === '"' && cell.length === 0) { quoted = true; i += 1; continue; }
    if (ch === ',') { pushCell(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow(); i += 1; continue;
    }
    cell += ch;
    if (cell.length > maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
    i += 1;
  }
  if (quoted) fail('UNCLOSED_QUOTE', 'CSV ended inside a quoted cell');
  if (cell.length || row.length) pushRow();
  if (rows.length === 0) return { headers: [], rows: [] };
  if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();

  const headers = rows.shift().map((h, index) => {
    const name = h.trim();
    if (!name) fail('EMPTY_HEADER', `Header ${index + 1} is empty`);
    if (['__proto__', 'prototype', 'constructor'].includes(name)) fail('UNSAFE_HEADER', `Header ${name} is not allowed`);
    return name;
  });
  if (new Set(headers).size !== headers.length) fail('DUPLICATE_HEADER', 'CSV headers must be unique');

  const objects = rows.map((cells, rowIndex) => {
    if (cells.length !== headers.length) {
      fail('COLUMN_COUNT_MISMATCH', `Row ${rowIndex + 2} has ${cells.length} columns; expected ${headers.length}`);
    }
    const out = Object.create(null);
    headers.forEach((header, index) => { out[header] = cells[index]; });
    return out;
  });
  return { headers, rows: objects };
}

export function escapeCsvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(rows, headers = rows.length ? Object.keys(rows[0]) : []) {
  const safeHeaders = headers.filter(h => !['__proto__', 'prototype', 'constructor'].includes(h));
  const lines = [safeHeaders.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(safeHeaders.map(h => escapeCsvCell(row?.[h])).join(','));
  return lines.join('\r\n');
}
