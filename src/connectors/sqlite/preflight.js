import Database from 'better-sqlite3';
import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';

const CONTRACT_DOMAIN = 'spool-sqlite-target-contract-v1';

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_SQLITE_PREFLIGHT', `${label} must be a non-empty string`);
  return value;
}

function affinity(declaredType) {
  const type = String(declaredType ?? '').trim().toUpperCase();
  if (type.includes('INT')) return 'INTEGER';
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
  if (!type || type.includes('BLOB')) return 'BLOB';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

function compatible(fieldType, sqliteAffinity) {
  if (fieldType === 'integer') return sqliteAffinity === 'INTEGER';
  if (fieldType === 'number') return ['INTEGER', 'REAL', 'NUMERIC'].includes(sqliteAffinity);
  if (fieldType === 'boolean') return ['INTEGER', 'NUMERIC'].includes(sqliteAffinity);
  if (fieldType === 'date' || fieldType === 'string') return sqliteAffinity === 'TEXT';
  return false;
}

function targetContractRecord(db, table) {
  const tableRow = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(table);
  if (!tableRow || tableRow.type !== 'table') fail('TARGET_TABLE_NOT_FOUND', `SQLite target table ${table} does not exist as an ordinary table`);
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(tableRow.sql ?? '')) fail('UNSUPPORTED_TARGET_TABLE', 'Gate B does not support virtual SQLite tables');

  const columns = db.prepare('SELECT cid, name, type, notnull, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table)
    .map(row => ({
      cid: Number(row.cid),
      name: row.name,
      declaredType: row.type ?? '',
      affinity: affinity(row.type),
      notNull: Number(row.notnull) === 1,
      defaultSql: row.dflt_value ?? null,
      primaryKeyOrder: Number(row.pk),
      hidden: Number(row.hidden)
    }));

  const indexes = db.prepare('SELECT seq, name, "unique" AS is_unique, origin, partial FROM pragma_index_list(?) ORDER BY seq, name').all(table)
    .map(row => ({
      name: row.name,
      unique: Number(row.is_unique) === 1,
      origin: row.origin,
      partial: Number(row.partial) === 1,
      columns: db.prepare('SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno').all(row.name)
        .map(item => ({
          seqno: Number(item.seqno), cid: Number(item.cid), name: item.name ?? null,
          desc: Number(item.desc) === 1, collation: item.coll ?? null, key: Number(item.key) === 1
        }))
    }));

  const foreignKeys = db.prepare('SELECT id, seq, "table" AS ref_table, "from" AS from_col, "to" AS to_col, on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table)
    .map(row => ({
      id: Number(row.id), seq: Number(row.seq), table: row.ref_table,
      from: row.from_col, to: row.to_col, onUpdate: row.on_update, onDelete: row.on_delete, match: row.match
    }));

  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table)
    .map(row => ({ name: row.name, sql: row.sql ?? '' }));

  return { table, tableSql: tableRow.sql ?? '', columns, indexes, foreignKeys, triggers };
}

function validateDeclaredTarget(record, targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_SQLITE_PREFLIGHT', 'targetSchema must contain fields');
  if (record.triggers.length) fail('TARGET_TRIGGER_UNSUPPORTED', 'Gate B rejects SQLite targets with triggers because they introduce side effects outside the declared migration plan', { triggers: record.triggers.map(item => item.name) });

  const actual = new Map(record.columns.map(column => [column.name, column]));
  const declared = new Set();
  const problems = [];
  for (const field of targetSchema) {
    if (!field || typeof field !== 'object' || typeof field.name !== 'string' || typeof field.type !== 'string' || typeof field.nullable !== 'boolean') {
      fail('INVALID_SQLITE_PREFLIGHT', 'targetSchema contains an invalid field');
    }
    declared.add(field.name);
    const column = actual.get(field.name);
    if (!column) {
      problems.push({ field: field.name, problem: 'missing_column' });
      continue;
    }
    if (column.hidden !== 0) problems.push({ field: field.name, problem: 'generated_or_hidden_column' });
    if (!compatible(field.type, column.affinity)) problems.push({ field: field.name, problem: 'incompatible_affinity', expectedType: field.type, actualAffinity: column.affinity, declaredType: column.declaredType });
    const actualNotNull = column.notNull || column.primaryKeyOrder > 0;
    if (field.nullable && actualNotNull) problems.push({ field: field.name, problem: 'target_is_stricter_not_null' });
  }

  for (const column of record.columns) {
    if (column.hidden !== 0 || declared.has(column.name)) continue;
    const requiredWithoutDefault = column.notNull && column.defaultSql == null && column.primaryKeyOrder === 0;
    if (requiredWithoutDefault) problems.push({ field: column.name, problem: 'extra_required_column_without_default' });
  }

  if (problems.length) fail('TARGET_SCHEMA_INCOMPATIBLE', 'Live SQLite target does not satisfy the declared migration schema', { problems });
}

export function inspectSqliteTarget({ path, table, targetSchema } = {}) {
  text(path, 'path'); text(table, 'table');
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
    const record = targetContractRecord(db, table);
    validateDeclaredTarget(record, targetSchema);
    const targetContractId = sha256Canonical(CONTRACT_DOMAIN, record);
    return Object.freeze({
      status: 'READY',
      targetContractId,
      table,
      columns: Object.freeze(record.columns.map(value => Object.freeze({ ...value }))),
      indexes: Object.freeze(record.indexes.map(value => Object.freeze({ ...value, columns: Object.freeze(value.columns.map(column => Object.freeze({ ...column }))) }))),
      foreignKeys: Object.freeze(record.foreignKeys.map(value => Object.freeze({ ...value })))
    });
  } catch (error) {
    if (error?.code) throw error;
    fail('TARGET_PREFLIGHT_FAILED', `SQLite target preflight failed: ${error?.message ?? String(error)}`);
  } finally {
    try { db?.close(); } catch { /* nothing else to do */ }
  }
}

export function sqliteTargetContractId(db, table) {
  if (!db || typeof db.prepare !== 'function') fail('INVALID_SQLITE_PREFLIGHT', 'An open SQLite database is required');
  text(table, 'table');
  return sha256Canonical(CONTRACT_DOMAIN, targetContractRecord(db, table));
}
