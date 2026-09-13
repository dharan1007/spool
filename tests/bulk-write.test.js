import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createMigrationPlan } from '../src/platform/plan.js';
import { MigrationRunner } from '../src/execution/migration-runner.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { createPostgresTargetRuntime } from '../src/connectors/postgres/runtime.js';
import { CredentialBroker } from '../src/daemon/credential-broker.js';

const baseInput = (writeStrategy) => ({
  planRevision: 1,
  sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: '/tmp/rows.csv' },
  targetRef: { connector: 'postgres', connectionId: 'dst', resource: 'public.rows', endpoint: 'postgresql://127.0.0.1:5432/?sslmode=disable', database: 'db', schema: 'public', table: 'rows', identity: { user: 'u' }, secretRef: { provider: 'env', key: 'K' } },
  targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
  mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }],
  mappingRevision: 1,
  writeStrategy,
  verification: { checks: ['row_accounting'] },
  risk: { level: 'low', approvals: [] },
  capabilityAssumptions: { source: {}, target: {} }
});

test('bulk write strategy flag is validated centrally and bound into plan identity', async () => {
  for (const bulk of [true, false, undefined]) {
    const plan = await createMigrationPlan(baseInput({ mode: 'insert', batchSize: 10, ...(bulk === undefined ? {} : { bulk }) }));
    assert.equal(plan.writeStrategy.bulk ?? false, bulk ?? false);
  }
  await assert.rejects(() => createMigrationPlan(baseInput({ mode: 'insert', batchSize: 10, bulk: 'yes' })), /INVALID_WRITE_STRATEGY/);
  const rowPath = await createMigrationPlan(baseInput({ mode: 'insert', batchSize: 10 }));
  const bulkPath = await createMigrationPlan(baseInput({ mode: 'insert', batchSize: 10, bulk: true }));
  assert.notEqual(rowPath.planId, bulkPath.planId);
});

test('bulk approval effects advertise the COPY write only for bulk plans', () => {
  const runtime = createPostgresTargetRuntime({ credentialBroker: new CredentialBroker() });
  const rowEffects = runtime.approvalEffects({ risk: { approvals: [] }, verification: { checks: [] }, writeStrategy: { mode: 'insert', batchSize: 2 } });
  assert.ok(!rowEffects.includes('postgres:bulk_copy_write'));
  const bulkEffects = runtime.approvalEffects({ risk: { approvals: [] }, verification: { checks: [] }, writeStrategy: { mode: 'insert', batchSize: 2, bulk: true } });
  assert.ok(bulkEffects.includes('postgres:bulk_copy_write'));
  assert.ok(bulkEffects.includes('postgres:insert_rows'));
});

function fakeTarget({ bulk = false } = {}) {
  const calls = [];
  const target = {
    calls,
    describeBatch: () => ({ rowCount: 1, payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    reconcileTargetCommit: () => ({ status: 'NOT_COMMITTED' }),
    commitBatch: input => {
      calls.push({ method: 'commitBatch', bulk: input.bulk });
      return { status: 'COMMITTED_EXACT', rowCount: 1, payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    }
  };
  if (bulk) {
    target.commitBulkBatch = input => {
      calls.push({ method: 'commitBulkBatch', bulk: input.bulk });
      return { status: 'COMMITTED_EXACT', rowCount: 1, payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    };
  }
  return target;
}

function memoryCheckpoints() {
  let stored = null;
  return { load: () => stored, save: checkpoint => { stored = checkpoint; } };
}

function batchInput(bulk) {
  return {
    migrationId: 'bulk_runner_001',
    planId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    sourceSnapshotId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    mappingRevision: 1,
    sourceRange: { start: 0, endExclusive: 1 },
    targetIdentity: { connector: 'postgres', resource: 'public.rows' },
    rows: [{ id: 1 }],
    bulk
  };
}

test('migration runner routes bulk batches to the COPY path and refuses bulk without target support', () => {
  const rowTarget = fakeTarget();
  const rowResult = new MigrationRunner({ target: rowTarget, checkpointStore: memoryCheckpoints() }).runBatch(batchInput(false));
  assert.equal(rowResult.status, 'COMMITTED_EXACT');
  assert.deepEqual(rowTarget.calls.map(call => call.method), ['commitBatch']);

  const bulkTarget = fakeTarget({ bulk: true });
  new MigrationRunner({ target: bulkTarget, checkpointStore: memoryCheckpoints() }).runBatch(batchInput(true));
  assert.deepEqual(bulkTarget.calls.map(call => call.method), ['commitBulkBatch']);
  assert.equal(bulkTarget.calls[0].bulk, true);

  assert.throws(
    () => new MigrationRunner({ target: fakeTarget(), checkpointStore: memoryCheckpoints() }).runBatch(batchInput(true)),
    error => error?.code === 'BULK_COMMIT_UNSUPPORTED'
  );
});

test('bulk writes fail closed on connectors without bulk COPY support before any mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-bulk-refusal-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  await writeFile(sourcePath, 'id,name\n1,Ada\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-bulk-test', commitSha: '6123456789abcdef0123456789abcdef01234567' }
  });
  try {
    const request = {
      migrationId: 'bulk_sqlite_refused',
      principal: 'operator:bulk',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: sourcePath },
        targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'rows', path: targetPath, table: 'rows' },
        targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: 2, bulk: true },
        verification: { checks: ['row_accounting', 'ledger_complete'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: {
          source: { snapshotBinding: true },
          target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
        }
      }
    };
    await assert.rejects(() => service.inspect(request), error => error?.code === 'BULK_WRITE_CAPABILITY_REQUIRED');
    const check = new Database(targetPath, { readonly: true });
    try {
      assert.equal(Number(check.prepare('SELECT COUNT(*) AS n FROM rows').get().n), 0);
    } finally { check.close(); }
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
