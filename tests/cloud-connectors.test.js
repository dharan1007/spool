import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnowflakeRuntime } from '../src/connectors/snowflake/index.js';
import { createBigQueryRuntime } from '../src/connectors/bigquery/index.js';

test('Snowflake runtime preflight and batch commit', async () => {
  const sf = createSnowflakeRuntime();
  assert.equal(sf.assurance, 'C4');

  const preflight = sf.preflight({
    targetRef: { account: 'org-acct', database: 'analytics', schema: 'public', table: 'users' },
    targetSchema: [{ name: 'id', type: 'integer' }]
  });
  assert.ok(preflight.targetContractId.includes('sf_org-acct_users'));

  const target = sf.createTarget({ targetRef: { account: 'org-acct' } });
  const result = await target.commitBatch({ batchIdentity: 'batch_1', rows: [{ id: 1 }, { id: 2 }] });
  assert.equal(result.status, 'COMMITTED');
  assert.equal(result.writtenRows, 2);
});

test('BigQuery runtime preflight and batch commit', async () => {
  const bq = createBigQueryRuntime();
  assert.equal(bq.assurance, 'C4');

  const preflight = bq.preflight({
    targetRef: { projectId: 'my-gcp-proj', datasetId: 'warehouse', tableId: 'events' },
    targetSchema: [{ name: 'ts', type: 'string' }]
  });
  assert.ok(preflight.targetContractId.includes('bq_my-gcp-proj_warehouse_events'));

  const target = bq.createTarget({ targetRef: { projectId: 'my-gcp-proj' } });
  const result = await target.commitBatch({ batchIdentity: 'batch_bq_1', rows: [{ ts: '2026-10-24' }] });
  assert.equal(result.status, 'COMMITTED');
  assert.equal(result.writtenRows, 1);
});
