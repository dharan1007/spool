import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';
import { withPostgresClient } from './connection.js';
import { postgresTargetContractId } from './preflight.js';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_BIND_PARAMS = 60_000;

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000')) fail('INVALID_POSTGRES_IDENTIFIER', 'PostgreSQL identifier is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

function requireSchema(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_POSTGRES_VERIFICATION', 'targetSchema is required for PostgreSQL verification');
  const seen = new Set();
  return targetSchema.map(field => {
    if (!field || typeof field !== 'object' || !FIELD.test(field.name ?? '') || typeof field.type !== 'string') {
      fail('INVALID_POSTGRES_VERIFICATION', 'targetSchema contains an invalid field');
    }
    if (seen.has(field.name)) fail('INVALID_POSTGRES_VERIFICATION', `targetSchema contains duplicate field ${field.name}`);
    seen.add(field.name);
    return { name: field.name, type: field.type };
  });
}

function requireTargetContractId(value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_POSTGRES_VERIFICATION', 'targetContractId must be a canonical sha256 identity');
  return value;
}

function normalizeLocalDateTime(value) {
  const text = String(value).trim().replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `Unsupported local datetime value ${text}`);
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction ? `${match[1]}.${fraction}` : match[1];
}

function normalizeValue(value, field) {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'string': return String(value);
    case 'integer': {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not a safe integer`);
      return number;
    }
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not finite`);
      return number;
    }
    case 'boolean': {
      if (value === true || value === false) return value;
      if (value === 't' || value === 'true') return true;
      if (value === 'f' || value === 'false') return false;
      fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not boolean`);
      break;
    }
    case 'date': {
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not a canonical date`);
      return text;
    }
    case 'local_datetime': return normalizeLocalDateTime(value);
    default: fail('POSTGRES_VERIFICATION_TYPE_UNSUPPORTED', `Unsupported verification type ${field.type}`);
  }
}

async function discoverVerificationContract(client, targetRef, targetSchema) {
  const relation = await client.query(`
    SELECT c.oid::text AS oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
  `, [targetRef.schema, targetRef.table]);
  const oid = relation.rows[0]?.oid;
  if (!oid) fail('TARGET_TABLE_NOT_FOUND', `PostgreSQL target ${targetRef.schema}.${targetRef.table} does not exist as an ordinary table`);

  const pk = await client.query(`
    SELECT a.attname AS name
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinal)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
    WHERE i.indrelid = $1::oid AND i.indisprimary
    ORDER BY key.ordinal
  `, [oid]);
  const primaryKey = pk.rows.map(row => row.name);
  if (primaryKey.length === 0) fail('POSTGRES_VERIFICATION_PRIMARY_KEY_REQUIRED', 'Exact PostgreSQL content verification requires a real primary key');

  const names = targetSchema.map(field => field.name);
  const columnsResult = await client.query(`
    SELECT a.attname AS name
    FROM pg_attribute a
    WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY($2::text[])
  `, [oid, names]);
  const actualColumns = new Set(columnsResult.rows.map(row => row.name));
  for (const field of targetSchema) {
    if (!actualColumns.has(field.name)) fail('TARGET_SCHEMA_INCOMPATIBLE', `Verification field ${field.name} is not present on the live PostgreSQL target`);
  }
  for (const key of primaryKey) {
    if (!names.includes(key)) fail('POSTGRES_VERIFICATION_PRIMARY_KEY_UNPROJECTED', `Primary-key field ${key} is not part of targetSchema`);
  }
  return { primaryKey };
}

function normalizeExpectedRows(rows, targetSchema) {
  if (!Array.isArray(rows)) fail('INVALID_POSTGRES_VERIFICATION', 'expectedRows must be an array');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_POSTGRES_VERIFICATION', `expectedRows[${index}] must be an object`);
    const normalized = {};
    for (const field of targetSchema) {
      if (!Object.hasOwn(row, field.name)) fail('CONTENT_PROJECTION_FIELD_MISSING', `Expected row ${index} is missing field ${field.name}`);
      normalized[field.name] = normalizeValue(row[field.name], field);
    }
    return normalized;
  });
}

function normalizeActualRows(rows, targetSchema) {
  return rows.map(row => {
    const normalized = {};
    for (const field of targetSchema) normalized[field.name] = normalizeValue(row[field.name], field);
    return normalized;
  });
}

