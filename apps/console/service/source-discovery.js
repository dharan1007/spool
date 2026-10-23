// Read-only source discovery for the Console wizard.
//
// This adapter exists because the engine's `inspect()` requires a complete
// migration request (including a destination). The wizard must inspect a CSV
// before a destination is chosen. It therefore reuses the engine's own streaming
// CSV parser and schema inference — never a second parser with different
// semantics — and performs no writes, no snapshots and no target access.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { consoleFail } from './errors.js';

const SAMPLE_ROWS = 500;
const PREVIEW_ROW_LIMIT = 200;
const AMBIGUOUS_DATE = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;
const LOCALE_NUMBER = /^[+-]?\d{1,3}(?:[.,\u00a0]\d{3})+(?:[.,]\d+)?$|^[+-]?\d+,\d+$|^[+-]?\d+\.\d{3}$/;

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export function createSourceDiscovery({ engine, maxSourceBytes = engine.PRODUCTION_POLICY.maxSourceBytes } = {}) {
  async function resolve(path, sourceRoot) {
    const policy = await engine.createPathPolicy(sourceRoot ?? dirname(path));
    return policy.resolve(path, { mustExist: true });
  }

  async function inspect({ path, sourceRoot = null }) {
    const resolved = await resolve(path, sourceRoot);
    const info = await stat(resolved);
    if (!info.isFile()) consoleFail('CONSOLE_VALIDATION_FAILED', 'Source must be a regular file', { path: resolved });
    if (info.size > maxSourceBytes) {
      consoleFail('SOURCE_TOO_LARGE', `Source exceeds the qualified ${maxSourceBytes} byte ceiling`, {
        sizeBytes: info.size,
        maxSourceBytes
      });
    }
    if (info.size === 0) consoleFail('CONSOLE_VALIDATION_FAILED', 'Source file is empty', { path: resolved });

    let inspected;
    try {
      inspected = await engine.inspectCsvStream(resolved, {
        sampleSize: SAMPLE_ROWS,
        maxInputBytes: maxSourceBytes
      });
    } catch (error) {
      if (error?.code) throw error;
      consoleFail('CONSOLE_VALIDATION_FAILED', 'Source could not be parsed as UTF-8 CSV', { path: resolved });
    }
    if (inspected.rowCount === 0) consoleFail('CONSOLE_VALIDATION_FAILED', 'CSV source contains no data rows');

    const fields = engine.inferSchema(inspected.sampleRows, { sampleSize: Math.min(SAMPLE_ROWS, inspected.sampleRows.length) });
    const columns = fields.map(field => profileColumn(field, inspected.sampleRows));
    const fingerprint = await sha256File(resolved);

    return {
      path: resolved,
      name: basename(resolved),
      sizeBytes: info.size,
      rowCount: inspected.rowCount,
      rowCountBasis: 'exact',
      headers: [...inspected.headers],
      columns,
      sampleRows: inspected.sampleRows.length,
      sampleBasis: 'sample',
      sampleLimit: SAMPLE_ROWS,
      sourceFingerprint: fingerprint,
      maxSourceBytes,
      warnings: columns.flatMap(column => column.warnings.map(warning => ({ ...warning, column: column.name }))),
      inspectedAt: new Date().toISOString()
    };
  }

  async function preview({ path, offset = 0, limit = 50 }) {
    const boundedLimit = Math.max(1, Math.min(limit, PREVIEW_ROW_LIMIT));
    const rows = [];
    let seen = 0;
    for await (const record of engine.streamCsvRows(path, { maxInputBytes: maxSourceBytes })) {
      seen = record.rowIndex + 1;
      if (record.rowIndex < offset) continue;
      rows.push({ rowIndex: record.rowIndex, values: record.row });
      if (rows.length >= boundedLimit) break;
    }
    return {
      offset,
      limit: boundedLimit,
      rows,
      reachedEnd: rows.length < boundedLimit,
      scannedRows: seen
    };
  }

  async function assertUnchanged(profile) {
    const current = await sha256File(profile.path);
    if (current !== profile.sourceFingerprint) {
      consoleFail('SOURCE_UNCHANGED_CHECK_FAILED', 'Source content changed since it was inspected', {
        expected: profile.sourceFingerprint,
        actual: current
      });
    }
    return true;
  }

  return Object.freeze({ inspect, preview, assertUnchanged, sha256File, maxSourceBytes });
}

function profileColumn(field, sampleRows) {
  const values = sampleRows.map(row => row[field.name]);
  const blank = values.filter(value => value === null || value === undefined || String(value).trim() === '').length;
  const distinct = new Set(values.map(value => String(value ?? ''))).size;
  const nonEmpty = values.filter(value => String(value ?? '').trim() !== '');
  const warnings = [];
  if (nonEmpty.some(value => LOCALE_NUMBER.test(String(value).trim()))) {
    warnings.push({
      code: 'LOCALE_NUMBER_AMBIGUOUS',
      message: 'Some values look like numbers written with thousands separators or decimal commas. Parsing is deterministic but locale assumptions must be reviewed.'
    });
  }
  if (nonEmpty.some(value => AMBIGUOUS_DATE.test(String(value).trim()))) {
    warnings.push({
      code: 'AMBIGUOUS_DATE',
      message: 'Some values look like day/month/year dates that could be read in either order. Ambiguous dates are rejected rather than guessed.'
    });
  }
  return {
    name: field.name,
    inferredType: field.type,
    nullable: blank > 0,
    sampleNulls: blank,
    sampleDistinct: distinct,
    samples: [...new Set(nonEmpty.map(String))].slice(0, 3),
    warnings,
    basis: 'sample'
  };
}

export { PREVIEW_ROW_LIMIT, SAMPLE_ROWS };
