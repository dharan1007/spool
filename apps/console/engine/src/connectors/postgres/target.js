import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { from as copyFrom } from 'pg-copy-streams';
import { normalizePostgresRow, normalizePostgresSchema, normalizePostgresValue, postgresContentKeyId, postgresContentRowHash } from './row-codec.js';
import { withPostgresClient } from './connection.js';
import { POSTGRES_METADATA_SCHEMA, postgresTargetContractId } from './preflight.js';

const LEDGER_TABLE = 'batch_ledger';
const LEASE_TABLE = 'execution_leases';
const PAYLOAD_DOMAIN = 'spool-postgres-batch-payload-v1';
const DELETE_MANIFEST_DOMAIN = 'spool-postgres-delete-manifest-v1';
const TRUNCATE_PAYLOAD_DOMAIN = 'spool-postgres-truncate-v1';
const TRUNCATE_EFFECT = 'postgres:target-truncate';
const METADATA_BOOTSTRAP_LOCK = 'spool:postgres-metadata-bootstrap:v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function postgresMutationKeyId({ primaryKey, row } = {}) {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_MUTATION_KEY', 'Mutation primaryKey must be a non-empty array');
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_MUTATION_KEY', 'Mutation row must be an object');
  const key = {};
  for (const field of primaryKey) {
    if (typeof field !== 'string' || !SAFE_COLUMN.test(field)) fail('INVALID_MUTATION_KEY', `Mutation primaryKey field ${field} is invalid`);
    if (!Object.hasOwn(row, field) || row[field] === null || row[field] === undefined) {
      fail('INVALID_MUTATION_KEY', `Mutation row is missing primary-key field ${field}`);
    }
    key[field] = row[field];
  }
  return Object.freeze({ key: Object.freeze(key), keyId: postgresContentKeyId({ primaryKey, key }) });
}

export function requireUniqueMutationKeys(primaryKey, rows) {
  if (!Array.isArray(rows)) fail('INVALID_MUTATION_ROWS', 'Mutation rows must be an array');
  const seen = new Set();
  const keyed = rows.map(row => {
    const identified = postgresMutationKeyId({ primaryKey, row });
    if (seen.has(identified.keyId)) fail('DUPLICATE_BATCH_KEY', 'Mutation batch contains a duplicate primary key', { keyId: identified.keyId });
    seen.add(identified.keyId);
    return Object.freeze({ ...identified, row });
  });
  return Object.freeze(keyed);
}

export function postgresDeleteManifestEvidence(deletions) {
  if (!Array.isArray(deletions)) fail('INVALID_DELETE_MANIFEST', 'Delete manifest must be an array');
  const manifest = deletions.map(entry => {
    if (!entry || typeof entry !== 'object') fail('INVALID_DELETE_MANIFEST', 'Delete manifest entries must be objects');
    requiredHash('expectedRowHash', entry.expectedRowHash);
    if (typeof entry.keyId !== 'string' || !HASH.test(entry.keyId)) fail('INVALID_DELETE_MANIFEST', 'Delete manifest keyId must be a canonical sha256 identity');
    return { keyId: entry.keyId, expectedRowHash: entry.expectedRowHash };
  }).sort((left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0));
  return Object.freeze({ rowCount: manifest.length, payloadHash: sha256Canonical(DELETE_MANIFEST_DOMAIN, manifest) });
}

export function postgresTruncateEvidence({ database, schema, table, targetContractId, approvalId } = {}) {
  requiredString('database', database);
  requiredString('schema', schema);
  requiredString('table', table);
  requiredHash('targetContractId', targetContractId);
  if (typeof approvalId !== 'string' || !approvalId) fail('INVALID_TRUNCATE_EVIDENCE', 'Truncate approvalId is required');
  return Object.freeze({
    rowCount: 0,
    payloadHash: sha256Canonical(TRUNCATE_PAYLOAD_DOMAIN, { database, schema, table, targetContractId, approvalId })
  });
}

