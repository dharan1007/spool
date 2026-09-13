import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';

const KEY_DOMAIN = 'spool-content-key-v1';
const ROW_DOMAIN = 'spool-content-row-v1';
const ROOT_DOMAIN = 'spool-content-projection-root-v1';
const VERIFICATION_DOMAIN = 'spool-content-verification-v1';
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireRows(name, rows) {
  if (!Array.isArray(rows)) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${name} must be an array`);
  return rows;
}

function requireFields(name, fields) {
  if (!Array.isArray(fields) || fields.length === 0) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${name} must be a non-empty array`);
  const seen = new Set();
  return fields.map(field => {
    if (typeof field !== 'string' || !FIELD.test(field)) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${name} contains an invalid field`);
    if (seen.has(field)) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${name} contains duplicate field ${field}`);
    seen.add(field);
    return field;
  });
}

function requireRow(row, side, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${side} row ${index} must be an object`);
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_CONTENT_VERIFICATION_INPUT', `${side} row ${index} must be a plain object`);
  return row;
}

function project(row, fields, side, index) {
  const out = {};
  for (const field of fields) {
    if (!Object.hasOwn(row, field)) fail('CONTENT_PROJECTION_FIELD_MISSING', `${side} row ${index} is missing projected field ${field}`, { side, index, field });
    out[field] = row[field];
  }
  canonicalJson(out);
  return out;
}

function keyRecord(row, primaryKey, side, index) {
  const key = {};
  const ordered = [];
  for (const field of primaryKey) {
    if (!Object.hasOwn(row, field)) fail('CONTENT_PRIMARY_KEY_MISSING', `${side} row ${index} is missing primary-key field ${field}`, { side, index, field });
    const value = row[field];
    if (value === null || value === undefined) fail('CONTENT_PRIMARY_KEY_NULL', `${side} row ${index} has null primary-key field ${field}`, { side, index, field });
    key[field] = value;
    ordered.push(value);
  }
  canonicalJson(key);
  canonicalJson(ordered);
  return { key, keySort: canonicalJson(ordered), keyId: sha256Canonical(KEY_DOMAIN, { primaryKey, key }) };
}

function indexRows(rows, { side, primaryKey, columns }) {
  const byKey = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = requireRow(rows[index], side, index);
    const key = keyRecord(row, primaryKey, side, index);
    if (byKey.has(key.keyId)) {
      fail(side === 'expected' ? 'DUPLICATE_EXPECTED_PRIMARY_KEY' : 'DUPLICATE_ACTUAL_PRIMARY_KEY', `${side} rows contain duplicate primary-key identity`, { key: key.key });
    }
    const projected = project(row, columns, side, index);
    const rowHash = sha256Canonical(ROW_DOMAIN, { primaryKey, columns, key: key.key, row: projected });
    byKey.set(key.keyId, Object.freeze({ ...key, row: Object.freeze(projected), rowHash }));
  }
  return byKey;
}

function projectionSummary(index, primaryKey, columns) {
  const entries = [...index.values()]
    .sort((left, right) => left.keySort.localeCompare(right.keySort))
    .map(item => ({ keyId: item.keyId, rowHash: item.rowHash }));
  return Object.freeze({
    rowCount: entries.length,
    rootHash: sha256Canonical(ROOT_DOMAIN, { primaryKey, columns, entries })
  });
}

function evidenceDiff(entries) {
  return entries.map(entry => ({
    kind: entry.kind,
    keyId: entry.keyId,
    expectedRowHash: entry.expectedRowHash ?? null,
    actualRowHash: entry.actualRowHash ?? null
  }));
}

export function verifyContentProjection(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_CONTENT_VERIFICATION_INPUT', 'Content verification input must be an object');
  const primaryKey = Object.freeze(requireFields('primaryKey', input.primaryKey));
  const columns = Object.freeze(requireFields('columns', input.columns));
  for (const field of primaryKey) {
    if (!columns.includes(field)) fail('INVALID_CONTENT_VERIFICATION_INPUT', `Primary-key field ${field} must be included in projection columns`);
  }
  const expectedRows = requireRows('expectedRows', input.expectedRows);
  const actualRows = requireRows('actualRows', input.actualRows);
  const expectedIndex = indexRows(expectedRows, { side: 'expected', primaryKey, columns });
  const actualIndex = indexRows(actualRows, { side: 'actual', primaryKey, columns });
  const expected = projectionSummary(expectedIndex, primaryKey, columns);
  const actual = projectionSummary(actualIndex, primaryKey, columns);

  const allKeyIds = new Set([...expectedIndex.keys(), ...actualIndex.keys()]);
  const entries = [];
  for (const keyId of allKeyIds) {
    const expectedEntry = expectedIndex.get(keyId) ?? null;
    const actualEntry = actualIndex.get(keyId) ?? null;
    if (expectedEntry && actualEntry && expectedEntry.rowHash === actualEntry.rowHash) continue;
    const reference = expectedEntry ?? actualEntry;
    let kind;
    if (!actualEntry) kind = 'MISSING';
    else if (!expectedEntry) kind = 'UNEXPECTED';
    else kind = 'MISMATCH';
    entries.push(Object.freeze({
      kind,
      keyId,
      keySort: reference.keySort,
      key: Object.freeze({ ...reference.key }),
      expectedRowHash: expectedEntry?.rowHash ?? null,
      actualRowHash: actualEntry?.rowHash ?? null,
      expectedRow: expectedEntry?.row ?? null,
      actualRow: actualEntry?.row ?? null
    }));
  }
  entries.sort((left, right) => left.keySort.localeCompare(right.keySort));
  const counts = {
    missing: entries.filter(entry => entry.kind === 'MISSING').length,
    mismatch: entries.filter(entry => entry.kind === 'MISMATCH').length,
    unexpected: entries.filter(entry => entry.kind === 'UNEXPECTED').length
  };
  const status = entries.length === 0 ? 'VERIFIED' : 'DIFF';
  const verificationRecord = {
    schemaVersion: 1,
    level: 'CONTENT_EXACT',
    status,
    primaryKey,
    columns,
    expected,
    actual,
    diff: { counts, total: entries.length, entries: evidenceDiff(entries) }
  };
  const verificationId = sha256Canonical(VERIFICATION_DOMAIN, verificationRecord);
  return Object.freeze({
    ...verificationRecord,
    verificationId,
    diff: Object.freeze({ counts: Object.freeze(counts), total: entries.length, entries: Object.freeze(entries) })
  });
}
