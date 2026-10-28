import { createHash } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizeSnowflakeRef, quoteIdentifier, withSnowflakeClient } from './connection.js';

const METADATA_SCHEMA = 'SPOOL_INTERNAL';
const LEDGER_TABLE = 'SPOOL_BATCH_LEDGER';
const LEASE_TABLE = 'SPOOL_EXECUTION_LEASES';
const PAYLOAD_DOMAIN = 'spool-snowflake-batch-v1';

export function snowflakePayloadEvidence(rows) {
  if (!Array.isArray(rows)) fail('INVALID_BATCH_ROWS', 'Batch rows must be an array');
  const payloadHash = sha256Canonical(PAYLOAD_DOMAIN, rows);
  return Object.freeze({ rowCount: rows.length, payloadHash });
}

export async function ensureSnowflakeMetadata(client, database) {
  const db = quoteIdentifier(database);
  const schema = quoteIdentifier(METADATA_SCHEMA);

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${db}.${schema}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${db}.${schema}.${quoteIdentifier(LEDGER_TABLE)} (
      batch_identity VARCHAR(128) PRIMARY KEY,
      migration_id VARCHAR(128) NOT NULL,
      plan_id VARCHAR(128) NOT NULL,
      row_count INTEGER NOT NULL,
      payload_hash VARCHAR(128) NOT NULL,
      fencing_token INTEGER NOT NULL,
      committed_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${db}.${schema}.${quoteIdentifier(LEASE_TABLE)} (
      resource VARCHAR(256) PRIMARY KEY,
      owner VARCHAR(128) NOT NULL,
      fencing_token INTEGER NOT NULL,
      expires_at_ms NUMBER NOT NULL
    )
  `);
}

export class SnowflakeTarget {
  constructor({ targetRef, credentialBroker, mockClient = null, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    this.targetRef = normalizeSnowflakeRef(targetRef);
    this.credentialBroker = credentialBroker;
    this.mockClient = mockClient;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('SNOWFLAKE_TARGET_CLOSED', 'Snowflake target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return snowflakePayloadEvidence(input.rows ?? []);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    const batchIdentity = input.batchIdentity;
    if (!batchIdentity) fail('INVALID_BATCH_EVIDENCE', 'batchIdentity is required for reconciliation');

    return await withSnowflakeClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      await ensureSnowflakeMetadata(client, this.targetRef.database);
      const db = quoteIdentifier(this.targetRef.database);
      const schema = quoteIdentifier(METADATA_SCHEMA);
      const ledger = quoteIdentifier(LEDGER_TABLE);

      const res = await client.query(`
        SELECT batch_identity, migration_id, row_count, payload_hash, committed_at
        FROM ${db}.${schema}.${ledger}
        WHERE batch_identity = ?
      `, [batchIdentity]);

      const row = res.rows?.[0];
      if (!row) {
        return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity });
      }

      const rowPayloadHash = row.PAYLOAD_HASH || row.payload_hash;
      const rowCount = Number(row.ROW_COUNT || row.row_count);

      if (input.payloadHash && input.payloadHash !== rowPayloadHash) {
        return Object.freeze({ status: 'CONFLICT', batchIdentity });
      }

      return Object.freeze({
        status: 'COMMITTED_EXACT',
        batchIdentity,
        rowCount,
        payloadHash: rowPayloadHash,
        committedAt: String(row.COMMITTED_AT || row.committed_at)
      });
    });
  }

  async commitBatch(input = {}) {
    this.#assertOpen();
    const { batchIdentity, migrationId, planId, rows = [], fencingToken = 1 } = input;
    if (!batchIdentity) fail('INVALID_BATCH_INPUT', 'batchIdentity is required');

    const evidence = this.describeBatch({ rows });

    return await withSnowflakeClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      await ensureSnowflakeMetadata(client, this.targetRef.database);
      const db = quoteIdentifier(this.targetRef.database);
      const targetSchema = quoteIdentifier(this.targetRef.schema);
      const targetTable = quoteIdentifier(this.targetRef.table);
      const metaSchema = quoteIdentifier(METADATA_SCHEMA);
      const ledger = quoteIdentifier(LEDGER_TABLE);

      await client.query('BEGIN');
      try {
        // 1. Fencing Token Assertion if required
        if (this.requireFencing && this.fenceResource) {
          const leaseRes = await client.query(`
            SELECT fencing_token, expires_at_ms
            FROM ${db}.${metaSchema}.${quoteIdentifier(LEASE_TABLE)}
            WHERE resource = ?
          `, [this.fenceResource]);
          const currentToken = Number(leaseRes.rows?.[0]?.FENCING_TOKEN ?? leaseRes.rows?.[0]?.fencing_token ?? 0);
          if (currentToken !== fencingToken) {
            fail('STALE_FENCE', `Fencing token ${fencingToken} does not match active lease token ${currentToken}`);
          }
        }

        // 2. Insert Batch Rows into Target Table
        if (rows.length > 0) {
          const columns = Object.keys(rows[0]);
          const colList = columns.map(quoteIdentifier).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          for (const row of rows) {
            const vals = columns.map(c => row[c]);
            await client.query(`INSERT INTO ${db}.${targetSchema}.${targetTable} (${colList}) VALUES (${placeholders})`, vals);
          }
        }

        // 3. Record in Batch Ledger
        await client.query(`
          INSERT INTO ${db}.${metaSchema}.${ledger} (batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [batchIdentity, migrationId || 'unknown', planId || 'unknown', evidence.rowCount, evidence.payloadHash, fencingToken]);

        await client.query('COMMIT');

        return Object.freeze({
          status: 'COMMITTED',
          batchIdentity,
          writtenRows: evidence.rowCount,
          payloadHash: evidence.payloadHash
        });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      }
    });
  }

  async truncateTarget({ fencingToken = 1 } = {}) {
    this.#assertOpen();
    return await withSnowflakeClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      const db = quoteIdentifier(this.targetRef.database);
      const schema = quoteIdentifier(this.targetRef.schema);
      const table = quoteIdentifier(this.targetRef.table);
      await client.query(`TRUNCATE TABLE ${db}.${schema}.${table}`);
      return Object.freeze({ status: 'TRUNCATED' });
    });
  }

  close() {
    this.closed = true;
  }
}
