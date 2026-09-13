import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';
import { normalizePostgresRow, normalizePostgresSchema } from './row-codec.js';
import { withPostgresClient } from './connection.js';
import { postgresTargetContractId } from './preflight.js';

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_BIND_PARAMS = 60_000;

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000')) fail('INVALID_POSTGRES_IDENTIFIER', 'PostgreSQL identifier is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

function requireSchema(targetSchema) {
  return normalizePostgresSchema(targetSchema);
}

function requireTargetContractId(value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_POSTGRES_VERIFICATION', 'targetContractId must be a canonical sha256 identity');
  return value;
}

function normalizeExpectedRows(rows, targetSchema) {
  if (!Array.isArray(rows)) fail('INVALID_POSTGRES_VERIFICATION', 'expectedRows must be an array');
  return rows.map(row => normalizePostgresRow(row, targetSchema));
}

function normalizeActualRows(rows, targetSchema) {
  return rows.map(row => normalizePostgresRow(row, targetSchema));
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
