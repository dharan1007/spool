import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { createReceipt } from '../src/daemon/receipt.js';

const PLAN = Object.freeze({
  planId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  planRevision: 1,
  sourceRef: { connector: 'filesystem', resource: 'input.jsonl', identity: 'sha256:source' },
  targetRef: { connector: 'sqlite', resource: 'customers', identity: 'sha256:target' }
});

function checkpoint(job, processedRows = 10) {
  return {
    sourceCursor: { offset: processedRows },
    targetBoundary: `sqlite:customers:${processedRows}`,
    targetCommitEvidence: { kind: 'sqlite-transaction', batchIdentity: `sha256:batch-${processedRows}` },
    processedRows,
    acceptedRows: processedRows - 1,
    rejectedRows: 1,
    planId: job.planId,
    planRevision: job.planRevision,
    updatedAt: '2026-09-05T00:00:00.000Z'
  };
}

async function withStore(fn) {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-sqlite-store-'));
  const store = new SQLiteJobStore({ stateDir });
  try { return await fn(store, stateDir); }
  finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function startOwnedJob(store, { leaseMs = 30_000 } = {}) {
  const created = await store.create(PLAN);
  const owned = await store.acquireExecution(created.jobId, {
    expectedStateVersion: created.stateVersion,
    ownerId: 'runner-a',
    leaseMs
  });
  const running = await store.update(
    created.jobId,
    current => ({ ...current, state: 'RUNNING' }),
    { expectedStateVersion: owned.stateVersion, expectedExecutionEpoch: owned.executionEpoch }
  );
  return running;
}

test('SQLiteJobStore CAS prevents two writers from committing the same stateVersion', async () => {
  await withStore(async store => {
    const job = await store.create(PLAN);
    const snapshotA = await store.load(job.jobId);
    const snapshotB = await store.load(job.jobId);

    const first = await store.update(
      job.jobId,
      current => ({ ...current, state: 'RUNNING' }),
      { expectedStateVersion: snapshotA.stateVersion }
    );
    assert.equal(first.stateVersion, 1);

    await assert.rejects(
      () => store.update(
        job.jobId,
        current => ({ ...current, state: 'RUNNING' }),
        { expectedStateVersion: snapshotB.stateVersion }
      ),
      /STALE_STATE_VERSION|state version/i
    );
  });
});

test('expired execution takeover increments epoch and fences the stale runner', async () => {
  await withStore(async store => {
    const running = await startOwnedJob(store, { leaseMs: 1 });
    await delay(5);

    const takeover = await store.acquireExecution(running.jobId, {
      expectedStateVersion: running.stateVersion,
      ownerId: 'runner-b',
      leaseMs: 30_000
    });

    assert.equal(takeover.executionEpoch, running.executionEpoch + 1);
    assert.equal(takeover.state, 'RECOVERING');

    await assert.rejects(
      () => store.commitCheckpoint(running.jobId, checkpoint(running), {
        expectedStateVersion: takeover.stateVersion,
        expectedExecutionEpoch: running.executionEpoch
      }),
      /STALE_EXECUTION_EPOCH|epoch/i
    );
  });
});

test('checkpoint and cumulative counts commit as one fenced transaction', async () => {
  await withStore(async store => {
    const running = await startOwnedJob(store);
    const cp = checkpoint(running, 25);
    const committed = await store.commitCheckpoint(running.jobId, cp, {
      expectedStateVersion: running.stateVersion,
      expectedExecutionEpoch: running.executionEpoch
    });

    assert.deepEqual(committed.checkpoint, cp);
    assert.deepEqual(committed.counts, { processedRows: 25, acceptedRows: 24, rejectedRows: 1 });
    assert.equal(committed.stateVersion, running.stateVersion + 1);

    const restored = await store.load(running.jobId);
    assert.deepEqual(restored.counts, committed.counts);
    assert.deepEqual(restored.checkpoint, cp);
  });
});

test('RECOVERY_REQUIRED blocks further checkpoint writes', async () => {
  await withStore(async store => {
    const running = await startOwnedJob(store);
    const recovered = await store.recoverInterruptedJobs();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'RECOVERY_REQUIRED');

    await assert.rejects(
      () => store.commitCheckpoint(running.jobId, checkpoint(running), {
        expectedStateVersion: recovered[0].stateVersion,
        expectedExecutionEpoch: running.executionEpoch
      }),
      /RECOVERY_REQUIRED|recovery/i
    );
  });
});

test('receipt primary key is immutable under divergent persistence attempts', async () => {
  await withStore(async store => {
    const receipt = await createReceipt({
      job: { jobId: 'job_receipt', state: 'COMPLETE', planId: PLAN.planId, planRevision: 1, counts: { processedRows: 1, acceptedRows: 1, rejectedRows: 0 } },
      plan: PLAN,
      connectors: [],
      verification: { ok: true, targetRows: 1 },
      policyEvents: []
    });

    await store.saveReceipt(receipt);
    await assert.rejects(
      () => store.saveReceipt({ ...receipt, terminalStatus: 'FAILED' }),
      /RECEIPT_IMMUTABLE|immutable/i
    );
    assert.deepEqual(await store.loadReceipt(receipt.receiptId), receipt);
  });
});

test('verified finalization atomically links one immutable receipt and is idempotent', async () => {
  await withStore(async store => {
    const running = await startOwnedJob(store);
    const verifying = await store.update(
      running.jobId,
      current => ({ ...current, state: 'VERIFYING', verification: { status: 'PASS', ok: true, targetRows: 0 } }),
      { expectedStateVersion: running.stateVersion, expectedExecutionEpoch: running.executionEpoch }
    );

    const terminalView = {
      ...verifying,
      state: 'COMPLETE',
      completedAt: '2026-09-05T00:00:01.000Z'
    };
    const receipt = await createReceipt({
      job: terminalView,
      plan: PLAN,
      connectors: [],
      verification: terminalView.verification,
      policyEvents: []
    });

    const complete = await store.finalizeVerifiedJob(verifying.jobId, receipt, {
      expectedStateVersion: verifying.stateVersion,
      expectedExecutionEpoch: verifying.executionEpoch
    });
    assert.equal(complete.state, 'COMPLETE');
    assert.equal(complete.receiptId, receipt.receiptId);
    assert.deepEqual(await store.loadReceipt(receipt.receiptId), receipt);

    const repeated = await store.finalizeVerifiedJob(verifying.jobId, receipt, {
      expectedStateVersion: verifying.stateVersion,
      expectedExecutionEpoch: verifying.executionEpoch
    });
    assert.deepEqual(repeated, complete);
  });
});

test('startup recovery marks orphan active jobs RECOVERY_REQUIRED and appends evidence', async () => {
  await withStore(async store => {
    const running = await startOwnedJob(store);
    const changed = await store.recoverInterruptedJobs();
    assert.equal(changed.length, 1);

    const restored = await store.load(running.jobId);
    assert.equal(restored.state, 'RECOVERY_REQUIRED');
    assert.equal(restored.executionOwner, null);
    assert.equal(restored.executionLeaseExpiresAt, null);
    assert.equal(restored.stateVersion, running.stateVersion + 1);

    const events = await store.listRecoveryEvents(running.jobId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'startup_orphaned_execution');
    assert.equal(events[0].jobId, running.jobId);
  });
});
