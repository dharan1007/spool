import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Canonical } from '../../platform/canonical-json.js';
import { fail } from '../../core/errors.js';

const MAX_EXPECTED_ROWS = 10000;
const MAX_TABLE_ROWS = 1000000;

function requireName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value.includes('\0')) {
    fail('SQLITE_SOURCE_INVALID_IDENTIFIER', label + ' must be a non-empty SQLite identifier without NUL (maximum 255 characters)');
  }
  return value;
}
function quoted(value) { return '"' + requireName(value, 'identifier').replaceAll('"', '""') + '"'; }
function safeValue(value) {
  if (value === null) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'integer', v: value ? '1' : '0' };
  if (typeof value === 'bigint') return { t: 'integer', v: String(value) };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SQLITE_READBACK_UNSUPPORTED_VALUE', 'Values must be finite numbers');
    if (Number.isSafeInteger(value)) return { t: 'integer', v: String(value) };
    return { t: 'real', v: String(value) };
  }
  if (typeof value === 'string') return { t: 'text', v: value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { t: 'blob', v: Buffer.from(value).toString('base64') };
  fail('SQLITE_READBACK_UNSUPPORTED_VALUE', 'Unsupported SQLite source or expected value type');
}
function typedRow(row, fields) {
  return fields.map(field => safeValue(row[field]));
}
function assertRow(row, fields) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('SQLITE_READBACK_INVALID_ROW', 'Expected row must be an object');
  const keys = Object.keys(row);
  if (keys.length !== fields.length || keys.some(k => !fields.includes(k))) fail('SQLITE_READBACK_ROW_SHAPE', 'Expected row must contain exactly the visible target table columns');
}
function rowsHash(rows, fields) {
  const hash = createHash('sha256').update('SPOOL\0sqlite-value-rows-v1\0', 'utf8');
  for (const row of rows) {
    const encoded = Buffer.from(canonicalJson(typedRow(row, fields)), 'utf8');
    hash.update(String(encoded.length) + ':', 'ascii').update(encoded);
  }
  return 'sha256:' + hash.digest('hex');
}
function recognizedUniqueKey(db, table, keys, fields) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 8 || new Set(keys).size !== keys.length) {
    fail('SQLITE_READBACK_KEY_INVALID', 'Require one to eight distinct, explicitly declared identity columns');
  }
  keys.forEach(k => { requireName(k, 'key column'); if (!fields.includes(k)) fail('SQLITE_READBACK_KEY_INVALID', 'Unknown identity column'); });
  const wanted = [...keys].sort().join('\0');
  const info = db.pragma('table_info(' + quoted(table) + ')');
  const primary = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (primary.length && primary.length === keys.length && [...primary].sort().join('\0') === wanted) return 'PRIMARY_KEY';
  for (const index of db.pragma('index_list(' + quoted(table) + ')')) {
    if (!index.unique || index.partial) continue;
    const parts = db.pragma('index_xinfo(' + quoted(index.name) + ')')
      .filter(c => c.key === 1);
    if (parts.some(c => c.name == null || c.cid < 0)) continue;
    const cols = parts.map(c => c.name);
    if (cols.length === keys.length && [...cols].sort().join('\0') === wanted) return 'UNIQUE_INDEX';
  }
  fail('SQLITE_READBACK_KEY_NOT_UNIQUE', 'Readback identity must match a declared nonpartial unique key or primary key');
}
function tableContract(db, table) {
  requireName(table, 'table');
  if (table.startsWith('sqlite_') || table.startsWith('__spool_') || table.startsWith('spool_')) {
    fail('SQLITE_SOURCE_SYSTEM_TABLE', 'Internal SQLite and SPOOL metadata tables are not admissible data sources');
  }
  const schema = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ? AND type = 'table'").get(table);
  if (!schema || typeof schema.sql !== 'string' || /\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(schema.sql)) {
    fail('SQLITE_SOURCE_NOT_BASE_TABLE', 'Source must be an ordinary existing SQLite base table, not a virtual table/view');
  }
  const fields = db.pragma('table_xinfo(' + quoted(table) + ')');
  if (!fields.length || fields.some(c => c.hidden !== 0)) {
    fail('SQLITE_SOURCE_UNSUPPORTED_SCHEMA', 'Generated or hidden SQLite columns are outside this readback contract');
  }
  return {
    fields: fields.map(c => c.name),
    schemaDigest: sha256Canonical('sqlite-read-source-contract-v1', {
      table, sql: schema.sql,
      fields: fields.map(c => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))
    })
  };
}

/**
 * Real transactional SQLite reader.
 * A single BEGIN snapshot stays open across reads from multiple tables.
 * This is READ-ONLY and never becomes production mutation authorization.
 */
