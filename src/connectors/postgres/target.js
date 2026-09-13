import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizePostgresRow, normalizePostgresSchema, normalizePostgresValue, postgresContentKeyId, postgresContentRowHash } from './row-codec.js';
import { withPostgresClient } from './connection.js';
import { POSTGRES_METADATA_SCHEMA, postgresTargetContractId } from './preflight.js';

const LEDGER_TABLE = 'batch_ledger';
const LEASE_TABLE = 'execution_leases';
const PAYLOAD_DOMAIN = 'spool-postgres-batch-payload-v1';
const METADATA_BOOTSTRAP_LOCK = 'spool:postgres-metadata-bootstrap:v1';
const HASH = /^sha256:[0-9a-f]{64}$/;

function requiredString(name, value) {
  if (typeof value !== 'string' || !value) fail('INVALID_BATCH_EVIDENCE', `${name} must be a non-empty string`);
  return value;
}

function requiredHash(name, value) {
  requiredString(name, value);
  if (!HASH.test(value)) fail('INVALID_BATCH_EVIDENCE', `${name} must be a canonical sha256 identity`);
  return value;
}

function quoteIdentifier(value) {
  const text = requiredString('PostgreSQL identifier', value);
  if (text.includes('\u0000')) fail('INVALID_POSTGRES_IDENTIFIER', 'PostgreSQL identifiers cannot contain NUL');
  return `"${text.replaceAll('"', '""')}"`;
}

function validateRows(rows) {
  if (!Array.isArray(rows)) fail('INVALID_BATCH_ROWS', 'rows must be an array');
  if (rows.length === 0) return [];
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) fail('INVALID_BATCH_ROW', 'Each row must be an object');
  const columns = Object.keys(first);
  if (columns.length === 0) fail('INVALID_BATCH_ROW', 'Rows must contain at least one column');
  const signature = [...columns].sort().join('\u0000');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_BATCH_ROW', 'Each row must be an object');
    const keys = Object.keys(row);
    if ([...keys].sort().join('\u0000') !== signature) fail('ROW_SHAPE_MISMATCH', 'All rows in a batch must have the same columns');
    for (const key of keys) {
      const value = row[key];
      if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value) && !(value instanceof Uint8Array)) {
        fail('UNSUPPORTED_POSTGRES_VALUE', `Unsupported PostgreSQL value for ${key}`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) fail('UNSUPPORTED_POSTGRES_VALUE', `Non-finite PostgreSQL number for ${key}`);
    }
  }
  return columns;
}

export function postgresPayloadEvidence(rows) {
  validateRows(rows);
  return Object.freeze({ rowCount: rows.length, payloadHash: sha256Canonical(PAYLOAD_DOMAIN, rows) });
}

function evidenceFrom(input, payloadHash, rowCount) {
  const mappingRevision = input.mappingRevision;
  if (!Number.isInteger(mappingRevision) || mappingRevision < 1) fail('INVALID_BATCH_EVIDENCE', 'mappingRevision must be >= 1');
  if (!Number.isInteger(rowCount) || rowCount < 0) fail('INVALID_BATCH_EVIDENCE', 'rowCount must be a non-negative integer');
  return {
    batchIdentity: requiredHash('batchIdentity', input.batchIdentity),
    migrationId: requiredString('migrationId', input.migrationId),
    planId: requiredHash('planId', input.planId),
    sourceSnapshotId: requiredHash('sourceSnapshotId', input.sourceSnapshotId),
    mappingRevision,
    rowCount,
    payloadHash: requiredHash('payloadHash', payloadHash)
  };
}

function ledgerMatches(row, evidence, targetRef) {
  return row
    && row.batch_identity === evidence.batchIdentity
    && row.migration_id === evidence.migrationId
    && row.plan_id === evidence.planId
    && row.source_snapshot_id === evidence.sourceSnapshotId
    && Number(row.mapping_revision) === evidence.mappingRevision
    && Number(row.row_count) === evidence.rowCount
    && row.payload_hash === evidence.payloadHash
    && row.target_database === targetRef.database
    && row.target_schema === targetRef.schema
    && row.target_table === targetRef.table;
}

