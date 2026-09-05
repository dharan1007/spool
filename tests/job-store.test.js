import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/daemon/job-store.js';
import { createReceipt } from '../src/daemon/receipt.js';

const PLAN = Object.freeze({
  planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  planRevision: 1,
  sourceRef: { connector: 'filesystem', resource: 'input.jsonl', identity: 'sha256:source' },
  targetRef: { connector: 'sqlite', resource: 'customers' }
});

const CHECKPOINT = Object.freeze({
  sourceCursor: { offset: 500 },
  targetBoundary: 'sqlite:customers:500',
  processedRows: 500,
  acceptedRows: 498,
  rejectedRows: 2,
  planId: PLAN.planId,
  planRevision: PLAN.planRevision,
  updatedAt: '2026-09-05T00:00:00.000Z'
});

test('job store survives process-style re-instantiation at the committed checkpoint', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-jobs-'));
  try {
    const first = new JobStore({ stateDir });
    const job = await first.create(PLAN);
    await first.update(job.jobId, current => ({ ...current, state: 'RUNNING' }));
    await first.update(job.jobId, current => ({ ...current, state: 'PAUSED', checkpoint: { ...CHECKPOINT } }));

    const second = new JobStore({ stateDir });
    const restored = await second.load(job.jobId);
    assert.equal(restored.state, 'PAUSED');
    assert.equal(restored.checkpoint.processedRows, 500);
    assert.equal(restored.checkpoint.targetBoundary, 'sqlite:customers:500');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('job store rejects illegal terminal jumps and checkpoint identity drift', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-jobs-'));
  try {
    const store = new JobStore({ stateDir });
    const job = await store.create(PLAN);
    await assert.rejects(
      () => store.update(job.jobId, current => ({ ...current, state: 'COMPLETE' })),
      /INVALID_JOB_TRANSITION|transition/i
    );
    await store.update(job.jobId, current => ({ ...current, state: 'RUNNING' }));
    await assert.rejects(
      () => store.update(job.jobId, current => ({ ...current, checkpoint: { ...CHECKPOINT, planRevision: 99 } })),
      /CHECKPOINT.*PLAN|revision|identity/i
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('receipt creation is immutable, hashed, and recursively redacted', async () => {
  const receipt = await createReceipt({
    job: {
      jobId: 'job_1',
      state: 'COMPLETE',
      planId: PLAN.planId,
      planRevision: 1,
      counts: { processedRows: 2, acceptedRows: 2, rejectedRows: 0 },
      startedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:01.000Z'
    },
    plan: {
      ...PLAN,
      sourceRef: { ...PLAN.sourceRef, secretRefs: { token: { provider: 'env', key: 'SOURCE_TOKEN' } } }
    },
    connectors: [
      { name: 'filesystem', version: '1.0.0' },
      { name: 'sqlite', version: '1.0.0', password: 'must-not-leak' }
    ],
    verification: { ok: true, targetRows: 2 },
    policyEvents: [{ approval: 'target_create', token: 'must-not-leak-either' }]
  });

  assert.match(receipt.receiptId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.terminalStatus, 'COMPLETE');
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /must-not-leak/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /SOURCE_TOKEN/);
});

test('persisted receipts cannot be overwritten with different content', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-jobs-'));
  try {
    const store = new JobStore({ stateDir });
    const receipt = await createReceipt({
      job: { jobId: 'job_1', state: 'COMPLETE', planId: PLAN.planId, planRevision: 1, counts: { processedRows: 1, acceptedRows: 1, rejectedRows: 0 } },
      plan: PLAN,
      connectors: [],
      verification: { ok: true, targetRows: 1 },
      policyEvents: []
    });
    await store.saveReceipt(receipt);
    assert.deepEqual(await store.loadReceipt(receipt.receiptId), receipt);
    await assert.rejects(
      () => store.saveReceipt({ ...receipt, terminalStatus: 'FAILED' }),
      /RECEIPT.*IMMUTABLE|immutable/i
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
