import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function input() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:detached-source' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }],
    writeStrategy: { mode: 'create_insert', batchSize: 1 },
    verification: { checks: ['target_count'] },
    risk: { level: 'low', approvals: [] }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spool-command-control-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  await writeFile(join(root, 'customers.jsonl'), [
    JSON.stringify({ id: '1' }),
    JSON.stringify({ id: '2' })
  ].join('\n') + '\n');
  const barrier = { started: deferred(), release: deferred() };
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config));
  registry.register('sqlite', config => new BlockingSQLiteConnector(config, barrier));
  const configStore = new ConfigStore({ stateDir });
  const jobStore = new SQLiteJobStore({ stateDir });
  const executionController = new ExecutionController();
  const controlledStore = new ExecutionControlledJobStore({ store: jobStore, controller: executionController });
  const runner = new SharedMigrationRunner({ registry, store: controlledStore, ownerId: 'command-control' });
  const service = new SpoolCommandService({ configStore, registry, jobStore, runner, executionController });
  await service.putConnection({ name: 'source', type: 'filesystem', config: { root }, secretRefs: {} });
  await service.putConnection({ name: 'target', type: 'sqlite', config: { database: targetDb }, secretRefs: {} });
  const plan = await service.createPlan({
    planInput: input(),
    sourceConnection: 'source',
    targetConnection: 'target',
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
  return { root, jobStore, executionController, service, plan, barrier };
}

async function closeFixture(value) {
  value.barrier.release.resolve();
  if (value.executionController.activeJobIds().length) await value.executionController.pauseAll();
  value.jobStore.close();
  await rm(value.root, { recursive: true, force: true });
}

test('runMigration detach:true returns a durable managed job handle while the same controller owns execution', async () => {
  const value = await fixture();
  try {
    const started = await value.service.runMigration({
      plan: value.plan,
      sourceConnection: 'source',
      targetConnection: 'target',
      detach: true
    });
    assert.equal(started.receipt, null);
    assert.notEqual(started.job.state, 'COMPLETE');
    assert.equal(value.executionController.isActive(started.job.jobId), true);
    await value.barrier.started.promise;
    value.barrier.release.resolve();
    while (value.executionController.isActive(started.job.jobId)) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const complete = await value.service.inspectJob({ jobId: started.job.jobId });
    assert.equal(complete.state, 'COMPLETE');
    assert.ok(complete.receiptId);
  } finally {
    await closeFixture(value);
  }
});

test('pauseJob waits through an in-flight target commit and returns only after a durable PAUSED boundary', async () => {
  const value = await fixture();
  try {
    const started = await value.service.runMigration({
      plan: value.plan,
      sourceConnection: 'source',
      targetConnection: 'target',
      detach: true
    });
    await value.barrier.started.promise;
    const pausePromise = value.service.pauseJob({ jobId: started.job.jobId });
    assert.equal(value.executionController.isActive(started.job.jobId), true);
    value.barrier.release.resolve();
    const paused = await pausePromise;
    assert.equal(paused.state, 'PAUSED');
    assert.deepEqual(paused.counts, { processedRows: 1, acceptedRows: 1, rejectedRows: 0 });
    assert.equal(value.executionController.isActive(started.job.jobId), false);

    const verified = await value.service.verifyJob({ jobId: started.job.jobId });
    assert.equal(verified.job.state, 'PAUSED');
    assert.equal(verified.verification.ok, true);
    assert.equal(verified.verification.status, 'PASS');
    assert.equal(verified.verification.targetRows, 1);
    assert.equal(value.executionController.isActive(started.job.jobId), false);
    const verifiedJob = await value.service.inspectJob({ jobId: started.job.jobId });
    assert.equal(verifiedJob.state, 'PAUSED');
    assert.equal(verifiedJob.verification.ok, true);

    await assert.rejects(
      () => value.service.resumeJob({ jobId: started.job.jobId }),
      error => error?.code === 'RESUME_GUARANTEE_UNAVAILABLE'
    );
    const stillPaused = await value.service.inspectJob({ jobId: started.job.jobId });
    assert.equal(stillPaused.state, 'PAUSED');
    assert.deepEqual(stillPaused.counts, paused.counts);
  } finally {
    await closeFixture(value);
  }
});