function safeFencingToken(value) {
  const token = typeof value === 'bigint' ? value : BigInt(value);
  if (token < 1n || token > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FENCING_TOKEN', 'PostgreSQL fencing token exceeds the supported safe integer range');
  return Number(token);
}

async function metadataDescription(client) {
  const result = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = ANY($2::text[])
    ORDER BY table_name, ordinal_position
  `, [POSTGRES_METADATA_SCHEMA, [LEDGER_TABLE, LEASE_TABLE]]);
  return result.rows;
}

function validateMetadataDescription(rows) {
  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.column_name);
  }
  const ledger = byTable.get(LEDGER_TABLE) ?? new Set();
  const lease = byTable.get(LEASE_TABLE) ?? new Set();
  const requiredLedger = ['batch_identity','migration_id','plan_id','source_snapshot_id','mapping_revision','row_count','payload_hash','target_database','target_schema','target_table','committed_at'];
  const requiredLease = ['resource','owner','fencing_token','expires_at','updated_at'];
  if (requiredLedger.some(name => !ledger.has(name)) || requiredLease.some(name => !lease.has(name))) {
    fail('POSTGRES_METADATA_CONTRACT_INVALID', 'Existing SPOOL PostgreSQL metadata tables do not match the required contract');
  }
}

export async function ensurePostgresMetadata({ targetRef, credentialBroker } = {}) {
  const rows = await withPostgresClient({ targetRef, credentialBroker }, async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [METADATA_BOOTSTRAP_LOCK]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)} (
          batch_identity text PRIMARY KEY,
          migration_id text NOT NULL,
          plan_id text NOT NULL,
          source_snapshot_id text NOT NULL,
          mapping_revision integer NOT NULL CHECK (mapping_revision >= 1),
          row_count integer NOT NULL CHECK (row_count >= 0),
          payload_hash text NOT NULL,
          target_database text NOT NULL,
          target_schema text NOT NULL,
          target_table text NOT NULL,
          committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)} (
          resource text PRIMARY KEY,
          owner text NOT NULL,
          fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
          expires_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      const description = await metadataDescription(client);
      await client.query('COMMIT');
      return description;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
      throw error;
    }
  });
  validateMetadataDescription(rows);
}

export async function acquirePostgresLease({ targetRef, credentialBroker, resource, owner, ttlMs } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('INVALID_POSTGRES_RUNTIME_CONFIG', 'ttlMs must be a positive safe integer');
  await ensurePostgresMetadata({ targetRef, credentialBroker });

  const result = await withPostgresClient({ targetRef, credentialBroker }, async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [resource]);
      const existingResult = await client.query(`
        SELECT owner, fencing_token::text AS fencing_token, expires_at,
               expires_at > clock_timestamp() AS active
        FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)}
        WHERE resource = $1
        FOR UPDATE
      `, [resource]);
      const existing = existingResult.rows[0] ?? null;
      if (existing && existing.owner !== owner && existing.active === true) {
        await client.query('ROLLBACK');
        return { status: 'HELD', owner: existing.owner, fencingToken: existing.fencing_token };
      }
      const nextToken = existing
        ? (existing.owner === owner ? BigInt(existing.fencing_token) : BigInt(existing.fencing_token) + 1n)
        : 1n;
      if (nextToken > BigInt(Number.MAX_SAFE_INTEGER)) {
        await client.query('ROLLBACK');
        return { status: 'TOKEN_OVERFLOW' };
      }
      const upsert = await client.query(`
        INSERT INTO ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)}
          (resource, owner, fencing_token, expires_at, updated_at)
        VALUES ($1, $2, $3::bigint, clock_timestamp() + ($4::bigint * interval '1 millisecond'), clock_timestamp())
        ON CONFLICT (resource) DO UPDATE SET
          owner = EXCLUDED.owner,
          fencing_token = EXCLUDED.fencing_token,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
        RETURNING fencing_token::text AS fencing_token, expires_at
      `, [resource, owner, nextToken.toString(), ttlMs]);
      await client.query('COMMIT');
      return { status: 'ACQUIRED', fencingToken: upsert.rows[0].fencing_token, expiresAt: upsert.rows[0].expires_at };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
      throw error;
    }
  });

  if (result.status === 'HELD') fail('LEASE_HELD', 'PostgreSQL execution lease is held by another owner', { resource, owner: result.owner });
  if (result.status === 'TOKEN_OVERFLOW') fail('FENCING_TOKEN_EXHAUSTED', 'PostgreSQL fencing token exceeded the supported safe integer range', { resource });
  return Object.freeze({ resource, owner, fencingToken: safeFencingToken(result.fencingToken), expiresAt: new Date(result.expiresAt).toISOString() });
}

export async function releasePostgresLease({ targetRef, credentialBroker, resource, owner, fencingToken } = {}) {
  requiredString('resource', resource); requiredString('owner', owner);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_FENCING_TOKEN', 'fencingToken must be a positive safe integer');
  await withPostgresClient({ targetRef, credentialBroker }, async client => {
    await client.query(`
      UPDATE ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)}
      SET expires_at = to_timestamp(0), updated_at = clock_timestamp()
      WHERE resource = $1 AND owner = $2 AND fencing_token = $3::bigint
    `, [resource, owner, fencingToken]);
    return null;
  });
}

function requireRepairKey(key, primaryKey) {
  if (!key || typeof key !== 'object' || Array.isArray(key)) fail('INVALID_REPAIR_OPERATION', 'Repair operation key must be an object');
  const keyFields = Object.keys(key).sort();
  if (keyFields.length === 0 || keyFields.length !== primaryKey.length || !primaryKey.every(field => Object.hasOwn(key, field))) {
    fail('INVALID_REPAIR_OPERATION', 'Repair operation key must identify exactly the verification primary key');
  }
  for (const field of primaryKey) {
    if (key[field] === null || key[field] === undefined) fail('INVALID_REPAIR_OPERATION', 'Repair operation key fields must not be null');
  }
  return key;
}

function requireRepairOperation(operation, primaryKey, schema) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('INVALID_REPAIR_OPERATION', 'Repair operation must be an object');
  const columns = schema.map(field => field.name);
  const { effect, keyId, key, row, precondition } = operation;
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(effect)) fail('INVALID_REPAIR_OPERATION', `Unsupported repair effect ${effect}`);
  requireRepairKey(key, primaryKey);
  if (postgresContentKeyId({ primaryKey, key }) !== keyId) fail('INVALID_REPAIR_OPERATION', 'Repair operation keyId does not match its key');
  if (!precondition || typeof precondition !== 'object' || Array.isArray(precondition)) fail('INVALID_REPAIR_OPERATION', 'Repair operation precondition is required');
  if (effect === 'INSERT') {
    if (row == null || typeof row !== 'object') fail('INVALID_REPAIR_OPERATION', 'INSERT repair requires the expected row');
    if (precondition.absent !== true) fail('INVALID_REPAIR_OPERATION', 'INSERT repair requires an absent precondition');
  }
  if (effect === 'UPDATE') {
    if (row == null || typeof row !== 'object') fail('INVALID_REPAIR_OPERATION', 'UPDATE repair requires the expected row');
    if (typeof precondition.actualRowHash !== 'string' || !HASH.test(precondition.actualRowHash)) fail('INVALID_REPAIR_OPERATION', 'UPDATE repair requires the observed actual row hash');
  }
  if (effect === 'DELETE') {
    if (row != null) fail('INVALID_REPAIR_OPERATION', 'DELETE repair must not carry a row payload');
    if (typeof precondition.actualRowHash !== 'string' || !HASH.test(precondition.actualRowHash)) fail('INVALID_REPAIR_OPERATION', 'DELETE repair requires the observed actual row hash');
  }
  const normalized = row == null ? null : normalizePostgresRow(structuredClone(row), schema);
  if (normalized) {
    const typeByField = new Map(schema.map(field => [field.name, field]));
    for (const field of primaryKey) {
      const expected = normalizePostgresValue(key[field], typeByField.get(field));
      if (normalized[field] !== expected) fail('INVALID_REPAIR_OPERATION', 'Repair operation key must match the expected row primary key');
    }
    const expectedHash = operation.expectedRowHash ?? null;
    if (typeof expectedHash === 'string' && postgresContentRowHash({ primaryKey, columns, key, row: normalized }) !== expectedHash) {
      fail('INVALID_REPAIR_OPERATION', 'Repair operation row does not match its expected row hash');
    }
  }
  return { effect, keyId, key, columns, normalized, precondition };
}

async function checkRepairFence(client, target, fencingToken) {
  if (target.requireFencing && (!Number.isSafeInteger(fencingToken) || fencingToken < 1)) fail('FENCE_REQUIRED', 'Production PostgreSQL repair requires a fencing token');
  if (!target.requireFencing) return;
  const fenceResult = await client.query(`
    SELECT owner, fencing_token::text AS fencing_token,
           expires_at > clock_timestamp() AS active
    FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)}
    WHERE resource = $1
    FOR UPDATE
  `, [target.fenceResource]);
  const fence = fenceResult.rows[0] ?? null;
  if (!fence || Number(fence.fencing_token) !== fencingToken || fence.owner !== target.fenceOwner) {
    await client.query('ROLLBACK');
    fail('STALE_FENCE', 'PostgreSQL repair fencing token is stale', { resource: target.fenceResource, expected: fence?.fencing_token ?? null, actual: fencingToken });
  }
  if (fence.active !== true) {
    await client.query('ROLLBACK');
    fail('LEASE_EXPIRED', 'PostgreSQL repair lease has expired', { resource: target.fenceResource, fencingToken });
  }
}

async function checkRepairContract(client, target, targetContractId) {
  if (targetContractId == null) return;
  requiredHash('targetContractId', targetContractId);
  const actualTargetContractId = await postgresTargetContractId(client, target.targetRef);
  if (actualTargetContractId !== targetContractId) {
    await client.query('ROLLBACK');
    fail('TARGET_CONTRACT_CHANGED', 'Live PostgreSQL target contract changed before repair', { expectedTargetContractId: targetContractId, actualTargetContractId });
  }
}
async function insertRows(client, targetRef, columns, rows) {
  if (!rows.length) return;
  const quotedTable = `${quoteIdentifier(targetRef.schema)}.${quoteIdentifier(targetRef.table)}`;
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const maxRowsPerStatement = Math.max(1, Math.min(1000, Math.floor(60_000 / columns.length)));
  for (let offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    const chunk = rows.slice(offset, offset + maxRowsPerStatement);
    const values = [];
    const groups = chunk.map(row => {
      const placeholders = columns.map(column => {
        values.push(row[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${groups.join(', ')}`, values);
  }
}

