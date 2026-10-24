// Read-only SQLite destination discovery.
//
// Table enumeration and schema inspection are read-only. Compatibility decisions
// remain the engine's: `preflight()` calls the authoritative
// `inspectSqliteTarget()` implementation, so the Console cannot loosen or
// duplicate target-contract rules.
import Database from 'better-sqlite3';
import { consoleFail } from './errors.js';
import { sha256File } from './source-discovery.js';

const INTERNAL_TABLES = new Set(['__spool_batch_ledger', 'spool_execution_leases']);
const VIRTUAL = /^\s*CREATE\s+VIRTUAL\s+TABLE/i;

function openReadOnly(path) {
  try {
    return new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  } catch (error) {
    consoleFail('CONSOLE_VALIDATION_FAILED', 'SQLite database could not be opened read-only', {
      reason: typeof error?.code === 'string' ? error.code : 'UNKNOWN'
    });
  }
}

function affinity(declaredType) {
  const type = String(declaredType ?? '').trim().toUpperCase();
  if (type.includes('INT')) return 'INTEGER';
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
  if (!type || type.includes('BLOB')) return 'BLOB';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

export function suggestTargetType(column) {
  const declared = String(column.declaredType ?? '').toUpperCase();
  const affinityName = affinity(declared);
  if (affinityName === 'BLOB') return null;
  if (/BOOL/.test(declared)) return 'boolean';
  if (affinityName === 'TEXT' && /DATE|TIME/.test(declared)) return /TIME/.test(declared) ? 'local_datetime' : 'date';
  if (affinityName === 'INTEGER') return 'integer';
  if (affinityName === 'REAL' || affinityName === 'NUMERIC') return 'number';
  return 'string';
}

export function createSqliteCatalog({ engine } = {}) {
  async function listTables({ path }) {
    const db = openReadOnly(path);
    try {
      const integral = db.pragma('integrity_check', { simple: true });
      const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      const tables = rows
        .filter(row => !row.name.startsWith('sqlite_'))
        .filter(row => !INTERNAL_TABLES.has(row.name))
        .map(row => {
          const columns = db.prepare('SELECT cid, name, type, "notnull" AS is_not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(row.name);
          const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(row.name);
          return {
            name: row.name,
            virtual: VIRTUAL.test(row.sql ?? ''),
            internal: false,
            columnCount: columns.filter(column => Number(column.hidden) === 0).length,
            triggerCount: triggers.length,
            eligible: !VIRTUAL.test(row.sql ?? '') && triggers.length === 0
          };
        });
      return {
        path,
        integrity: integral === 'ok' ? 'OK' : 'DEGRADED',
        tables,
        fingerprint: await sha256File(path)
      };
    } catch (error) {
      if (error?.code) throw error;
      consoleFail('CONSOLE_VALIDATION_FAILED', 'SQLite database could not be read', { reason: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
    } finally {
      db.close();
    }
  }

  async function inspect({ path, table }) {
    const db = openReadOnly(path);
    try {
      if (INTERNAL_TABLES.has(table)) consoleFail('TABLE_NOT_AVAILABLE', 'SPOOL internal tables cannot be migration targets', { table });
      const row = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(table);
      if (!row || row.type !== 'table') consoleFail('TABLE_NOT_AVAILABLE', 'Table does not exist as an ordinary table', { table });
      if (VIRTUAL.test(row.sql ?? '')) consoleFail('TABLE_NOT_AVAILABLE', 'Virtual SQLite tables are not supported', { table });
      if (table.startsWith('sqlite_')) consoleFail('TABLE_NOT_AVAILABLE', 'SQLite internal tables cannot be targeted', { table });

      const columns = db.prepare('SELECT cid, name, type, "notnull" AS is_not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table)
        .map(column => ({
          cid: Number(column.cid),
          name: column.name,
          declaredType: column.type ?? '',
          affinity: affinity(column.type),
          notNull: Number(column.is_not_null) === 1,
          defaultSql: column.dflt_value ?? null,
          primaryKeyOrder: Number(column.pk),
          hidden: Number(column.hidden),
          suggestedType: suggestTargetType({ declaredType: column.type })
        }));
      const indexes = db.prepare('SELECT seq, name, "unique" AS is_unique, origin, partial FROM pragma_index_list(?) ORDER BY seq, name').all(table)
        .map(index => ({
          name: index.name,
          unique: Number(index.is_unique) === 1,
          origin: index.origin,
          partial: Number(index.partial) === 1,
          columns: db.prepare('SELECT seqno, cid, name FROM pragma_index_xinfo(?) ORDER BY seqno').all(index.name).map(item => ({ seqno: Number(item.seqno), cid: Number(item.cid), name: item.name ?? null }))
        }));
      const foreignKeys = db.prepare('SELECT id, seq, "table" AS ref_table, "from" AS from_col, "to" AS to_col, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table)
        .map(fk => ({ id: Number(fk.id), table: fk.ref_table, from: fk.from_col, to: fk.to_col, onUpdate: fk.on_update, onDelete: fk.on_delete }));
      const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name").all(table)
        .map(trigger => ({ name: trigger.name }));
      const journalMode = db.pragma('journal_mode', { simple: true });
      const contractId = engine.sqliteTargetContractId(db, table);

      const targetSchema = columns
        .filter(column => Number(column.hidden) === 0 && column.suggestedType !== null)
        .map(column => ({
          name: column.name,
          type: column.suggestedType,
          nullable: !column.notNull && Number(column.primaryKeyOrder) === 0
        }));
      const unsupportedColumns = columns.filter(column => Number(column.hidden) === 0 && column.suggestedType === null).map(column => column.name);

      return {
        path,
        table,
        sql: row.sql ?? '',
        columns,
        indexes,
        foreignKeys,
        triggers,
        journalMode,
        targetContractId: contractId,
        targetSchema,
        unsupportedColumns,
        writable: true,
        notes: [
          'Preflight compatibility is not a guarantee that every insert will succeed. Unique constraints, foreign keys, concurrent writers or disk exhaustion can still stop the run safely.',
          triggers.length ? 'This table has triggers. The engine refuses triggered targets because they create side effects outside the approved plan.' : null
        ].filter(Boolean)
      };
    } catch (error) {
      if (error?.code) throw error;
      throw error;
    } finally {
      db.close();
    }
  }

  function preflight({ path, table, targetSchema }) {
    try {
      return engine.inspectSqliteTarget({ path, table, targetSchema });
    } catch (error) {
      if (error?.code) throw error;
      throw error;
    }
  }

  return Object.freeze({ listTables, inspect, preflight, suggestTargetType });
}
