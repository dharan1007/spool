import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizeBigQueryRef, escapeBigQueryTable, withBigQueryClient } from './connection.js';

const METADATA_DATASET = '_spool_metadata';
const LEDGER_TABLE = '_spool_batch_ledger';
const LEASE_TABLE = '_spool_execution_leases';
const PAYLOAD_DOMAIN = 'spool-bigquery-batch-v1';

export function bigqueryPayloadEvidence(rows) {
  if (!Array.isArray(rows)) fail('INVALID_BATCH_ROWS', 'Batch rows must be an array');
  const payloadHash = sha256Canonical(PAYLOAD_DOMAIN, rows);
  return Object.freeze({ rowCount: rows.length, payloadHash });
}

export async function ensureBigQueryMetadata(client, projectId) {
  const metaTable = `\`${projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;
  const leaseTable = `\`${projectId}.${METADATA_DATASET}.${LEASE_TABLE}\``;

  await client.query(`CREATE SCHEMA IF NOT EXISTS \`${projectId}.${METADATA_DATASET}\``);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      batch_identity STRING NOT NULL,
      migration_id STRING NOT NULL,
      plan_id STRING NOT NULL,
      row_count INT64 NOT NULL,
      payload_hash STRING NOT NULL,
      fencing_token INT64 NOT NULL,
      committed_at TIMESTAMP NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${leaseTable} (
      resource STRING NOT NULL,
      owner STRING NOT NULL,
      fencing_token INT64 NOT NULL,
      expires_at_ms INT64 NOT NULL
    )
  `);
}

export class BigQueryTarget {
  constructor({ targetRef, credentialBroker, mockClient = null, requireFencing = false, fenceResource = null, fenceOwner = null } = {}) {
    this.targetRef = normalizeBigQueryRef(targetRef);
    this.credentialBroker = credentialBroker;
    this.mockClient = mockClient;
    this.requireFencing = requireFencing;
    this.fenceResource = fenceResource;
    this.fenceOwner = fenceOwner;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('BIGQUERY_TARGET_CLOSED', 'BigQuery target is closed');
  }

  describeBatch(input = {}) {
    this.#assertOpen();
    return bigqueryPayloadEvidence(input.rows ?? []);
  }

  async reconcileTargetCommit(input = {}) {
    this.#assertOpen();
    const batchIdentity = input.batchIdentity;
    if (!batchIdentity) fail('INVALID_BATCH_EVIDENCE', 'batchIdentity is required for reconciliation');

    return await withBigQueryClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      await ensureBigQueryMetadata(client, this.targetRef.projectId);
      const metaTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;

      const res = await client.query(`
        SELECT batch_identity, migration_id, row_count, payload_hash, committed_at
        FROM ${metaTable}
        WHERE batch_identity = ?
        LIMIT 1
      `, [batchIdentity]);

      const row = res.rows?.[0];
      if (!row) {
        return Object.freeze({ status: 'NOT_COMMITTED', batchIdentity });
      }

      if (input.payloadHash && input.payloadHash !== row.payload_hash) {
        return Object.freeze({ status: 'CONFLICT', batchIdentity });
      }

      return Object.freeze({
        status: 'COMMITTED_EXACT',
        batchIdentity,
        rowCount: Number(row.row_count),
        payloadHash: row.payload_hash,
        committedAt: new Date(row.committed_at).toISOString()
      });
    });
  }

  async commitBatch(input = {}) {
    this.#assertOpen();
    const { batchIdentity, migrationId, planId, rows = [], fencingToken = 1 } = input;
    if (!batchIdentity) fail('INVALID_BATCH_INPUT', 'batchIdentity is required');

    const evidence = this.describeBatch({ rows });

    return await withBigQueryClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      await ensureBigQueryMetadata(client, this.targetRef.projectId);
      const targetTable = escapeBigQueryTable(this.targetRef);
      const metaTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEDGER_TABLE}\``;
      const leaseTable = `\`${this.targetRef.projectId}.${METADATA_DATASET}.${LEASE_TABLE}\``;

      // 1. Fencing Token Check if required
      if (this.requireFencing && this.fenceResource) {
        const leaseRes = await client.query(`
          SELECT fencing_token FROM ${leaseTable} WHERE resource = ? LIMIT 1
        `, [this.fenceResource]);
        const currentToken = Number(leaseRes.rows?.[0]?.fencing_token ?? 0);
        if (currentToken !== fencingToken) {
          fail('STALE_FENCE', `BigQuery fencing token ${fencingToken} does not match active lease ${currentToken}`);
        }
      }

      // 2. Commit batch rows
      if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        const colList = columns.map(c => `\`${c}\``).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        for (const row of rows) {
          const vals = columns.map(c => row[c]);
          await client.query(`INSERT INTO ${targetTable} (${colList}) VALUES (${placeholders})`, vals);
        }
      }

      // 3. Commit batch ledger entry
      await client.query(`
        INSERT INTO ${metaTable} (batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())
      `, [batchIdentity, migrationId || 'unknown', planId || 'unknown', evidence.rowCount, evidence.payloadHash, fencingToken]);

      return Object.freeze({
        status: 'COMMITTED',
        batchIdentity,
        writtenRows: evidence.rowCount,
        payloadHash: evidence.payloadHash
      });
    });
  }

  async truncateTarget() {
    this.#assertOpen();
    return await withBigQueryClient({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, mockClient: this.mockClient }, async client => {
      const targetTable = escapeBigQueryTable(this.targetRef);
      await client.query(`TRUNCATE TABLE ${targetTable}`);
      return Object.freeze({ status: 'TRUNCATED' });
    });
  }

  close() {
    this.closed = true;
  }
}
