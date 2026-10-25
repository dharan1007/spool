import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowflakeWireServer } from '../src/connectors/snowflake/wire-server.js';
import { BigQueryWireServer } from '../src/connectors/bigquery/wire-server.js';
import { createSnowflakeRuntime } from '../src/connectors/snowflake/index.js';
import { createBigQueryRuntime } from '../src/connectors/bigquery/index.js';

test('Snowflake Live Network Wire Staging: Real HTTP/REST Execution', async () => {
  const server = new SnowflakeWireServer();
  server.seedTable('ANALYTICS', 'PUBLIC', 'CUSTOMERS', [
    { name: 'CUSTOMER_ID', type: 'NUMBER', nullable: false },
    { name: 'FULL_NAME', type: 'VARCHAR', nullable: true },
    { name: 'ACCOUNT_TIER', type: 'VARCHAR', nullable: true }
  ], ['CUSTOMER_ID']);

  const endpoint = await server.start();
  assert.ok(endpoint.startsWith('http://127.0.0.1:'));

  try {
    const targetRef = {
      account: 'acct-staging',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
      table: 'CUSTOMERS',
      endpoint,
      token: 'spool-wire-test-token'
    };
    const targetSchema = [
      { name: 'CUSTOMER_ID', type: 'integer' },
      { name: 'FULL_NAME', type: 'string' },
      { name: 'ACCOUNT_TIER', type: 'string' }
    ];

    const sf = createSnowflakeRuntime();

    // 1. Live Preflight over Network
    const preflight = await sf.preflight({ targetRef, targetSchema });
    assert.ok(preflight.targetContractId.startsWith('sha256:'));
    assert.equal(preflight.primaryKey[0], 'CUSTOMER_ID');

    // 2. Live Batch Commit over Network
    const target = sf.createTarget({ targetRef });
    const rows = [
      { CUSTOMER_ID: 101, FULL_NAME: 'Alice Corp', ACCOUNT_TIER: 'ENTERPRISE' },
      { CUSTOMER_ID: 102, FULL_NAME: 'Bob Systems', ACCOUNT_TIER: 'PRO' }
    ];
    const commitRes = await target.commitBatch({
      batchIdentity: 'batch_sf_net_01',
      migrationId: 'mig_sf_net',
      planId: 'plan_sf_net',
      rows,
      fencingToken: 1
    });
    assert.equal(commitRes.status, 'COMMITTED');
    assert.equal(commitRes.writtenRows, 2);

    // 3. Live Crash Recovery Reconciliation over Network
    const reconcile = await target.reconcileTargetCommit({
      batchIdentity: 'batch_sf_net_01',
      payloadHash: commitRes.payloadHash
    });
    assert.equal(reconcile.status, 'COMMITTED_EXACT');
    assert.equal(reconcile.rowCount, 2);

    // 4. Live Content Verification over Network
    const verifyRes = await sf.verifyContent({
      targetRef,
      expectedRows: rows,
      targetSchema,
      targetContractId: preflight.targetContractId,
      primaryKey: ['CUSTOMER_ID']
    });
    assert.equal(verifyRes.status, 'VERIFIED');
    assert.equal(verifyRes.diff.total, 0);

    // 5. Live Stale Fencing Token Rejection over Network
    server.setLease('mig_sf_net_fence', 5);
    const fencedTarget = sf.createTarget({
      targetRef,
      requireFencing: true,
      fenceResource: 'mig_sf_net_fence'
    });
    // Token 4 is stale -> rejected
    await assert.rejects(
      () => fencedTarget.commitBatch({ batchIdentity: 'batch_stale', rows: [], fencingToken: 4 }),
      /STALE_FENCE/
    );
    // Token 5 is valid -> accepted
    const validFence = await fencedTarget.commitBatch({ batchIdentity: 'batch_valid', rows: [], fencingToken: 5 });
    assert.equal(validFence.status, 'COMMITTED');

    // Verify real network requests were captured by the wire server
    assert.ok(server.requests.length >= 5);
    const firstReq = server.requests[0];
    assert.equal(firstReq.path, '/api/v2/statements');
    assert.equal(firstReq.headers['authorization'], 'Bearer spool-wire-test-token');
  } finally {
    await server.stop();
  }
});

test('BigQuery Live Network Wire Staging: Real HTTP/REST Execution', async () => {
  const server = new BigQueryWireServer();
  server.seedTable('spool-gcp-prod', 'warehouse', 'transactions', [
    { name: 'tx_id', type: 'INT64', nullable: false },
    { name: 'amount', type: 'STRING', nullable: true }
  ]);

  const endpoint = await server.start();
  assert.ok(endpoint.startsWith('http://127.0.0.1:'));

  try {
    const targetRef = {
      projectId: 'spool-gcp-prod',
      datasetId: 'warehouse',
      tableId: 'transactions',
      endpoint,
      token: 'spool-bq-oauth-token'
    };
    const targetSchema = [
      { name: 'tx_id', type: 'integer' },
      { name: 'amount', type: 'string' }
    ];

    const bq = createBigQueryRuntime();

    // 1. Live Preflight over Network
    const preflight = await bq.preflight({ targetRef, targetSchema });
    assert.ok(preflight.targetContractId.startsWith('sha256:'));

    // 2. Live Batch Commit over Network
    const target = bq.createTarget({ targetRef });
    const rows = [
      { tx_id: 501, amount: '12500.50' },
      { tx_id: 502, amount: '899.00' }
    ];
    const commitRes = await target.commitBatch({
      batchIdentity: 'batch_bq_net_01',
      migrationId: 'mig_bq_net',
      planId: 'plan_bq_net',
      rows,
      fencingToken: 1
    });
    assert.equal(commitRes.status, 'COMMITTED_EXACT');
    assert.equal(commitRes.writtenRows, 2);

    // 3. Live Crash Recovery Reconciliation over Network
    const reconcile = await target.reconcileTargetCommit({
      batchIdentity: 'batch_bq_net_01',
      payloadHash: commitRes.payloadHash
    });
    assert.equal(reconcile.status, 'COMMITTED_EXACT');
    assert.equal(reconcile.rowCount, 2);

    // 4. Live Content Verification over Network
    const verifyRes = await bq.verifyContent({
      targetRef,
      expectedRows: rows,
      targetSchema,
      targetContractId: preflight.targetContractId,
      primaryKey: ['tx_id']
    });
    assert.equal(verifyRes.status, 'VERIFIED');
    assert.equal(verifyRes.diff.total, 0);

    // 5. Live Stale Fencing Token Rejection over Network
    server.setLease('mig_bq_net_fence', 10);
    const fencedTarget = bq.createTarget({
      targetRef,
      requireFencing: true,
      fenceResource: 'mig_bq_net_fence'
    });
    // Token 9 is stale
    await assert.rejects(
      () => fencedTarget.commitBatch({ batchIdentity: 'batch_bq_stale', rows: [], fencingToken: 9 }),
      /STALE_FENCE/
    );
    // Token 10 is valid
    const validFence = await fencedTarget.commitBatch({ batchIdentity: 'batch_bq_valid', rows: [], fencingToken: 10 });
    assert.equal(validFence.status, 'COMMITTED_EXACT');

    // Verify real network requests were captured by the wire server
    assert.ok(server.requests.length >= 5);
    const firstReq = server.requests[0];
    assert.ok(firstReq.path.includes('/queries'));
    assert.equal(firstReq.headers['authorization'], 'Bearer spool-bq-oauth-token');
  } finally {
    await server.stop();
  }
});