async function readRows(client, targetRef, normalizedExpectedRows, primaryKey, targetSchema) {
  if (normalizedExpectedRows.length === 0) return [];
  const quotedTable = `${quoteIdentifier(targetRef.schema)}.${quoteIdentifier(targetRef.table)}`;
  const selectList = targetSchema.map(field => `${quoteIdentifier(field.name)}::text AS ${quoteIdentifier(field.name)}`).join(', ');
  const perRowParams = primaryKey.length;
  const chunkSize = Math.max(1, Math.min(1000, Math.floor(MAX_BIND_PARAMS / perRowParams)));
  const out = [];

  for (let offset = 0; offset < normalizedExpectedRows.length; offset += chunkSize) {
    const chunk = normalizedExpectedRows.slice(offset, offset + chunkSize);
    const values = [];
    const predicates = chunk.map(row => {
      const clauses = primaryKey.map(key => {
        values.push(row[key]);
        return `${quoteIdentifier(key)} = $${values.length}`;
      });
      return `(${clauses.join(' AND ')})`;
    });
    const orderBy = primaryKey.map(quoteIdentifier).join(', ');
    const result = await client.query(`SELECT ${selectList} FROM ${quotedTable} WHERE ${predicates.join(' OR ')} ORDER BY ${orderBy}`, values);
    out.push(...result.rows);
  }
  return out;
}

export async function withPostgresContentVerificationSession({ targetRef, credentialBroker, targetSchema, targetContractId } = {}, callback) {
  const schema = requireSchema(targetSchema);
  const expectedTargetContractId = requireTargetContractId(targetContractId);
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_VERIFICATION', 'Verification session callback is required');

  return withPostgresClient({ targetRef, credentialBroker }, async client => {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const quotedTable = `${quoteIdentifier(targetRef.schema)}.${quoteIdentifier(targetRef.table)}`;
      await client.query(`LOCK TABLE ${quotedTable} IN ACCESS SHARE MODE`);
      const actualTargetContractId = await postgresTargetContractId(client, targetRef);
      if (actualTargetContractId !== expectedTargetContractId) {
        fail('TARGET_CONTRACT_CHANGED', 'Live PostgreSQL target contract changed before content verification', {
          expectedTargetContractId,
          actualTargetContractId
        });
      }
      const contract = await discoverVerificationContract(client, targetRef, schema);
      const stateResult = await client.query(`
        SELECT current_database() AS database,
               pg_current_snapshot()::text AS mvcc_snapshot,
               pg_current_wal_lsn()::text AS wal_lsn
      `);
      const state = stateResult.rows[0] ?? {};
      const targetReadState = Object.freeze({
        connector: 'postgres',
        database: state.database ?? targetRef.database,
        schema: targetRef.schema,
        table: targetRef.table,
        targetContractId: expectedTargetContractId,
        mvccSnapshot: String(state.mvcc_snapshot ?? ''),
        walLsn: String(state.wal_lsn ?? '')
      });
      if (!targetReadState.mvccSnapshot || !targetReadState.walLsn) fail('POSTGRES_VERIFICATION_STATE_UNAVAILABLE', 'PostgreSQL verification snapshot identity is unavailable');

      const verifier = Object.freeze({
        primaryKey: Object.freeze([...contract.primaryKey]),
        columns: Object.freeze(schema.map(field => field.name)),
        targetReadState,
        async verifyBatch(expectedRows) {
          const normalizedExpectedRows = normalizeExpectedRows(expectedRows, schema);
          const rawActualRows = await readRows(client, targetRef, normalizedExpectedRows, contract.primaryKey, schema);
          const normalizedActualRows = normalizeActualRows(rawActualRows, schema);
          return verifyContentProjection({
            expectedRows: normalizedExpectedRows,
            actualRows: normalizedActualRows,
            primaryKey: contract.primaryKey,
            columns: schema.map(field => field.name)
          });
        }
      });

      const result = await callback(verifier);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

export async function verifyPostgresContent({ targetRef, credentialBroker, expectedRows, targetSchema, targetContractId } = {}) {
  return withPostgresContentVerificationSession({ targetRef, credentialBroker, targetSchema, targetContractId }, verifier => verifier.verifyBatch(expectedRows));
}