function assertTruncateApproval({ approval, migrationId, liveContractId }) {
  if (!approval || typeof approval !== 'object') fail('APPROVAL_REQUIRED', 'Target truncate requires a bound truncate approval');
  if (typeof approval.approvalId !== 'string' || !approval.approvalId) fail('INVALID_APPROVAL', 'Truncate approval envelope is invalid');
  const record = approval.record;
  if (!record || record.migrationId !== migrationId) fail('APPROVAL_BINDING_MISMATCH', 'Truncate approval is not bound to this migration');
  if (!Array.isArray(record.effects) || !record.effects.includes(TRUNCATE_EFFECT)) {
    fail('APPROVAL_BINDING_MISMATCH', `Truncate approval must include the ${TRUNCATE_EFFECT} effect`);
  }
  if (record.targetContractId !== liveContractId) fail('APPROVAL_BINDING_MISMATCH', 'Truncate approval is not bound to the live target contract');
  if (!Number.isFinite(Date.parse(record.expiresAt ?? '')) || Date.parse(record.expiresAt) <= Date.now()) {
    fail('APPROVAL_EXPIRED', 'Truncate approval has expired');
  }
  return approval.approvalId;
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

async function checkRepairFence(client, target, fencingToken, operation = 'repair') {
  if (target.requireFencing && (!Number.isSafeInteger(fencingToken) || fencingToken < 1)) fail('FENCE_REQUIRED', `Production PostgreSQL ${operation} requires a fencing token`);
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
    fail('STALE_FENCE', `PostgreSQL ${operation} fencing token is stale`, { resource: target.fenceResource, expected: fence?.fencing_token ?? null, actual: fencingToken });
  }
  if (fence.active !== true) {
    await client.query('ROLLBACK');
    fail('LEASE_EXPIRED', `PostgreSQL ${operation} lease has expired`, { resource: target.fenceResource, fencingToken });
  }
}

async function checkRepairContract(client, target, targetContractId, operation = 'repair') {
  if (targetContractId == null) return;
  requiredHash('targetContractId', targetContractId);
  const actualTargetContractId = await postgresTargetContractId(client, target.targetRef);
  if (actualTargetContractId !== targetContractId) {
    await client.query('ROLLBACK');
    fail('TARGET_CONTRACT_CHANGED', `Live PostgreSQL target contract changed before ${operation}`, { expectedTargetContractId: targetContractId, actualTargetContractId });
  }
}

async function findLedgerEntry(client, targetRef, batchIdentity) {
  const result = await client.query(`
    SELECT batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
           row_count, payload_hash, target_database, target_schema, target_table, committed_at
    FROM ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
    WHERE batch_identity = $1
    FOR UPDATE
  `, [batchIdentity]);
  return result.rows[0] ?? null;
}

