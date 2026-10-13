import { fail } from './errors.js';
import { yieldBrowserTurn } from '../runtime/cooperative-yield.js';

export const DEFAULT_BROWSER_CSV_LIMIT_BYTES = 50 * 1024 * 1024;
const UNSAFE_HEADERS = new Set(['__proto__', 'prototype', 'constructor']);

function* parseCsvSteps(text, options = {}) {
  const {
    maxCellLength = 1024 * 1024,
    maxRows = 1_000_000,
    maxColumns = 1000,
    maxInputBytes = DEFAULT_BROWSER_CSV_LIMIT_BYTES
  } = options;
  if (typeof text !== 'string') fail('INVALID_CSV', 'CSV input must be a string');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) fail('INVALID_CSV_LIMIT', 'maxInputBytes must be a positive safe integer');
  const inputBytes = new Blob([text]).size;
  if (inputBytes > maxInputBytes) fail('SOURCE_TOO_LARGE', `CSV exceeds ${maxInputBytes} byte input limit`, { bytes: inputBytes, limit: maxInputBytes });

  const rows = [];
  let row = [];
  let pieces = [];
  let cellLength = 0;
  let quoted = false;
  let i = 0;
  let segmentStart = 0;
  let nextYield = 65536;

  // Retain source slices rather than creating one short-lived array element
  // for every input character. At 50 MiB, that avoids tens of millions of
  // temporary string/array entries and their main-thread GC pressure.
  const flushSegment = end => {
    if (end <= segmentStart) return;
    cellLength += end - segmentStart;
    if (cellLength > maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
    pieces.push(text.slice(segmentStart, end));
  };
  const pushCell = end => {
    flushSegment(end);
    row.push(pieces.join(''));
    pieces = [];
    cellLength = 0;
    if (row.length > maxColumns) fail('TOO_MANY_COLUMNS', `CSV exceeds ${maxColumns} columns`);
  };
  const pushRow = end => {
    pushCell(end);
    rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) fail('TOO_MANY_ROWS', `CSV exceeds ${maxRows} data rows`);
  };

  while (i < text.length) {
    if (i >= nextYield) { yield; nextYield = i + 65536; }
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          flushSegment(i);
          cellLength += 1;
          if (cellLength > maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
          pieces.push('"');
          i += 2;
          segmentStart = i;
          continue;
        }
        flushSegment(i);
        quoted = false;
        i += 1;
        segmentStart = i;
        continue;
      }
      if (cellLength + i - segmentStart + 1 > maxCellLength) {
        fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
      }
      i += 1;
      continue;
    }

    // Preserve the existing permissive CSV semantics: a quote only opens a
    // quoted cell when the accumulated cell is empty. Quotes elsewhere are
    // ordinary characters; characters after a closing quote are retained.
    if (ch === '"' && cellLength === 0 && i === segmentStart) {
      quoted = true;
      i += 1;
      segmentStart = i;
      continue;
    }
    if (ch === ',') { pushCell(i); i += 1; segmentStart = i; continue; }
    if (ch === '\n') { pushRow(i); i += 1; segmentStart = i; continue; }
    if (ch === '\r') {
      pushRow(i);
      i += text[i + 1] === '\n' ? 2 : 1;
      segmentStart = i;
      continue;
    }
    if (cellLength + i - segmentStart + 1 > maxCellLength) {
      fail('CELL_TOO_LARGE', `Cell exceeds ${maxCellLength} characters`);
    }
    i += 1;
  }
  if (quoted) fail('UNCLOSED_QUOTE', 'CSV ended inside a quoted cell');
  if (cellLength || i > segmentStart || row.length) pushRow(i);
  if (rows.length === 0) return { headers: [], rows: [] };
  if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();

  const headers = rows.shift().map((h, index) => {
    const name = h.trim();
    if (!name) fail('EMPTY_HEADER', `Header ${index + 1} is empty`);
    if (UNSAFE_HEADERS.has(name)) fail('UNSAFE_HEADER', `Header ${name} is not allowed`);
    return name;
  });
  if (new Set(headers).size !== headers.length) fail('DUPLICATE_HEADER', 'CSV headers must be unique');

  const objects = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (rowIndex && rowIndex % 500 === 0) yield;
    const cells = rows[rowIndex];
    if (cells.length !== headers.length) {
      fail('COLUMN_COUNT_MISMATCH', `Row ${rowIndex + 2} has ${cells.length} columns; expected ${headers.length}`);
    }
    const out = Object.create(null);
    headers.forEach((header, index) => { out[header] = cells[index]; });
    objects.push(out);
  }
  return { headers, rows: objects };
}
export function parseCsv(text, options = {}) {
  const steps = parseCsvSteps(text, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export async function parseCsvAsync(text, options = {}) {
  const steps = parseCsvSteps(text, options);
  let step = steps.next();
  while (!step.done) {
    await yieldBrowserTurn();
    step = steps.next();
  }
  return step.value;
}

const PLAIN_SIGNED_NUMBER = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function needsFormulaNeutralization(text) {
  const trimmed = text.trim();
  if (!trimmed || !/^[=+\-@]/.test(trimmed)) return false;
  if (PLAIN_SIGNED_NUMBER.test(trimmed)) return false;
  return true;
}

export function escapeCsvCell(value) {
  let text = value == null ? '' : String(value);
  if (needsFormulaNeutralization(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(rows, headers = rows.length ? Object.keys(rows[0]) : []) {
  if (!Array.isArray(headers)) fail('INVALID_CSV_HEADERS', 'CSV headers must be an array');
  for (const header of headers) {
    if (typeof header !== 'string' || !header) fail('INVALID_CSV_HEADERS', 'CSV headers must be non-empty strings');
    if (UNSAFE_HEADERS.has(header)) fail('UNSAFE_HEADER', `Header ${header} is not allowed`);
  }
  if (new Set(headers).size !== headers.length) fail('DUPLICATE_HEADER', 'CSV headers must be unique');
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(headers.map(h => escapeCsvCell(row?.[h])).join(','));
  return lines.join('\r\n');
}
