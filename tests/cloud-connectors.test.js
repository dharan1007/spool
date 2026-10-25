import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnowflakeRuntime } from '../src/connectors/snowflake/index.js';
import { createBigQueryRuntime } from '../src/connectors/bigquery/index.js';

function createMockSnowflakeClient() {
  const tables = new Map();
  const ledger = new Map();
  const leases = new Map();

  return {
    query: async (sql, binds = []) => {
      const trimmed = sql.trim().toUpperCase();

      // Information Schema
      if (trimmed.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return {
          rows: [
            { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO' },
            { COLUMN_NAME: 'VAL', DATA_TYPE: 'VARCHAR', IS_NULLABLE: 'YES' }
          ]
        };
      }

      // Show PK
      if (trimmed.startsWith('SHOW PRIMARY KEYS')) {
        return { rows: [{ COLUMN_NAME: 'ID' }] };
      }

      // Create Schema / Table DDL
      if (trimmed.startsWith('CREATE SCHEMA') || trimmed.startsWith('CREATE TABLE')) {
        return { rows: [] };
      }

      // Begin / Commit / Rollback
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(trimmed)) {
        return { rows: [] };
      }

      // Query Leases
      if (trimmed.includes('FROM "ANALYTICS"."SPOOL_INTERNAL"."SPOOL_EXECUTION_LEASES"')) {
        const resource = binds[0];
        const val = leases.get(resource);
        return { rows: val ? [val] : [] };
      }

      // Insert Ledger
      if (trimmed.includes('INSERT INTO "ANALYTICS"."SPOOL_INTERNAL"."SPOOL_BATCH_LEDGER"')) {
        const [batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token] = binds;
        ledger.set(batch_identity, {
          BATCH_IDENTITY: batch_identity,
          MIGRATION_ID: migration_id,
          ROW_COUNT: row_count,
          PAYLOAD_HASH: payload_hash,
          FENCING_TOKEN: fencing_token,
          COMMITTED_AT: new Date().toISOString()
        });
        return { rows: [] };
      }

      // Query Ledger
      if (trimmed.includes('FROM "ANALYTICS"."SPOOL_INTERNAL"."SPOOL_BATCH_LEDGER"')) {
        const batch_identity = binds[0];
        const row = ledger.get(batch_identity);
        return { rows: row ? [row] : [] };
      }

      // Insert Target
      if (trimmed.includes('INSERT INTO "ANALYTICS"."PUBLIC"."USERS"')) {
        const [id, val] = binds;
        tables.set(id, { ID: id, VAL: val });
        return { rows: [] };
      }

      // Select Target Content
      if (trimmed.includes('FROM "ANALYTICS"."PUBLIC"."USERS"')) {
        const rows = Array.from(tables.values()).map(r => ({ ID: r.ID, VAL: r.VAL }));
        return { rows };
      }

      return { rows: [] };
    },
    setLease(resource, token) {
      leases.set(resource, { FENCING_TOKEN: token, EXPIRES_AT_MS: Date.now() + 60000 });
    }
  };
}

