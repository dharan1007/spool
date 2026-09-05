import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import {
  CONNECTOR_CAPABILITY_PROFILE_VERSION,
  validateConnector
} from '../src/connectors/contract.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { createCapabilityBoundMigrationPlan } from '../src/platform/plan.js';

const BOOL_CAPS = Object.freeze({
  source: false,
  target: false,
  discover: true,
  streaming: true,
  transactions: false,
  bulkWrite: false,
  upsert: false,
  ddl: false,
  rollback: false,
  checksum: true,
  pagination: true,
  rateLimitAware: false
});

function sourceManifest() {
  return {
    name: 'reconcile_source',
    version: '1.0.0',
    capabilities: { ...BOOL_CAPS, source: true },
    capabilityProfile: {
      version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
      source: {
        snapshot: 'fingerprint_checked',
        ordering: 'stable_total_order',
        resume: 'snapshot_cursor',
        cursorKind: 'offset'
      },
      target: {
        atomicity: 'none',
        commitEvidence: 'none',
        reconcileAfterCrash: false,
        idempotency: 'none'
      },
      verification: {
        logicalCount: false,
        schema: false,
        keyCoverage: false,
        sampleHash: false,
        logicalDatasetHash: false,
        physicalArtifactHash: false,
        maxStrength: 'BASIC'
      }
    }
  };
}

function targetManifest() {
  return {
    name: 'reconcile_target',
    version: '1.0.0',
    capabilities: { ...BOOL_CAPS, target: true, transactions: true },
    capabilityProfile: {
      version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
      source: {
        snapshot: 'none',
        ordering: 'none',
        resume: 'unsupported',
        cursorKind: null
      },
      target: {
        atomicity: 'transaction',
        commitEvidence: 'native_commit_id',
        reconcileAfterCrash: true,
        idempotency: 'batch_key'
      },
      verification: {
        logicalCount: true,
        schema: true,
        keyCoverage: false,
        sampleHash: false,
        logicalDatasetHash: false,
        physicalArtifactHash: false,
        maxStrength: 'STANDARD'
      }
    }
  };
}

function connectorSkeleton(manifest) {
  return {
    manifest: () => structuredClone(manifest),
    validateConfig: async config => ({ ...config }),
    testConnection: async () => ({ ok: true }),
    discover: async () => ({}),
    read: async function* () {},
    planWrite: async () => ({ strategy: 'insert' }),
    write: async () => ({ committedRows: 0, commitId: 'noop' }),
    verify: async () => ({ ok: true, targetRows: 0 }),
    close: async () => {}
  };
}

function planInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'reconcile_source', resource: 'customers', identity: 'sha256:source-snapshot' },
    targetRef: { connector: 'reconcile_target', resource: 'customers' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
    ],
    writeStrategy: { mode: 'insert', batchSize: 2 },
    verification: { checks: ['target_count', 'schema'] },
    risk: { level: 'low', approvals: [] }
  };
}

async function makePlan() {
  return createCapabilityBoundMigrationPlan(planInput(), {
    sourceManifest: sourceManifest(),
    targetManifest: targetManifest(),
    requirements: { restartResume: true, verificationStrength: 'BASIC' }
  });
}

class ReconcileSourceConnector {
  constructor(state) { this.state = state; this.connection = {}; }
  manifest() { return sourceManifest(); }
  async validateConfig() { return {}; }
  async testConnection() { return { ok: true }; }
  async discover() { return { identity: 'sha256:source-snapshot' }; }
  async *read(_ctx, request = {}) {
    const start = request.cursor?.offset ?? 0;
    const size = request.batchSize ?? 2;
    for (let offset = start; offset < this.state.rows.length;) {
      const rows = this.state.rows.slice(offset, offset + size);
      offset += rows.length;
      yield { rows, cursor: { offset } };
    }
  }
  async planWrite() { return { strategy: 'none' }; }
  async write() { throw new Error('source connector cannot write'); }
  async verify() { return { ok: true }; }
  async close() {}
}