export class PostgresTarget {
  constructor({ targetRef, credentialBroker, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    if (!targetRef || typeof targetRef !== 'object') fail('INVALID_POSTGRES_CONFIG', 'targetRef is required');
    this.targetRef = Object.freeze(structuredClone(targetRef));
    this.credentialBroker = credentialBroker;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('POSTGRES_TARGET_CLOSED', 'PostgreSQL target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return postgresPayloadEvidence(input.rows);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    let evidence;
    try {
      evidence = evidenceFrom(input, input.payloadHash, input.rowCount);
      const row = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
        const result = await client.query(`
          SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
                 row_count, payload_hash, target_database, target_schema, target_table, committed_at
          FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
          WHERE batch_identity = $1
        `, [evidence.batchIdentity]);
        return result.rows[0] ?? null;
      });
      if (!row) return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity: evidence.batchIdentity });
      if (!ledgerMatches(row, evidence, this.targetRef)) return Object.freeze({ status: 'CONFLICT', batchIdentity: evidence.batchIdentity });
      return Object.freeze({
        status: 'COMMITTED_EXACT', batchIdentity: evidence.batchIdentity,
        rowCount: evidence.rowCount, payloadHash: evidence.payloadHash,
        committedAt: new Date(row.committed_at).toISOString()
      });
    } catch (error) {
      if (error?.code === 'INVALID_BATCH_EVIDENCE') throw error;
      return Object.freeze({ status: 'INDETERMINATE', batchIdentity: input?.batchIdentity ?? null });
    }
  }

  async commitBatch(input = {}) {
    this.#assertOpen();
    const rows = input.rows;
    const columns = validateRows(rows);
    const described = postgresPayloadEvidence(rows);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production PostgreSQL mutation requires a fencing token');

    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        if (this.requireFencing) {
          const fenceResult = await client.query(`
            SELECT owner, fencing_token::text AS fencing_token,
                   expires_at > clock_timestamp() AS active
            FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEASE_TABLE)}
            WHERE resource = $1
            FOR UPDATE
          `, [this.fenceResource]);
          const fence = fenceResult.rows[0] ?? null;
          if (!fence || Number(fence.fencing_token) !== input.fencingToken || fence.owner !== this.fenceOwner) {
            await client.query('ROLLBACK');
            return { kind: 'STALE_FENCE', actual: fence?.fencing_token ?? null };
          }
          if (fence.active !== true) {
            await client.query('ROLLBACK');
            return { kind: 'LEASE_EXPIRED' };
          }
        }

        if (input.targetContractId != null) {
          requiredHash('targetContractId', input.targetContractId);
          const actualTargetContractId = await postgresTargetContractId(client, this.targetRef);
          if (actualTargetContractId !== input.targetContractId) {
            await client.query('ROLLBACK');
            return { kind: 'TARGET_CONTRACT_CHANGED', actualTargetContractId };
          }
        }

        const existingResult = await client.query(`
          SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
                 row_count, payload_hash, target_database, target_schema, target_table, committed_at
          FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
          WHERE batch_identity = $1
          FOR UPDATE
        `, [evidence.batchIdentity]);
        const existing = existingResult.rows[0] ?? null;
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        await insertRows(client, this.targetRef, columns, rows);
        await client.query(`
          INSERT INTO ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
            (batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
             row_count, payload_hash, target_database, target_schema, target_table)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          evidence.batchIdentity, evidence.migrationId, evidence.planId, evidence.sourceSnapshotId,
          evidence.mappingRevision, evidence.rowCount, evidence.payloadHash,
          this.targetRef.database, this.targetRef.schema, this.targetRef.table
        ]);
        await client.query('COMMIT');
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'STALE_FENCE') fail('STALE_FENCE', 'PostgreSQL mutation fencing token is stale', { resource: this.fenceResource, expected: result.actual, actual: input.fencingToken });
    if (result.kind === 'LEASE_EXPIRED') fail('LEASE_EXPIRED', 'PostgreSQL mutation lease has expired', { resource: this.fenceResource, fencingToken: input.fencingToken });
    if (result.kind === 'TARGET_CONTRACT_CHANGED') fail('TARGET_CONTRACT_CHANGED', 'Live PostgreSQL target contract changed after planning/approval', { expectedTargetContractId: input.targetContractId, actualTargetContractId: result.actualTargetContractId });
    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact commit evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
    });
  }

  async ledgerEntries({ migrationId = null } = {}) {
    this.#assertOpen();
    const values = [this.targetRef.database, this.targetRef.schema, this.targetRef.table];
    let migrationClause = '';
    if (migrationId) { values.push(migrationId); migrationClause = ` AND migration_id = $${values.length}`; }
    const rows = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      const result = await client.query(`
        SELECT batch_identity AS "batchIdentity", migration_id AS "migrationId", plan_id AS "planId",
               source_snapshot_id AS "sourceSnapshotId", mapping_revision AS "mappingRevision",
               row_count AS "rowCount", payload_hash AS "payloadHash", target_table AS "targetTable",
               committed_at AS "committedAt"
        FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
        WHERE target_database = $1 AND target_schema = $2 AND target_table = $3${migrationClause}
        ORDER BY committed_at, batch_identity
      `, values);
      return result.rows;
    });
    return rows.map(row => Object.freeze({ ...row, mappingRevision: Number(row.mappingRevision), rowCount: Number(row.rowCount), committedAt: new Date(row.committedAt).toISOString() }));
  }

  async applyRepairOperation(input = {}) {
    this.#assertOpen();
    if (!Array.isArray(input.primaryKey) || input.primaryKey.length === 0) fail('INVALID_REPAIR_OPERATION', 'Repair primaryKey is required');
    const primaryKey = Object.freeze([...input.primaryKey]);
    const schema = normalizePostgresSchema(input.targetSchema);
    const prepared = requireRepairOperation(input.operation, primaryKey, schema);
    const { effect, keyId, key, columns, normalized, precondition } = prepared;
    const expectedRowHash = normalized == null ? null : postgresContentRowHash({ primaryKey, columns, key, row: normalized });

    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        await checkRepairFence(client, this, input.fencingToken);
        await checkRepairContract(client, this, input.targetContractId);

        const quotedTable = `${quoteIdentifier(this.targetRef.schema)}.${quoteIdentifier(this.targetRef.table)}`;
        const whereValues = [];
        const whereClauses = primaryKey.map(field => {
          whereValues.push(key[field]);
          return `${quoteIdentifier(field)} = $${whereValues.length}`;
        });
        const selectList = columns.map(field => `${quoteIdentifier(field)}::text AS ${quoteIdentifier(field)}`).join(', ');
        const found = await client.query(`SELECT ${selectList} FROM ${quotedTable} WHERE ${whereClauses.join(' AND ')} FOR UPDATE`, whereValues);
        if (found.rows.length > 1) {
          await client.query('ROLLBACK');
          fail('REPAIR_KEY_NOT_UNIQUE', 'Repair operation key matches more than one target row');
        }
        const current = found.rows.length === 0 ? null : normalizePostgresRow(found.rows[0], schema);
        const observedRowHash = current == null ? null : postgresContentRowHash({ primaryKey, columns, key, row: current });

        let applied = false;
        if (effect === 'INSERT') {
          if (current == null) {
            const values = [];
            const placeholders = columns.map(column => {
              values.push(normalized[column]);
              return `$${values.length}`;
            });
            await client.query(
              `INSERT INTO ${quotedTable} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
              values
            );
            applied = true;
          } else if (observedRowHash !== expectedRowHash) {
            await client.query('ROLLBACK');
            fail('REPAIR_PRECONDITION_FAILED', 'INSERT repair precondition failed: target row is present with unexpected content', { keyId });
          }
        } else if (effect === 'UPDATE') {
          if (current == null) {
            await client.query('ROLLBACK');
            fail('REPAIR_PRECONDITION_FAILED', 'UPDATE repair precondition failed: target row is missing', { keyId });
          } else if (observedRowHash !== expectedRowHash && observedRowHash !== precondition.actualRowHash) {
            await client.query('ROLLBACK');
            fail('REPAIR_PRECONDITION_FAILED', 'UPDATE repair precondition failed: target row changed since verification', { keyId });
          } else if (observedRowHash !== expectedRowHash) {
            const setValues = [];
            const setClauses = [];
            for (const column of columns) {
              if (primaryKey.includes(column)) continue;
              setValues.push(normalized[column]);
              setClauses.push(`${quoteIdentifier(column)} = $${setValues.length}`);
            }
            const params = [...setValues, ...whereValues];
            const where = primaryKey.map((field, index) => `${quoteIdentifier(field)} = $${setValues.length + index + 1}`);
            await client.query(`UPDATE ${quotedTable} SET ${setClauses.join(', ')} WHERE ${where.join(' AND ')}`, params);
            applied = true;
          }
        } else if (current != null && observedRowHash !== precondition.actualRowHash) {
          await client.query('ROLLBACK');
          fail('REPAIR_PRECONDITION_FAILED', 'DELETE repair precondition failed: target row changed since verification', { keyId });
        } else if (current != null) {
          await client.query(`DELETE FROM ${quotedTable} WHERE ${whereClauses.join(' AND ')}`, whereValues);
          applied = true;
        }

        await client.query('COMMIT');
        return { applied, observedRowHash };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    return Object.freeze({
      effect, keyId, applied: result.applied,
      observedRowHash: result.observedRowHash,
      writtenRowHash: !result.applied ? result.observedRowHash : (effect === 'DELETE' ? null : expectedRowHash)
    });
  }

  close() { this.closed = true; }
}