async function insertLedgerEntry(client, targetRef, evidence) {
  await client.query(`
    INSERT INTO ${quoteIdentifier(POSTGRES_METADATA_SCHEMA)}.${quoteIdentifier(LEDGER_TABLE)}
      (batch_identity, migration_id, plan_id, source_snapshot_id, mapping_revision,
       row_count, payload_hash, target_database, target_schema, target_table)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    evidence.batchIdentity, evidence.migrationId, evidence.planId, evidence.sourceSnapshotId,
    evidence.mappingRevision, evidence.rowCount, evidence.payloadHash,
    targetRef.database, targetRef.schema, targetRef.table
  ]);
}
function encodeCopyField(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('UNSUPPORTED_POSTGRES_VALUE', 'Non-finite PostgreSQL number cannot be bulk-loaded');
    text = String(value);
  }
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'string') text = value;
  else if (value instanceof Uint8Array) text = `\\x${Buffer.from(value).toString('hex')}`;
  else fail('UNSUPPORTED_POSTGRES_VALUE', 'Unsupported PostgreSQL value for bulk load');
  return `"${text.replaceAll('"', '""')}"`;
}

async function copyRows(client, targetRef, columns, rows) {
  if (!rows.length) return;
  const quotedTable = `${quoteIdentifier(targetRef.schema)}.${quoteIdentifier(targetRef.table)}`;
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const stream = client.query(copyFrom(`COPY ${quotedTable} (${quotedColumns}) FROM STDIN WITH (FORMAT CSV)`));
  const CHUNK_ROWS = 1000;
  let offset = 0;
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    (function pump() {
      let ok = true;
      while (offset < rows.length && ok) {
        const chunk = rows.slice(offset, offset + CHUNK_ROWS);
        offset += chunk.length;
        ok = stream.write(`${chunk.map(row => columns.map(column => encodeCopyField(row[column])).join(',')).join('\n')}\n`);
      }
      if (offset >= rows.length) stream.end();
      else stream.once('drain', pump);
    })();
  });
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
          await checkRepairFence(client, this, input.fencingToken, 'mutation');
        }

        await checkRepairContract(client, this, input.targetContractId ?? null, 'planning/approval');

        const existing = await findLedgerEntry(client, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        await insertRows(client, this.targetRef, columns, rows);
        await insertLedgerEntry(client, this.targetRef, evidence);
        await client.query('COMMIT');
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact commit evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
    });
  }

  async commitBulkBatch(input = {}) {
    this.#assertOpen();
    const rows = input.rows;
    const columns = validateRows(rows);
    const described = postgresPayloadEvidence(rows);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);

    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        if (this.requireFencing) {
          await checkRepairFence(client, this, input.fencingToken, 'bulk copy');
        }

        await checkRepairContract(client, this, input.targetContractId ?? null, 'planning/approval');

        const existing = await findLedgerEntry(client, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        await copyRows(client, this.targetRef, columns, rows);
        await insertLedgerEntry(client, this.targetRef, evidence);
        await client.query('COMMIT');
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact bulk commit evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash
    });
  }

  async commitUpsertBatch(input = {}) {
    this.#assertOpen();
    const rows = input.rows;
    const columns = validateRows(rows);
    if (rows.length === 0) fail('INVALID_BATCH_ROWS', 'Upsert batch must contain at least one row');
    const primaryKey = input.primaryKey;
    if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_MUTATION_KEY', 'Upsert primaryKey must be a non-empty array');
    for (const field of primaryKey) {
      if (!columns.includes(field)) fail('INVALID_MUTATION_KEY', `Upsert primaryKey field ${field} is not part of the batch columns`);
    }
    const keyed = requireUniqueMutationKeys(primaryKey, rows);
    const described = postgresPayloadEvidence(rows);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production PostgreSQL mutation requires a fencing token');

    const updatable = columns.filter(column => !primaryKey.includes(column));
    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        if (this.requireFencing) {
          await checkRepairFence(client, this, input.fencingToken, 'upsert');
        }

        await checkRepairContract(client, this, input.targetContractId ?? null, 'planning/approval');

        const existing = await findLedgerEntry(client, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true, inserted: existing.inserted ?? null, updated: null };
        }

        const quotedTable = `${quoteIdentifier(this.targetRef.schema)}.${quoteIdentifier(this.targetRef.table)}`;
        const quotedColumns = columns.map(quoteIdentifier).join(', ');
        const conflictTarget = `(${primaryKey.map(quoteIdentifier).join(', ')})`;
        const action = updatable.length === 0
          ? 'DO NOTHING'
          : `DO UPDATE SET ${updatable.map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`;
        const maxRowsPerStatement = Math.max(1, Math.min(1000, Math.floor(60_000 / columns.length)));
        let inserted = 0;
        let updated = 0;
        for (let offset = 0; offset < keyed.length; offset += maxRowsPerStatement) {
          const chunk = keyed.slice(offset, offset + maxRowsPerStatement);
          const values = [];
          const groups = chunk.map(entry => {
            const placeholders = columns.map(column => {
              values.push(entry.row[column]);
              return `$${values.length}`;
            });
            return `(${placeholders.join(', ')})`;
          });
          const written = await client.query(
            `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${groups.join(', ')} ON CONFLICT ${conflictTarget} ${action} RETURNING (xmax = 0) AS inserted`,
            values
          );
          for (const row of written.rows) {
            if (row.inserted === true) inserted += 1;
            else updated += 1;
          }
        }
        if (inserted + updated !== keyed.length && updatable.length > 0) {
          await client.query('ROLLBACK');
          fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL upsert did not return exact per-row evidence', { inserted, updated, expected: keyed.length });
        }

        await insertLedgerEntry(client, this.targetRef, evidence);
        await client.query('COMMIT');
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false, inserted, updated };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact upsert evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash,
      inserted: result.inserted, updated: result.updated
    });
  }

  async commitDeleteBatch(input = {}) {
    this.#assertOpen();
    const primaryKey = input.primaryKey;
    if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_MUTATION_KEY', 'Delete primaryKey must be a non-empty array');
    const deletions = input.deletions;
    if (!Array.isArray(deletions) || deletions.length === 0) fail('INVALID_DELETE_MANIFEST', 'Delete batch must contain at least one deletion');
    const seen = new Set();
    const prepared = deletions.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_DELETE_MANIFEST', 'Delete entries must be objects');
      const identified = postgresMutationKeyId({ primaryKey, row: entry.key });
      if (seen.has(identified.keyId)) fail('DUPLICATE_BATCH_KEY', 'Delete batch contains a duplicate primary key', { keyId: identified.keyId });
      seen.add(identified.keyId);
      requiredHash('expectedRowHash', entry.expectedRowHash);
      return Object.freeze({ key: identified.key, keyId: identified.keyId, expectedRowHash: entry.expectedRowHash });
    });
    const described = postgresDeleteManifestEvidence(prepared);
    const evidence = evidenceFrom(input, described.payloadHash, described.rowCount);
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production PostgreSQL mutation requires a fencing token');

    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        if (this.requireFencing) {
          await checkRepairFence(client, this, input.fencingToken, 'delete');
        }

        await checkRepairContract(client, this, input.targetContractId ?? null, 'planning/approval');

        const existing = await findLedgerEntry(client, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'COMMITTED_EXACT', alreadyCommitted: true };
        }

        const quotedTable = `${quoteIdentifier(this.targetRef.schema)}.${quoteIdentifier(this.targetRef.table)}`;
        const missing = [];
        const mismatched = [];
        const doomed = [];
        for (const entry of prepared) {
          const whereValues = [];
          const whereClauses = primaryKey.map(field => {
            whereValues.push(entry.key[field]);
            return `${quoteIdentifier(field)} = $${whereValues.length}`;
          });
          const found = await client.query(`SELECT * FROM ${quotedTable} WHERE ${whereClauses.join(' AND ')} FOR UPDATE`, whereValues);
          if (found.rows.length === 0) {
            missing.push(entry.keyId);
            continue;
          }
          const actual = found.rows[0];
          const observedColumns = Object.keys(actual).filter(name => name !== 'tableoid' && name !== 'ctid' && name !== 'xmin' && name !== 'xmax').sort();
          const observedRowHash = postgresContentRowHash({ primaryKey, columns: observedColumns, key: entry.key, row: actual });
          if (observedRowHash !== entry.expectedRowHash) {
            mismatched.push(entry.keyId);
            continue;
          }
          doomed.push(entry);
        }
        if (missing.length > 0 || mismatched.length > 0) {
          await client.query('ROLLBACK');
          fail('DELETE_PRECONDITION_FAILED', 'Delete batch preconditions failed; nothing was deleted', { missing, mismatched });
        }
        for (const entry of doomed) {
          const whereValues = [];
          const whereClauses = primaryKey.map(field => {
            whereValues.push(entry.key[field]);
            return `${quoteIdentifier(field)} = $${whereValues.length}`;
          });
          const removed = await client.query(`DELETE FROM ${quotedTable} WHERE ${whereClauses.join(' AND ')}`, whereValues);
          if (removed.rowCount !== 1) {
            await client.query('ROLLBACK');
            fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL delete did not remove exactly one row per key', { keyId: entry.keyId });
          }
        }

        await insertLedgerEntry(client, this.targetRef, evidence);
        await client.query('COMMIT');
        return { kind: 'COMMITTED_EXACT', alreadyCommitted: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: evidence.batchIdentity });
    if (result.kind !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact delete evidence');
    return Object.freeze({
      status: 'COMMITTED_EXACT', alreadyCommitted: result.alreadyCommitted,
      batchIdentity: evidence.batchIdentity, rowCount: evidence.rowCount, payloadHash: evidence.payloadHash,
      deleted: evidence.rowCount
    });
  }

  async truncateTarget(input = {}) {
    this.#assertOpen();
    const migrationId = requiredString('migrationId', input.migrationId);
    const planId = requiredHash('planId', input.planId);
    const sourceSnapshotId = requiredHash('sourceSnapshotId', input.sourceSnapshotId);
    const mappingRevision = input.mappingRevision;
    if (!Number.isInteger(mappingRevision) || mappingRevision < 1) fail('INVALID_BATCH_EVIDENCE', 'mappingRevision must be >= 1');
    if (this.requireFencing && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)) fail('FENCE_REQUIRED', 'Production PostgreSQL mutation requires a fencing token');

    const result = await withPostgresClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker }, async client => {
      await client.query('BEGIN');
      try {
        if (this.requireFencing) {
          await checkRepairFence(client, this, input.fencingToken, 'truncate');
        }

        await checkRepairContract(client, this, input.targetContractId ?? null, 'planning/approval');

        const liveContractId = await postgresTargetContractId(client, this.targetRef);
        const approvalId = assertTruncateApproval({ approval: input.approval, migrationId, liveContractId });
        const described = postgresTruncateEvidence({
          database: this.targetRef.database, schema: this.targetRef.schema, table: this.targetRef.table,
          targetContractId: liveContractId, approvalId
        });
        const evidence = {
          batchIdentity: requiredHash('batchIdentity', input.batchIdentity),
          migrationId, planId, sourceSnapshotId, mappingRevision,
          rowCount: described.rowCount, payloadHash: described.payloadHash
        };

        const existing = await findLedgerEntry(client, this.targetRef, evidence.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, evidence, this.targetRef)) {
            await client.query('ROLLBACK');
            return { kind: 'BATCH_IDENTITY_CONFLICT' };
          }
          await client.query('COMMIT');
          return { kind: 'TRUNCATED_EXACT', alreadyCommitted: true, approvalId };
        }

        await client.query(`TRUNCATE ${quoteIdentifier(this.targetRef.schema)}.${quoteIdentifier(this.targetRef.table)}`);
        const verified = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdentifier(this.targetRef.schema)}.${quoteIdentifier(this.targetRef.table)}`);
        if (verified.rows[0]?.n !== 0) {
          await client.query('ROLLBACK');
          fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL truncate did not leave an empty table');
        }
        await insertLedgerEntry(client, this.targetRef, evidence);
        await client.query('COMMIT');
        return { kind: 'TRUNCATED_EXACT', alreadyCommitted: false, approvalId };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
        throw error;
      }
    });

    if (result.kind === 'BATCH_IDENTITY_CONFLICT') fail('BATCH_IDENTITY_CONFLICT', 'Batch identity is already committed with different evidence', { batchIdentity: input.batchIdentity });
    if (result.kind !== 'TRUNCATED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL target did not return exact truncate evidence');
    return Object.freeze({ status: 'TRUNCATED_EXACT', alreadyCommitted: result.alreadyCommitted, batchIdentity: input.batchIdentity, approvalId: result.approvalId });
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