class ReconcileTargetConnector {
  constructor(state) { this.state = state; this.connection = {}; }
  manifest() { return targetManifest(); }
  async validateConfig() { return {}; }
  async testConnection() { return { ok: true }; }
  async discover() { return {}; }
  async *read() {}
  async planWrite() { return { strategy: 'insert', transactional: true }; }
  async write(ctx, _request, batches) {
    this.state.writeCalls += 1;
    const rows = [];
    for await (const batch of batches) rows.push(...batch.rows);
    if (this.state.failNextWriteBeforeCommit) {
      this.state.failNextWriteBeforeCommit = false;
      const error = new Error('driver secret=WRITE_SECRET');
      error.code = 'TARGET_COMMIT_UNKNOWN';
      throw error;
    }
    this.state.rows.push(...rows);
    this.state.committed.add(ctx.batchIdentity);
    const ack = {
      committedRows: rows.length,
      commitId: `commit:${ctx.batchIdentity}`,
      targetRows: this.state.rows.length
    };
    if (this.state.throwAfterCommitOnce) {
      this.state.throwAfterCommitOnce = false;
      const error = new Error('commit response lost secret=AFTER_COMMIT_SECRET');
      error.code = 'TARGET_COMMIT_UNKNOWN';
      throw error;
    }
    return ack;
  }
  async reconcileTargetCommit(_ctx, request) {
    this.state.reconcileCalls += 1;
    if (this.state.reconcileThrows) {
      const error = new Error('native reconciliation token=RECON_SECRET');
      error.code = 'RECONCILIATION_FAILED';
      throw error;
    }
    if (this.state.reconcileOverride) return { status: this.state.reconcileOverride };
    if (this.state.committed.has(request.pendingBatch.batchIdentity)) {
      return {
        status: 'COMMITTED',
        ack: {
          committedRows: request.pendingBatch.counts.acceptedRows - (request.previousCheckpoint?.acceptedRows ?? 0),
          commitId: `commit:${request.pendingBatch.batchIdentity}`,
          targetRows: this.state.rows.length
        }
      };
    }
    return { status: 'NOT_COMMITTED' };
  }
  async verify(_ctx, request) {
    return { ok: request.expectedRows == null || request.expectedRows === this.state.rows.length, targetRows: this.state.rows.length };
  }
  async close() {}
}

function makeRegistry(state) {
  const registry = new ConnectorRegistry();
  registry.register('reconcile_source', () => new ReconcileSourceConnector(state.source));
  registry.register('reconcile_target', () => new ReconcileTargetConnector(state.target));
  return registry;
}

function makeState() {
  return {
    source: { rows: [{ id: '1', name: ' Ada ' }, { id: '2', name: ' Grace ' }] },
    target: {
      rows: [],
      committed: new Set(),
      writeCalls: 0,
      reconcileCalls: 0,
      throwAfterCommitOnce: false,
      failNextWriteBeforeCommit: false,
      reconcileThrows: false,
      reconcileOverride: null
    }
  };
}

async function expireLease(store, jobId) {
  const job = await store.load(jobId);
  await store.update(
    jobId,
    current => ({ ...current, executionLeaseExpiresAt: '2000-01-01T00:00:00.000Z' }),
    { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: job.executionEpoch }
  );
}

test('connector advertising crash reconciliation must implement reconcileTargetCommit', () => {
  const missing = connectorSkeleton(targetManifest());
  assert.throws(() => validateConnector(missing), /reconcileTargetCommit|reconcil/i);

  const complete = { ...connectorSkeleton(targetManifest()), reconcileTargetCommit: async () => ({ status: 'UNKNOWN' }) };
  const manifest = validateConnector(complete);
  assert.equal(manifest.capabilityProfile.target.reconcileAfterCrash, true);
});