function createMockBigQueryClient() {
  const tables = new Map();
  const ledger = new Map();
  const leases = new Map();

  return {
    query: async (sql, binds = []) => {
      const trimmed = sql.trim().toUpperCase();

      if (trimmed.startsWith('/* SPOOL_BIGQUERY_ATOMIC_V2 */')) {
        assert.match(sql, /BEGIN TRANSACTION/);
        assert.match(sql, /DELETE FROM [^;]+ WHERE FALSE/);
        assert.match(sql, /COMMIT TRANSACTION/);
        const [batchIdentity, , expectedHash, expectedCount, expectedMigration, expectedPlan] = binds;
        const [ledgerId, migrationId, planId, rowCount, payloadHash, fencingToken] = binds.slice(-6);
        assert.equal(batchIdentity, ledgerId);
        assert.equal(expectedHash, payloadHash);
        assert.equal(expectedCount, rowCount);
        assert.equal(expectedMigration, migrationId);
        assert.equal(expectedPlan, planId);
        const earlier = ledger.get(batchIdentity);
        if (earlier) {
          assert.equal(earlier.payload_hash, payloadHash);
          assert.equal(earlier.commit_protocol, 'SPOOL_ATOMIC_V2');
          return { rows: [] };
        }
        let pos = 6;
        if (sql.includes('expires_at_ms > UNIX_MILLIS')) {
          const resource = binds[pos++];
          const suppliedToken = binds[pos++];
          if (Number(leases.get(resource)?.fencing_token) !== Number(suppliedToken)) {
            throw new Error('STALE_FENCE');
          }
        }
        const rowValues = binds.slice(pos, -6);
        const stagedRows = [];
        for (let i = 0; i < Number(rowCount); i++) {
          stagedRows.push({ id: rowValues[2 * i], val: rowValues[2 * i + 1] });
        }
        assert.equal(rowValues.length, 2 * Number(rowCount));
        for (const row of stagedRows) tables.set(row.id, row);
        ledger.set(batchIdentity, {
          batch_identity: batchIdentity, migration_id: migrationId, plan_id: planId,
          row_count: Number(rowCount), payload_hash: payloadHash, fencing_token: Number(fencingToken),
          commit_protocol: 'SPOOL_ATOMIC_V2', committed_at: new Date().toISOString()
        });
        return { rows: [] };
      }

      if (trimmed.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return {
          rows: [
            { column_name: 'id', data_type: 'INT64', is_nullable: 'NO' },
            { column_name: 'val', data_type: 'STRING', is_nullable: 'YES' }
          ]
        };
      }

      if (trimmed.startsWith('CREATE SCHEMA') || trimmed.startsWith('CREATE TABLE')) {
        return { rows: [] };
      }

      if (trimmed.includes('FROM `MY-GCP-PROJ._SPOOL_METADATA._SPOOL_EXECUTION_LEASES`')) {
        const resource = binds[0];
        const val = leases.get(resource);
        return { rows: val ? [val] : [] };
      }

      if (trimmed.includes('INSERT INTO `MY-GCP-PROJ._SPOOL_METADATA._SPOOL_BATCH_LEDGER`')) {
        const [batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token] = binds;
        ledger.set(batch_identity, {
          batch_identity,
          migration_id,
          row_count,
          payload_hash,
          fencing_token,
          committed_at: new Date().toISOString()
        });
        return { rows: [] };
      }

      if (trimmed.includes('FROM `MY-GCP-PROJ._SPOOL_METADATA._SPOOL_BATCH_LEDGER`')) {
        const batch_identity = binds[0];
        const row = ledger.get(batch_identity);
        return { rows: row ? [row] : [] };
      }

      if (trimmed.includes('INSERT INTO `MY-GCP-PROJ.WAREHOUSE.EVENTS`')) {
        const [id, val] = binds;
        tables.set(id, { id, val });
        return { rows: [] };
      }

      if (trimmed.includes('FROM `MY-GCP-PROJ.WAREHOUSE.EVENTS`')) {
        return { rows: Array.from(tables.values()) };
      }

      return { rows: [] };
    },
    setLease(resource, token) {
      leases.set(resource, { fencing_token: token });
    }
  };
}

