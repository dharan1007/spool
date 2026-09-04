import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { parseCsv, toCsv } from '../core/csv.js';
import { fail } from '../core/errors.js';

export const FILE_FORMATS = Object.freeze(['csv', 'json', 'jsonl']);

export function formatFromResource(resource) {
  const match = /\.([^.\/]+)$/.exec(resource ?? '');
  const format = match?.[1]?.toLowerCase();
  if (!FILE_FORMATS.includes(format)) fail('UNSUPPORTED_FILE_FORMAT', `Unsupported file format for ${resource}`);
  return format;
}

function assertObjectRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_JSON_ROWS', `Row ${index + 1} must be an object`);
  return row;
}

export async function readAllRows(filePath, format) {
  if (format === 'csv') return parseCsv(await readFile(filePath, 'utf8')).rows;
  if (format === 'json') {
    let parsed;
    try { parsed = JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) { fail('INVALID_JSON', `Invalid JSON: ${error.message}`); }
    if (!Array.isArray(parsed)) fail('INVALID_JSON_ROWS', 'JSON source must contain a top-level array');
    return parsed.map(assertObjectRow);
  }
  if (format === 'jsonl') {
    const rows = [];
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let index = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch (error) { fail('INVALID_JSONL', `Invalid JSONL row ${index + 1}: ${error.message}`); }
      rows.push(assertObjectRow(row, index));
      index += 1;
    }
    return rows;
  }
  fail('UNSUPPORTED_FILE_FORMAT', `Unsupported file format ${format}`);
}

export async function *readRowBatches(filePath, format, batchSize = 500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_BATCH_SIZE', 'batchSize must be between 1 and 10000');
  if (format === 'jsonl') {
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let rows = [];
    let offset = 0;
    let bytesRead = 0;
    for await (const line of lines) {
      bytesRead += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch (error) { fail('INVALID_JSONL', `Invalid JSONL row ${offset + rows.length + 1}: ${error.message}`); }
      rows.push(assertObjectRow(row, offset + rows.length));
      if (rows.length >= batchSize) {
        offset += rows.length;
        yield { rows, cursor: { offset }, bytesRead };
        rows = [];
      }
    }
    if (rows.length) {
      offset += rows.length;
      yield { rows, cursor: { offset }, bytesRead };
    }
    return;
  }

  const rows = await readAllRows(filePath, format);
  const bytesRead = (await readFile(filePath)).byteLength;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    yield { rows: batch, cursor: { offset: start + batch.length }, bytesRead };
  }
}

export function serializeRows(rows, format) {
  rows.forEach(assertObjectRow);
  if (format === 'jsonl') return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  if (format === 'json') return JSON.stringify(rows);
  if (format === 'csv') return toCsv(rows);
  fail('UNSUPPORTED_FILE_FORMAT', `Unsupported file format ${format}`);
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