test('SQLiteJobStore persists a fenced pending batch and checkpoint clears it atomically', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-reconcile-store-'));
  try {
    const store = new SQLiteJobStore({ stateDir });
    const plan = { planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', planRevision: 1 };
    let job = await store.create(plan);
    job = await store.acquireExecution(job.jobId, { expectedStateVersion: job.stateVersion, ownerId: 'owner-a', leaseMs: 60_000 });
    job = await store.update(job.jobId, current => ({ ...current, state: 'RUNNING' }), {
      expectedStateVersion: job.stateVersion,
      expectedExecutionEpoch: job.executionEpoch
    });

    const pendingBatch = {
      schemaVersion: 1,
      planId: plan.planId,
      planRevision: 1,
      batchIdentity: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceIdentity: 'sha256:source-snapshot',
      previousSourceCursor: null,
      sourceCursor: { offset: 2 },
      payloadHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      targetRef: { connector: 'reconcile_target', resource: 'customers' },
      counts: { processedRows: 2, acceptedRows: 2, rejectedRows: 0 }
    };

    job = await store.beginPendingBatch(job.jobId, pendingBatch, {
      expectedStateVersion: job.stateVersion,
      expectedExecutionEpoch: job.executionEpoch
    });
    assert.deepEqual(job.pendingBatch, pendingBatch);

    await assert.rejects(
      () => store.beginPendingBatch(job.jobId, { ...pendingBatch, rawRows: [{ secret: 'NO' }] }, {
        expectedStateVersion: job.stateVersion,
        expectedExecutionEpoch: job.executionEpoch
      }),
      /rawRows|durable|forbidden/i
    );

    const checkpoint = {
      schemaVersion: 1,
      planId: plan.planId,
      planRevision: 1,
      batchIdentity: pendingBatch.batchIdentity,
      sourceCursor: { offset: 2 },
      targetBoundary: 'commit:1',
      commitEvidence: { targetBoundary: 'commit:1', committedRows: 2, targetRows: 2 },
      processedRows: 2,
      acceptedRows: 2,
      rejectedRows: 0,
      updatedAt: new Date().toISOString()
    };
    job = await store.commitCheckpoint(job.jobId, checkpoint, {
      expectedStateVersion: job.stateVersion,
      expectedExecutionEpoch: job.executionEpoch
    });
    assert.equal(job.pendingBatch, null);
    assert.deepEqual(job.counts, pendingBatch.counts);
    store.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('recovery proves committed batch and checkpoints it without replaying target write', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-reconcile-committed-'));
  try {
    const state = makeState();
    state.target.throwAfterCommitOnce = true;
    const store = new SQLiteJobStore({ stateDir });
    const plan = await makePlan();
    const registry = makeRegistry(state);
    const first = new SharedMigrationRunner({ registry, store, ownerId: 'runner-a', leaseMs: 60_000 });

    await assert.rejects(() => first.run({ plan }), /RECOVERY_REQUIRED|commit/i);
    const [failedJob] = await store.list();
    assert.ok(failedJob.pendingBatch?.batchIdentity);
    assert.equal(state.target.writeCalls, 1);
    assert.equal(state.target.rows.length, 2);

    await expireLease(store, failedJob.jobId);
    const second = new SharedMigrationRunner({ registry, store, ownerId: 'runner-b', leaseMs: 60_000 });
    const result = await second.run({ plan, jobId: failedJob.jobId });

    assert.equal(result.job.state, 'COMPLETE');
    assert.equal(result.job.pendingBatch, null);
    assert.equal(result.job.counts.acceptedRows, 2);
    assert.equal(state.target.writeCalls, 1);
    assert.equal(state.target.reconcileCalls, 1);
    store.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('NOT_COMMITTED reconciliation clears pending intent before replay', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-reconcile-not-committed-'));
  try {
    const state = makeState();
    state.target.failNextWriteBeforeCommit = true;
    const store = new SQLiteJobStore({ stateDir });
    const plan = await makePlan();
    const registry = makeRegistry(state);
    const first = new SharedMigrationRunner({ registry, store, ownerId: 'runner-a', leaseMs: 60_000 });

    await assert.rejects(() => first.run({ plan }), /RECOVERY_REQUIRED|commit/i);
    const [failedJob] = await store.list();
    assert.ok(failedJob.pendingBatch);

    const second = new SharedMigrationRunner({ registry, store, ownerId: 'runner-b', leaseMs: 60_000 });
    const result = await second.run({ plan, jobId: failedJob.jobId });
    assert.equal(result.job.state, 'COMPLETE');
    assert.equal(result.job.pendingBatch, null);
    assert.equal(state.target.writeCalls, 2);
    assert.equal(state.target.reconcileCalls, 1);
    store.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('reconciliation exception fails closed and does not persist native secret text', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-reconcile-unknown-'));
  try {
    const state = makeState();
    state.target.throwAfterCommitOnce = true;
    state.target.reconcileThrows = true;
    const store = new SQLiteJobStore({ stateDir });
    const plan = await makePlan();
    const registry = makeRegistry(state);
    const first = new SharedMigrationRunner({ registry, store, ownerId: 'runner-a', leaseMs: 60_000 });

    await assert.rejects(() => first.run({ plan }), /RECOVERY_REQUIRED|commit/i);
    const [failedJob] = await store.list();
    await expireLease(store, failedJob.jobId);

    const second = new SharedMigrationRunner({ registry, store, ownerId: 'runner-b', leaseMs: 60_000 });
    await assert.rejects(() => second.run({ plan, jobId: failedJob.jobId }), /RECOVERY_REQUIRED|reconcil/i);

    const job = await store.load(failedJob.jobId);
    const events = await store.listRecoveryEvents(failedJob.jobId);
    assert.equal(job.state, 'RECOVERY_REQUIRED');
    assert.equal(state.target.writeCalls, 1);
    assert.doesNotMatch(JSON.stringify({ job, events }), /RECON_SECRET|AFTER_COMMIT_SECRET|WRITE_SECRET/);
    store.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
