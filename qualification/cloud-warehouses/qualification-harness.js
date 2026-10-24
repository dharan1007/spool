#!/usr/bin/env node
import { createSnowflakeRuntime } from '../../src/connectors/snowflake/index.js';
import { createBigQueryRuntime } from '../../src/connectors/bigquery/index.js';

/**
 * Cloud Warehouse Qualification Harness
 * Can run against mocked drivers or real live environments if credentials are provided in env:
 * - SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY
 * - GOOGLE_APPLICATION_CREDENTIALS / BIGQUERY_PROJECT_ID
 */
async function run() {
  console.log('=== SPOOL Cloud Data Warehouse Qualification ===');

  // 1. Snowflake Qualification
  const sfRuntime = createSnowflakeRuntime();
  const sfTargetRef = {
    account: process.env.SNOWFLAKE_ACCOUNT || 'sandbox-acct.us-east-1',
    database: process.env.SNOWFLAKE_DATABASE || 'SPOOL_TEST_DB',
    schema: process.env.SNOWFLAKE_SCHEMA || 'PUBLIC',
    table: 'MIGRATION_AUDIT_SAMPLE'
  };

  const sfPreflight = sfRuntime.preflight({
    targetRef: sfTargetRef,
    targetSchema: [
      { name: 'RECORD_ID', type: 'integer' },
      { name: 'PAYLOAD', type: 'string' },
      { name: 'INSERTED_AT', type: 'string' }
    ]
  });
  console.log(`[Snowflake] Contract Verified: ${sfPreflight.targetContractId}`);

  const sfTarget = sfRuntime.createTarget({ targetRef: sfTargetRef });
  const sfCommit = await sfTarget.commitBatch({
    batchIdentity: 'batch_sf_qual_001',
    rows: Array.from({ length: 1000 }, (_, i) => ({
      RECORD_ID: i + 1,
      PAYLOAD: `Payload_${i}`,
      INSERTED_AT: new Date().toISOString()
    }))
  });
  console.log(`[Snowflake] Batch Commit: ${sfCommit.status} (${sfCommit.writtenRows} rows)`);

  // 2. BigQuery Qualification
  const bqRuntime = createBigQueryRuntime();
  const bqTargetRef = {
    projectId: process.env.BIGQUERY_PROJECT_ID || 'spool-enterprise-sandbox',
    datasetId: process.env.BIGQUERY_DATASET_ID || 'warehouse_migration',
    tableId: 'events_partitioned'
  };

  const bqPreflight = bqRuntime.preflight({
    targetRef: bqTargetRef,
    targetSchema: [
      { name: 'event_id', type: 'integer' },
      { name: 'event_name', type: 'string' }
    ]
  });
  console.log(`[BigQuery] Contract Verified: ${bqPreflight.targetContractId}`);

  const bqTarget = bqRuntime.createTarget({ targetRef: bqTargetRef });
  const bqCommit = await bqTarget.commitBatch({
    batchIdentity: 'batch_bq_qual_001',
    rows: Array.from({ length: 1000 }, (_, i) => ({
      event_id: i + 1,
      event_name: `Event_${i}`
    }))
  });
  console.log(`[BigQuery] Batch Commit: ${bqCommit.status} (${bqCommit.writtenRows} rows)`);

  const results = {
    qualification: 'CLOUD_WAREHOUSE_TARGETS',
    timestamp: new Date().toISOString(),
    snowflake: {
      contract: sfPreflight.targetContractId,
      status: sfCommit.status,
      rows: sfCommit.writtenRows
    },
    bigquery: {
      contract: bqPreflight.targetContractId,
      status: bqCommit.status,
      rows: bqCommit.writtenRows
    }
  };

  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    'C:\\temp\\spool-console\\.console-evidence\\cloud-warehouse-qualification.json',
    JSON.stringify(results, null, 2) + '\n',
    'utf8'
  );
  console.log('Saved qualification results to .console-evidence/cloud-warehouse-qualification.json');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
