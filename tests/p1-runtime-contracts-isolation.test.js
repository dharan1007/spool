import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_STATES,
  assertJobTransition,
  validateExecutionOwnership,
  validateCheckpointContract,
  safeDurableClone
} from '../src/platform/runtime-contracts.js';
import {
  resolveRuntimeSecretRef,
  unwrapRuntimeSecret
} from '../src/platform/secrets.js';
import {
  projectPublicJob,
  normalizePublicError
} from '../src/platform/public-dto.js';
import { JobStore } from '../src/daemon/job-store.js';

const PLAN_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const baseJob = {
  schemaVersion: 1,
  jobId: 'job_1',
  planId: PLAN_ID,
  planRevision: 1,
  state: 'RUNNING',
  stateVersion: 1,
  executionEpoch: 2,
  counts: { processedRows: 10, acceptedRows: 9, rejectedRows: 1 },
  checkpoint: {
    sourceCursor: { offset: 10 },
    targetBoundary: 'target:10',
    processedRows: 10,
    acceptedRows: 9,
    rejectedRows: 1,
    planId: PLAN_ID,
    planRevision: 1
  },
  verification: null,
  receiptId: null,
  lastError: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  startedAt: '2026-09-05T00:00:01.000Z',
  completedAt: null,
  updatedAt: '2026-09-05T00:00:02.000Z'
};

test('runtime state machine includes recovery states and terminal completion needs verification plus receipt', () => {
  assert.equal(JOB_STATES.has('RECOVERING'), true);
  assert.equal(JOB_STATES.has('RECOVERY_REQUIRED'), true);
  assert.throws(
    () => assertJobTransition(baseJob, { ...baseJob, state: 'COMPLETE', verification: { status: 'PASS' } }),
    /RECEIPT_REQUIRED|receipt/i
  );
  assert.doesNotThrow(() => assertJobTransition(baseJob, {
    ...baseJob,
    state: 'RECOVERING',
    stateVersion: 2
  }));
});

test('execution ownership and checkpoint identity fail closed', () => {
  assert.throws(() => validateExecutionOwnership(baseJob, 1), /STALE_EXECUTION_EPOCH|epoch/i);
  assert.doesNotThrow(() => validateExecutionOwnership(baseJob, 2));
  assert.throws(
    () => validateCheckpointContract({ ...baseJob.checkpoint, planRevision: 2 }, baseJob),
    /CHECKPOINT_PLAN_MISMATCH|plan/i
  );
});

test('durable clone rejects raw rows and runtime-only secret values', () => {
  assert.throws(() => safeDurableClone({ rawRows: [{ id: 1 }] }, 'job'), /RAW_ROWS_FORBIDDEN|raw row/i);
  const secret = resolveRuntimeSecretRef({ provider: 'env', key: 'DB_PASSWORD' }, { DB_PASSWORD: 's3cr3t' });
  assert.equal(unwrapRuntimeSecret(secret), 's3cr3t');
  assert.throws(() => JSON.stringify(secret), /SECRET_SERIALIZATION_BLOCKED|serial/i);
  assert.throws(() => safeDurableClone({ credential: secret }, 'job'), /RUNTIME_ONLY_VALUE|SECRET/);
});

test('public job projection is allowlisted and normalized errors do not leak connector-native text', () => {
  const internal = {
    ...baseJob,
    secretRefs: { password: { provider: 'env', key: 'DB_PASSWORD' } },
    rawRows: [{ password: 'raw-row-value' }],
    internalSession: { token: 's3cr3t' },
    lastError: Object.assign(new Error('postgres://user:s3cr3t@host/db'), { code: 'CONNECT_FAILED', retryable: true })
  };
  const projected = projectPublicJob(internal);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /s3cr3t|raw-row-value|DB_PASSWORD|postgres:\/\//);
  assert.equal('secretRefs' in projected, false);
  assert.equal('rawRows' in projected, false);
  assert.equal(projected.lastError.code, 'CONNECT_FAILED');

  const normalized = normalizePublicError(Object.assign(new Error('native secret detail'), { code: 'CONNECT_FAILED' }));
  assert.equal(normalized.code, 'CONNECT_FAILED');
  assert.equal(normalized.message, 'Connector operation failed');
  assert.doesNotMatch(JSON.stringify(normalized), /native secret detail/);
});

test('file JobStore adds version and execution epoch guards while preserving single-writer persistence', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-p1-contracts-'));
  try {
    const store = new JobStore({ stateDir });
    const job = await store.create({ planId: PLAN_ID, planRevision: 1 });
    assert.equal(job.stateVersion, 0);
    assert.equal(job.executionEpoch, 0);

    const running = await store.update(
      job.jobId,
      current => ({ ...current, state: 'RUNNING', executionEpoch: 1 }),
      { expectedStateVersion: 0 }
    );
    assert.equal(running.stateVersion, 1);
    assert.equal(running.executionEpoch, 1);

    await assert.rejects(
      () => store.update(job.jobId, current => current, { expectedStateVersion: 0 }),
      /STALE_STATE_VERSION|state version/i
    );

    await assert.rejects(
      () => store.update(job.jobId, current => ({ ...current, state: 'PAUSED' }), { expectedExecutionEpoch: 0 }),
      /STALE_EXECUTION_EPOCH|epoch/i
    );

    await assert.rejects(
      () => store.update(job.jobId, current => ({
        ...current,
        state: 'COMPLETE',
        verification: { status: 'PASS' }
      }),
      /INVALID_JOB_TRANSITION|RECEIPT_REQUIRED|receipt|transition/i
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
