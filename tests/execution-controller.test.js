import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { ConfigStore } from '../src/daemon/config-store.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { ExecutionController, ExecutionControlledJobStore } from '../src/daemon/execution-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class BlockingSQLiteConnector extends SQLiteConnector {
  constructor(config, barrier) {
    super(config);
    this.barrier = barrier;
  }

  async write(...args) {
    this.barrier.started.resolve();
    await this.barrier.release.promise;
    return super.write(...args);
  }
}

function migrationInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:pause-source' },
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

async function fixture({ blockWrite = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spool-pause-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  await writeFile(join(root, 'customers.jsonl'), [
    JSON.stringify({ id: '1', name: ' Ada ' }),
    JSON.stringify({ id: '2', name: ' Grace ' })
  ].join('\n') + '\n');

  const barrier = { started: deferred(), release: deferred() };
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config));
  registry.register('sqlite', config => blockWrite ? new BlockingSQLiteConnector(config, barrier) : new SQLiteConnector(config));
  const configStore = new ConfigStore({ stateDir });
  const jobStore = new SQLiteJobStore({ stateDir });
  const controller = new ExecutionController();
  const controlledStore = new ExecutionControlledJobStore({ store: jobStore, controller });
  const runner = new SharedMigrationRunner({ registry, store: controlledStore, ownerId: 'pause-test', leaseMs: 60_000 });
  const service = new SpoolCommandService({ configStore, registry, jobStore, runner });
  await service.putConnection({ name: 'source', type: 'filesystem', config: { root }, secretRefs: {} });
  await service.putConnection({ name: 'target', type: 'sqlite', config: { database: targetDb }, secretRefs: {} });
  const plan = await service.createPlan({
    planInput: migrationInput(),
    sourceConnection: 'source',
    targetConnection: 'target',
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
  return { root, targetDb, barrier, jobStore, controller, runner, plan };
}

async function cleanup(value) {
  value.jobStore.close();
  await rm(value.root, { recursive: true, force: true });
}

test('pause requested before the first target mutation reaches PAUSED with no pending batch or target write', async () => {
  const value = await fixture();
  try {
    const created = await value.jobStore.create(value.plan);
    const task = value.controller.start(created.jobId, () => value.runner.run({
      plan: value.plan,
      sourceConfig: { root: value.root },
      targetConfig: { database: value.targetDb },
      jobId: created.jobId
    }));
    const result = await value.controller.requestPause(created.jobId);
    assert.strictEqual(await task, result);
    assert.equal(result.paused, true);
    assert.equal(result.job.state, 'PAUSED');
    assert.deepEqual(result.job.counts, { processedRows: 0, acceptedRows: 0, rejectedRows: 0 });
    assert.equal(result.job.pendingBatch, null);
    assert.equal(result.job.checkpoint, null);
    assert.equal(result.job.executionOwner, null);
    assert.equal(result.job.executionLeaseExpiresAt, null);
    assert.equal(new DatabaseSync(value.targetDb).prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='customers'").get().count, 0);
  } finally {
    await cleanup(value);
  }
});

test('pause requested while SQLite target write is in flight waits for commit plus checkpoint before PAUSED', async () => {
  const value = await fixture({ blockWrite: true });
  try {
    const created = await value.jobStore.create(value.plan);
    const task = value.controller.start(created.jobId, () => value.runner.run({
      plan: value.plan,
      sourceConfig: { root: value.root },
      targetConfig: { database: value.targetDb },
      jobId: created.jobId
    }));
    await value.barrier.started.promise;
    const pause = value.controller.requestPause(created.jobId);
    value.barrier.release.resolve();
    const result = await pause;
    assert.strictEqual(await task, result);
    assert.equal(result.paused, true);
    assert.equal(result.job.state, 'PAUSED');
    assert.deepEqual(result.job.counts, { processedRows: 1, acceptedRows: 1, rejectedRows: 0 });
    assert.equal(result.job.checkpoint.sourceCursor.offset, 1);
    assert.equal(result.job.pendingBatch, null);
    assert.equal(result.job.executionOwner, null);
    const db = new DatabaseSync(value.targetDb);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 1);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(value);
  }
});

test('stale execution epoch cannot consume a pause request belonging to a replacement execution', async () => {
  const controller = new ExecutionController();
  const gate = deferred();
  const task = controller.start('job-stale', async () => gate.promise);
  controller.bindExecution('job-stale', 3);
  assert.throws(() => controller.shouldPause('job-stale', 2), /epoch|stale|execution/i);
  gate.resolve({ ok: true });
  await task;
});
