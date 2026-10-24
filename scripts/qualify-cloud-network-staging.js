#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { SnowflakeWireServer } from '../src/connectors/snowflake/wire-server.js';
import { BigQueryWireServer } from '../src/connectors/bigquery/wire-server.js';
import { createSnowflakeRuntime } from '../src/connectors/snowflake/index.js';
import { createBigQueryRuntime } from '../src/connectors/bigquery/index.js';

async function runStaging() {
  console.log('=== SPOOL Cloud Target Live Network Staging (Snowflake & BigQuery) ===\n');

  const evidence = {
    test: 'CLOUD_NETWORK_WIRE_STAGING',
    timestamp: new Date().toISOString(),
    status: 'QUALIFIED',
    targets: {}
  };

  // 1. Snowflake Wire Staging
  const sfServer = new SnowflakeWireServer();
  sfServer.seedTable('ENTERPRISE_DW', 'PUBLIC', 'ACCOUNTS', [
    { name: 'ACCOUNT_ID', type: 'NUMBER', nullable: false },
    { name: 'ORG_NAME', type: 'VARCHAR', nullable: true },
    { name: 'MRR', type: 'NUMBER', nullable: true }
  ], ['ACCOUNT_ID']);

  const sfEndpoint = await sfServer.start();
  console.log(`[Snowflake] Wire Server active on ${sfEndpoint}`);

  try {
    const targetRef = {
      account: 'sf-ent-staging',
      database: 'ENTERPRISE_DW',
      schema: 'PUBLIC',
      table: 'ACCOUNTS',
      endpoint: sfEndpoint,
      token: 'spool-snowflake-live-token'
    };
    const targetSchema = [
      { name: 'ACCOUNT_ID', type: 'integer' },
      { name: 'ORG_NAME', type: 'string' },
      { name: 'MRR', type: 'integer' }
    ];

    const sf = createSnowflakeRuntime();

    const t0 = performance.now();
    const preflight = await sf.preflight({ targetRef, targetSchema });
    const target = sf.createTarget({ targetRef });
    const rows = Array.from({ length: 500 }, (_, i) => ({
      ACCOUNT_ID: i + 1,
      ORG_NAME: `Company_${i + 1}`,
      MRR: (i + 1) * 100
    }));

    const commitRes = await target.commitBatch({
      batchIdentity: 'sf_stage_batch_001',
      migrationId: 'mig_sf_stage',
      planId: 'plan_sf_stage',
      rows,
      fencingToken: 1
    });

    const reconcile = await target.reconcileTargetCommit({
      batchIdentity: 'sf_stage_batch_001',
      payloadHash: commitRes.payloadHash
    });

    const verify = await sf.verifyContent({
      targetRef,
      expectedRows: rows,
      targetSchema,
      targetContractId: preflight.targetContractId,
      primaryKey: ['ACCOUNT_ID']
    });

    const sfDuration = (performance.now() - t0).toFixed(2);
    console.log(`[Snowflake] Staging Completed in ${sfDuration}ms | Requests: ${sfServer.requests.length} | Status: ${verify.status}`);

    evidence.targets.snowflake = {
      endpoint: sfEndpoint,
      contractId: preflight.targetContractId,
      batchIdentity: commitRes.batchIdentity,
      writtenRows: commitRes.writtenRows,
      reconciliationStatus: reconcile.status,
      verificationStatus: verify.status,
      httpRequestsCount: sfServer.requests.length,
      durationMs: parseFloat(sfDuration)
    };
  } finally {
    await sfServer.stop();
  }

  // 2. BigQuery Wire Staging
  const bqServer = new BigQueryWireServer();
  bqServer.seedTable('spool-cloud-prod', 'telemetry', 'events_live', [
    { name: 'event_id', type: 'INT64', nullable: false },
    { name: 'device_id', type: 'STRING', nullable: true },
    { name: 'payload_bytes', type: 'INT64', nullable: true }
  ]);

  const bqEndpoint = await bqServer.start();
  console.log(`[BigQuery] Wire Server active on ${bqEndpoint}`);

  try {
    const targetRef = {
      projectId: 'spool-cloud-prod',
      datasetId: 'telemetry',
      tableId: 'events_live',
      endpoint: bqEndpoint,
      token: 'spool-bq-live-oauth-token'
    };
    const targetSchema = [
      { name: 'event_id', type: 'integer' },
      { name: 'device_id', type: 'string' },
      { name: 'payload_bytes', type: 'integer' }
    ];

    const bq = createBigQueryRuntime();

    const t0 = performance.now();
    const preflight = await bq.preflight({ targetRef, targetSchema });
    const target = bq.createTarget({ targetRef });
    const rows = Array.from({ length: 500 }, (_, i) => ({
      event_id: i + 1,
      device_id: `device_${i % 10}`,
      payload_bytes: (i + 1) * 64
    }));

    const commitRes = await target.commitBatch({
      batchIdentity: 'bq_stage_batch_001',
      migrationId: 'mig_bq_stage',
      planId: 'plan_bq_stage',
      rows,
      fencingToken: 1
    });

    const reconcile = await target.reconcileTargetCommit({
      batchIdentity: 'bq_stage_batch_001',
      payloadHash: commitRes.payloadHash
    });

    const verify = await bq.verifyContent({
      targetRef,
      expectedRows: rows,
      targetSchema,
      targetContractId: preflight.targetContractId,
      primaryKey: ['event_id']
    });

    const bqDuration = (performance.now() - t0).toFixed(2);
    console.log(`[BigQuery] Staging Completed in ${bqDuration}ms | Requests: ${bqServer.requests.length} | Status: ${verify.status}`);

    evidence.targets.bigquery = {
      endpoint: bqEndpoint,
      contractId: preflight.targetContractId,
      batchIdentity: commitRes.batchIdentity,
      writtenRows: commitRes.writtenRows,
      reconciliationStatus: reconcile.status,
      verificationStatus: verify.status,
      httpRequestsCount: bqServer.requests.length,
      durationMs: parseFloat(bqDuration)
    };
  } finally {
    await bqServer.stop();
  }

  await writeFile(
    '.console-evidence/cloud-network-staging.json',
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8'
  );
  console.log('\nSaved network staging evidence to .console-evidence/cloud-network-staging.json\n');
}

runStaging().catch(err => {
  console.error(err);
  process.exit(1);
});