test('Snowflake Full Connector Lifecycle: Preflight, Commit, Reconcile, Content Verification', async () => {
  const mockClient = createMockSnowflakeClient();
  const sf = createSnowflakeRuntime({ mockClient });
  assert.equal(sf.assurance, 'C4');

  const targetRef = { account: 'org-acct', database: 'analytics', schema: 'public', table: 'users' };
  const targetSchema = [
    { name: 'ID', type: 'integer' },
    { name: 'VAL', type: 'string' }
  ];

  // 1. Preflight
  const preflight = await sf.preflight({ targetRef, targetSchema });
  assert.ok(preflight.targetContractId.startsWith('sha256:'));
  assert.equal(preflight.primaryKey[0], 'ID');

  // 2. Commit batch
  const target = sf.createTarget({ targetRef });
  const rows = [
    { ID: 1, VAL: 'alpha' },
    { ID: 2, VAL: 'beta' }
  ];
  const commitRes = await target.commitBatch({
    batchIdentity: 'sf_batch_001',
    migrationId: 'mig_sf_test',
    planId: 'plan_sf_001',
    rows
  });
  assert.equal(commitRes.status, 'COMMITTED');
  assert.equal(commitRes.writtenRows, 2);

  // 3. Crash recovery reconciliation (COMMITTED_EXACT)
  const reconcile = await target.reconcileTargetCommit({
    batchIdentity: 'sf_batch_001',
    payloadHash: commitRes.payloadHash
  });
  assert.equal(reconcile.status, 'COMMITTED_EXACT');
  assert.equal(reconcile.rowCount, 2);

  // Uncommitted batch reconciliation
  const uncommitted = await target.reconcileTargetCommit({ batchIdentity: 'sf_batch_missing' });
  assert.equal(uncommitted.status, 'NOT_COMMITTED');

  // 4. Exact Content Verification
  const verifyRes = await sf.verifyContent({
    targetRef,
    expectedRows: rows,
    targetSchema,
    targetContractId: preflight.targetContractId,
    primaryKey: ['ID']
  });
  assert.equal(verifyRes.status, 'VERIFIED');
  assert.equal(verifyRes.diff.total, 0);

  // 5. Fencing token validation
  mockClient.setLease('mig_sf_fence', 2);
  const fencedTarget = sf.createTarget({
    targetRef,
    requireFencing: true,
    fenceResource: 'mig_sf_fence'
  });
  // Token 1 is stale
  await assert.rejects(
    () => fencedTarget.commitBatch({ batchIdentity: 'sf_batch_stale', rows: [], fencingToken: 1 }),
    /STALE_FENCE/
  );
  // Token 2 is valid
  const validFenceRes = await fencedTarget.commitBatch({
    batchIdentity: 'sf_batch_valid',
    rows: [],
    fencingToken: 2
  });
  assert.equal(validFenceRes.status, 'COMMITTED');
});

test('BigQuery Full Connector Lifecycle: Preflight, Commit, Reconcile, Content Verification', async () => {
  const mockClient = createMockBigQueryClient();
  const bq = createBigQueryRuntime({ mockClient });
  assert.equal(bq.assurance, 'C4');

  const targetRef = { projectId: 'my-gcp-proj', datasetId: 'warehouse', tableId: 'events' };
  const targetSchema = [
    { name: 'id', type: 'integer' },
    { name: 'val', type: 'string' }
  ];

  // 1. Preflight
  const preflight = await bq.preflight({ targetRef, targetSchema });
  assert.ok(preflight.targetContractId.startsWith('sha256:'));

  // 2. Commit batch
  const target = bq.createTarget({ targetRef });
  const rows = [
    { id: 10, val: 'event_10' },
    { id: 20, val: 'event_20' }
  ];
  const commitRes = await target.commitBatch({
    batchIdentity: 'bq_batch_001',
    migrationId: 'mig_bq_test',
    planId: 'plan_bq_001',
    rows
  });
  assert.equal(commitRes.status, 'COMMITTED_EXACT');
  assert.equal(commitRes.writtenRows, 2);

  // 3. Crash recovery reconciliation
  const reconcile = await target.reconcileTargetCommit({
    batchIdentity: 'bq_batch_001',
    payloadHash: commitRes.payloadHash
  });
  assert.equal(reconcile.status, 'COMMITTED_EXACT');
  assert.equal(reconcile.rowCount, 2);

  // 4. Exact Content Verification
  const verifyRes = await bq.verifyContent({
    targetRef,
    expectedRows: rows,
    targetSchema,
    targetContractId: preflight.targetContractId,
    primaryKey: ['id']
  });
  assert.equal(verifyRes.status, 'VERIFIED');
  assert.equal(verifyRes.diff.total, 0);

  // 5. Fencing token validation
  mockClient.setLease('mig_bq_fence', 5);
  const fencedTarget = bq.createTarget({
    targetRef,
    requireFencing: true,
    fenceResource: 'mig_bq_fence'
  });
  // Token 4 is stale
  await assert.rejects(
    () => fencedTarget.commitBatch({ batchIdentity: 'bq_batch_stale', rows: [], fencingToken: 4 }),
    /STALE_FENCE/
  );
  // Token 5 is valid
  const validFenceRes = await fencedTarget.commitBatch({
    batchIdentity: 'bq_batch_valid',
    rows: [],
    fencingToken: 5
  });
  assert.equal(validFenceRes.status, 'COMMITTED_EXACT');
});
