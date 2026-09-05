import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { createCapabilityBoundMigrationPlan } from '../src/platform/plan.js';

const BASIC_PLAN = Object.freeze({
  planId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  planRevision: 1
});

function migrationInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:lease-recovery-source' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
    ],
    writeStrategy: { mode: 'create_insert', batchSize: 1 },
    verification: { checks: ['target_count', 'schema'] },
    risk: { level: 'low', approvals: [] }
  };
}

function registry() {
  const value = new ConnectorRegistry();
  value.register('filesystem', config => new FilesystemConnector(config));
  value.register('sqlite', config => new SQLiteConnector(config));
  return value;
}

async function makePlan(targetDb) {
  return createCapabilityBoundMigrationPlan(migrationInput(), {
    sourceManifest: new FilesystemConnector({ root: '/tmp' }).manifest(),
    targetManifest: new SQLiteConnector({ database: targetDb }).manifest(),
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
}

test('execution lease renewal preserves epoch, advances stateVersion, and rejects the wrong owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-renew-'));
  try {
    const store = new SQLiteJobStore({ stateDir: root });
    const created = await store.create(BASIC_PLAN);
    const acquired = await store.acquireExecution(created.jobId, {
      expectedStateVersion: created.stateVersion,
      ownerId: 'runner-a',
      leaseMs: 60_000
    });

    const renewed = await store.renewExecution(acquired.jobId, {
      expectedStateVersion: acquired.stateVersion,
      expectedExecutionEpoch: acquired.executionEpoch,
      ownerId: 'runner-a',
      leaseMs: 60_000
    });

    assert.equal(renewed.executionEpoch, acquired.executionEpoch);
    assert.equal(renewed.stateVersion, acquired.stateVersion + 1);
    assert.equal(renewed.executionOwner, 'runner-a');
    assert.ok(Date.parse(renewed.executionLeaseExpiresAt) >= Date.parse(acquired.executionLeaseExpiresAt));

    await assert.rejects(
      () => store.renewExecution(renewed.jobId, {
        expectedStateVersion: renewed.stateVersion,
        expectedExecutionEpoch: renewed.executionEpoch,
        ownerId: 'runner-b',
        leaseMs: 60_000
      }),
      /owner|lease|stale/i
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired foreign lease enters fail-closed recovery instead of replaying target writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-takeover-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  try {
    await writeFile(join(root, 'customers.jsonl'), JSON.stringify({ id: '1', name: 'Ada' }) + '\n');
    const plan = await makePlan(targetDb);
    const store = new SQLiteJobStore({ stateDir });
    let job = await store.create(plan);
    job = await store.acquireExecution(job.jobId, {
      expectedStateVersion: job.stateVersion,
      ownerId: 'runner-a',
      leaseMs: 1
    });
    job = await store.update(
      job.jobId,
      current => ({ ...current, state: 'RUNNING' }),
      { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: job.executionEpoch }
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    const runner = new SharedMigrationRunner({ registry: registry(), store, ownerId: 'runner-b', leaseMs: 60_000 });
    await assert.rejects(
      () => runner.run({
        plan,
        jobId: job.jobId,
        sourceConfig: { root },
        targetConfig: { database: targetDb }
      }),
      /RECOVERY_REQUIRED|reconcil/i
    );

    const recovered = await store.load(job.jobId);
    assert.equal(recovered.state, 'RECOVERY_REQUIRED');
    assert.equal(recovered.checkpoint, null);
    assert.deepEqual(recovered.counts, { processedRows: 0, acceptedRows: 0, rejectedRows: 0 });

    const db = new DatabaseSync(targetDb);
    const tableCount = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get().count;
    db.close();
    assert.equal(Number(tableCount), 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
