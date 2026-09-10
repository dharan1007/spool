import { createReadStream } from 'node:fs';
import { fail } from '../../core/errors.js';

const UNSAFE_HEADERS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

function validateOptions(options) {
  const maxCellLength = options.maxCellLength ?? 1024 * 1024;
  const maxRows = options.maxRows ?? 1_000_000;
  const maxColumns = options.maxColumns ?? 1000;
  const maxInputBytes = options.maxInputBytes ?? Number.MAX_SAFE_INTEGER;
  const highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  for (const [name, value] of Object.entries({ maxCellLength, maxRows, maxColumns, maxInputBytes, highWaterMark })) {
    if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_CSV_LIMIT', `${name} must be a positive safe integer`);
  }
  return { maxCellLength, maxRows, maxColumns, maxInputBytes, highWaterMark };
}

function normalizeHeaders(cells) {
  const headers = cells.map((header, index) => {
    const name = header.trim();
    if (!name) fail('EMPTY_HEADER', `Header ${index + 1} is empty`);
    if (UNSAFE_HEADERS.has(name)) fail('UNSAFE_HEADER', `Header ${name} is not allowed`);
    return name;
  });
  if (new Set(headers).size !== headers.length) fail('DUPLICATE_HEADER', 'CSV headers must be unique');
  return headers;
}

function toObject(headers, cells, rowIndex) {
  if (cells.length !== headers.length) {
    fail('COLUMN_COUNT_MISMATCH', `Row ${rowIndex + 2} has ${cells.length} columns; expected ${headers.length}`);
  }
  const out = Object.create(null);
  for (let i = 0; i < headers.length; i += 1) out[headers[i]] = cells[i];
  return out;
}

async function* iterateCsv(path, options = {}) {
  const limits = validateOptions(options);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = createReadStream(path, { highWaterMark: limits.highWaterMark });
  let bytes = 0;
  let headers = null;
  let rowIndex = 0;
  let row = [];
  let cell = '';
  let quoted = false;
  let quotePending = false;
  let skipLfAfterCr = false;
  let pendingBlank = false;

  const pushCell = () => {
    if (cell.length > limits.maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${limits.maxCellLength} characters`);
    row.push(cell);
    cell = '';
    if (row.length > limits.maxColumns) fail('TOO_MANY_COLUMNS', `CSV exceeds ${limits.maxColumns} columns`);
  };

  const takeRow = () => {
    pushCell();
    const cells = row;
    row = [];
    return cells;
  };

  const dataRecord = cells => {
    if (rowIndex >= limits.maxRows) fail('TOO_MANY_ROWS', `CSV exceeds ${limits.maxRows} data rows`);
    const record = { type: 'row', rowIndex, row: toObject(headers, cells, rowIndex) };
    rowIndex += 1;
    return record;
  };

  const finalizeRow = cells => {
    const records = [];
    if (headers === null) {
      headers = normalizeHeaders(cells);
      records.push({ type: 'headers', headers: [...headers] });
      return records;
    }
    const isBlank = cells.length === 1 && cells[0] === '';
    if (pendingBlank) {
      records.push(dataRecord(['']));
      pendingBlank = false;
    }
    if (isBlank) {
      pendingBlank = true;
      return records;
    }
    records.push(dataRecord(cells));
    return records;
  };

  const processText = function* (text) {
    for (let i = 0; i < text.length; i += 1) {
      let ch = text[i];
      if (skipLfAfterCr) {
        skipLfAfterCr = false;
        if (ch === '\n') continue;
      }

      if (quoted) {
        if (quotePending) {
          if (ch === '"') {
            cell += '"';
            quotePending = false;
            if (cell.length > limits.maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${limits.maxCellLength} characters`);
            continue;
          }
          quoted = false;
          quotePending = false;
          // The current character belongs to the unquoted state after the closing quote.
        } else if (ch === '"') {
          quotePending = true;
          continue;
        } else {
          cell += ch;
          if (cell.length > limits.maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${limits.maxCellLength} characters`);
          continue;
        }
      }

      if (ch === '"' && cell.length === 0) {
        quoted = true;
        continue;
      }
      if (ch === ',') {
        pushCell();
        continue;
      }
      if (ch === '\n') {
        for (const record of finalizeRow(takeRow())) yield record;
        continue;
      }
      if (ch === '\r') {
        for (const record of finalizeRow(takeRow())) yield record;
        skipLfAfterCr = true;
        continue;
      }
      cell += ch;
      if (cell.length > limits.maxCellLength) fail('CELL_TOO_LARGE', `Cell exceeds ${limits.maxCellLength} characters`);
    }
  };

  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limits.maxInputBytes) fail('SOURCE_TOO_LARGE', `CSV exceeds ${limits.maxInputBytes} byte input limit`, { bytes, limit: limits.maxInputBytes });
      let text;
      try { text = decoder.decode(chunk, { stream: true }); }
      catch { fail('INVALID_SOURCE_ENCODING', 'Gate B CSV source must be valid UTF-8'); }
      for (const record of processText(text)) yield record;
    }
    let tail;
    try { tail = decoder.decode(); }
    catch { fail('INVALID_SOURCE_ENCODING', 'Gate B CSV source must be valid UTF-8'); }
    if (tail) for (const record of processText(tail)) yield record;

    if (quoted && !quotePending) fail('UNCLOSED_QUOTE', 'CSV ended inside a quoted cell');
    if (quotePending) {
      quoted = false;
      quotePending = false;
    }
    if (cell.length || row.length) {
      for (const record of finalizeRow(takeRow())) yield record;
    }
    // Match parseCsv: a final blank record is ignored.
    pendingBlank = false;
  } finally {
    stream.destroy();
  }
}

export async function* streamCsvRows(path, options = {}) {
  for await (const record of iterateCsv(path, options)) {
    if (record.type === 'row') yield Object.freeze({ rowIndex: record.rowIndex, row: record.row });
  }
}

export async function inspectCsvStream(path, options = {}) {
  const sampleSize = options.sampleSize ?? 1000;
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 0) fail('INVALID_CSV_LIMIT', 'sampleSize must be a non-negative safe integer');
  let headers = [];
  let rowCount = 0;
  const sampleRows = [];
  for await (const record of iterateCsv(path, options)) {
    if (record.type === 'headers') headers = record.headers;
    else {
      rowCount += 1;
      if (sampleRows.length < sampleSize) sampleRows.push(record.row);
    }
  }
  return Object.freeze({ headers: Object.freeze([...headers]), rowCount, sampleRows: Object.freeze(sampleRows) });
}
