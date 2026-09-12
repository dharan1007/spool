import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { withPostgresClient } from './connection.js';
import { POSTGRES_METADATA_SCHEMA, postgresTargetContractId } from './preflight.js';

const LEDGER_TABLE = 'batch_ledger';
const LEASE_TABLE = 'execution_leases';
const PAYLOAD_DOMAIN = 'spool-postgres-batch-payload-v1';
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
    return metadataDescription(client);
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

  close() { this.closed = true; }
}