export class SqliteSnapshotReader {
  constructor({ path, busyTimeoutMs = 5000, maxRows = MAX_TABLE_ROWS } = {}) {
    if (typeof path !== 'string' || !path) fail('SQLITE_SOURCE_PATH_REQUIRED', 'An explicit existing SQLite database file is required');
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) fail('SQLITE_SOURCE_TIMEOUT_INVALID', 'Timeout must be 0..60000 ms');
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_TABLE_ROWS) fail('SQLITE_SOURCE_LIMIT_INVALID', 'Read ceiling must be 1..1000000 rows');
    this.path = resolve(path);
    this.maxRows = maxRows;
    this.db = new Database(this.path, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
    this.closed = false;
    try {
      this.db.pragma('query_only = ON');
      this.db.exec('BEGIN DEFERRED;');
      // Establish the SQLite read transaction snapshot before any caller reads a table.
      this.db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #open() { if (this.closed) fail('SQLITE_SOURCE_CLOSED', 'SQLite snapshot reader is already closed'); }

  table(table) {
    this.#open();
    return Object.freeze(tableContract(this.db, table));
  }

  *iterateTable(table, { columns = null } = {}) {
    this.#open();
    const contract = tableContract(this.db, table);
    const fields = columns == null ? contract.fields : columns;
    if (!Array.isArray(fields) || !fields.length || fields.length > 256 || new Set(fields).size !== fields.length) fail('SQLITE_SOURCE_COLUMN_INVALID', 'Invalid source projection');
    for (const col of fields) {
      requireName(col, 'source field');
      if (!contract.fields.includes(col)) fail('SQLITE_SOURCE_COLUMN_INVALID', 'Unknown source projection column');
    }
    const statement = this.db.prepare('SELECT ' + fields.map(quoted).join(', ') + ' FROM ' + quoted(table)).safeIntegers(true);
    let read = 0;
    for (const row of statement.iterate()) {
      read++;
      if (read > this.maxRows) fail('SQLITE_SOURCE_LIMIT_EXCEEDED', 'Declared SQLite source row ceiling exceeded: no higher production scale guarantee');
      yield row;
    }
  }

  digestTable(table) {
    this.#open();
    const info = tableContract(this.db, table);
    const digest = createHash('sha256').update('SPOOL\0sqlite-table-read-v1\0', 'utf8');
    let rowCount = 0;
    // Order is an explicit deterministic serialization of the selected records;
    // consumers must separately supply identity keys when order-independent equality is needed.
    for (const row of this.iterateTable(table)) {
      const encoded = Buffer.from(canonicalJson(typedRow(row, info.fields)));
      digest.update(String(encoded.length) + ':', 'ascii').update(encoded);
      rowCount++;
    }
    return Object.freeze({ status: 'READ_ONLY_SNAPSHOT', table, schemaDigest: info.schemaDigest,
      rowCount, orderedDigest: 'sha256:' + digest.digest('hex'), consistentAcrossReads: true,
      entireDatabaseVerified: false, sourceMutationAuthorized: false });
  }

  verifyExpectedRows({ table, keyColumns, expectedRows } = {}) {
    this.#open();
    const info = tableContract(this.db, table);
    const keyAuthority = recognizedUniqueKey(this.db, table, keyColumns, info.fields);
    if (!Array.isArray(expectedRows) || expectedRows.length > MAX_EXPECTED_ROWS) fail('SQLITE_READBACK_ROW_LIMIT', 'Readback requires a bounded array of at most 10000 expected records');
    const select = this.db.prepare('SELECT ' + info.fields.map(quoted).join(', ') +
      ' FROM ' + quoted(table) + ' WHERE ' + keyColumns.map(k => quoted(k) + ' = ?').join(' AND ') + ' LIMIT 2').safeIntegers(true);
    const seen = new Set();
    let matched = 0, mismatched = 0, missing = 0, indeterminate = 0;
    for (const expected of expectedRows) {
      assertRow(expected, info.fields);
      const keyValues = keyColumns.map(k => expected[k]);
      if (keyValues.some(v => v == null)) { indeterminate++; continue; }
      const id = canonicalJson(keyValues.map(safeValue));
      if (seen.has(id)) { indeterminate++; continue; }
      seen.add(id);
      const rows = select.all(...keyValues.map(v => typeof v === 'boolean' ? Number(v) : v));
      if (rows.length > 1) { indeterminate++; continue; }
      if (!rows.length) { missing++; continue; }
      if (canonicalJson(typedRow(expected, info.fields)) === canonicalJson(typedRow(rows[0], info.fields))) matched++;
      else mismatched++;
    }
    const status = indeterminate ? 'INDETERMINATE' : missing || mismatched ? 'MISMATCH' : expectedRows.length ? 'VERIFIED' : 'NOT_VERIFIED';
    return Object.freeze({ status, scope: 'ONLY_EXPLICIT_EXPECTED_ROWS', table, schemaDigest: info.schemaDigest,
      identityConstraint: keyAuthority, expectedCount: expectedRows.length, matched, missing, mismatched, indeterminate,
      actualTargetRowsOutsideExpectedUnknown: true, ledgerCompletenessNotProven: true,
      rawRowsIncluded: false, mutationAuthorized: false });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('ROLLBACK'); } finally { this.db.close(); }
  }
}
