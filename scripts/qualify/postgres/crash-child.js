#!/usr/bin/env node
// Child driver for crash-recovery real OS kill proof.
// Runs a batched Postgres COPY/commit loop with durable checkpoint and ledger,
// pacing between batches so parent can SIGKILL mid-flight.
// Config via --config <jsonPath> (contains pgConfig, table, migrationId, etc.)
// Signals readiness via stdout line "CRASH_CHILD_READY" then per-batch "BATCH_COMMITTED <n>".

import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { createPostgresTargetRuntime } from '../../../src/connectors/postgres/runtime.js';
import { MigrationRunner } from '../../../src/execution/migration-runner.js';
import { generateRow } from '../dataset.js';

function parseArgs() {
  const idx = process.argv.indexOf('--config');
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('crash-child: --config <path> required');
    process.exit(2);
  }
  return process.argv[idx + 1];
}

async function main() {
  const configPath = parseArgs();
  const raw = await readFile(configPath, 'utf8');
  const cfg = JSON.parse(raw);

  const { pgConfig, table, migrationId, planId, sourceSnapshotId, mappingRevision, batchSize, rowCount, payloadBytes, seed, targetContractId } = cfg;
  const endpoint = `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`;
  const targetRef = {
    connector: 'postgres',
    connectionId: 'pg',
    resource: `public.${table}`,
    endpoint,
    database: pgConfig.database,
    schema: 'public',
    table,
    identity: { user: pgConfig.user },
    secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' }
  };

  const broker = new CredentialBroker();
  broker.withSecret = async (ref, fn) => fn(pgConfig.password);
  const runtime = createPostgresTargetRuntime({ credentialBroker: broker, leaseTtlMs: cfg.leaseTtlMs });
  const execution = runtime.createExecution({ migrationId, targetRef });
  const lease = await execution.renewLease();
  const target = execution.openTarget();

  // File-backed checkpoint store: parent shares the same file path via cfg.checkpointPath
  // We use a simple JSON file checkpoint for this child->parent proof (durable across kill).
  // The parent will read same file after kill to verify checkpoint persistence.
  const { checkpointPath } = cfg;
  const checkpointStore = {
    _path: checkpointPath,
    async load() {
      try {
        const data = await readFile(checkpointPath, 'utf8');
        return JSON.parse(data);
      } catch {
        return null;
      }
    },
    async save(cp) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(checkpointPath), { recursive: true });
      await writeFile(checkpointPath, JSON.stringify(cp), 'utf8');
    }
  };

  const runner = new MigrationRunner({ target, checkpointStore });

  // Signal ready (parent waits for this before polling ledger)
  process.stdout.write(`CRASH_CHILD_READY ${JSON.stringify(lease)}\n`);

  const totalBatches = Math.ceil(rowCount / batchSize);
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const endExclusive = Math.min(rowCount, start + batchSize);
    const rows = [];
    for (let id = start + 1; id <= endExclusive; id += 1) {
      const r = generateRow(seed, id, { payloadBytes });
      // Map to target schema (id, payload) like qualification does
      rows.push({ id: r.id, payload: r.payload });
    }
    const input = {
      migrationId,
      planId,
      sourceSnapshotId,
      mappingRevision,
      sourceRange: { start, endExclusive },
      targetIdentity: targetRef,
      targetContractId,
      rows,
      fencingToken: lease.fencingToken,
      bulk: false
    };
    // For the first batch, inject a fault-after-commit only if cfg.faultAfterCommitBatch == batchIndex
    // But for real kill test, we want normal commits; the kill will happen mid-loop.
    // So just runBatchAsync normally; checkpoint is saved after each batch.
    await runner.runBatchAsync(input);
    process.stdout.write(`BATCH_COMMITTED ${endExclusive}\n`);
    // Pace to give parent a window to kill mid-flight (predicate-driven pacing, not time-assumed for evidence)
    // 30ms between batches ensures kill can land between batches 1 and 2 for CI scale.
    await new Promise(resolve => setTimeout(resolve, 30));
  }

  await execution.close();
  process.stdout.write('CRASH_CHILD_DONE\n');
  process.exit(0);
}

main().catch(err => {
  console.error('crash-child fatal', err);
  process.exit(1);
});
