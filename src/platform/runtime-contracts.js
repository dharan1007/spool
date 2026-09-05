import { fail } from '../core/errors.js';

export const RUNTIME_ONLY = Symbol.for('spool.runtimeOnly');

export const JOB_STATES = new Set([
  'PLANNED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'VERIFYING',
  'RECOVERING',
  'RECOVERY_REQUIRED',
  'COMPLETE',
  'FAILED',
  'ABORTED'
]);

export const TERMINAL_JOB_STATES = new Set(['COMPLETE', 'FAILED', 'ABORTED']);

const TRANSITIONS = Object.freeze({
  PLANNED: new Set(['RUNNING', 'FAILED', 'ABORTED']),
  RUNNING: new Set(['PAUSING', 'PAUSED', 'VERIFYING', 'RECOVERING', 'RECOVERY_REQUIRED', 'FAILED', 'ABORTED']),
  PAUSING: new Set(['PAUSED', 'RECOVERING', 'RECOVERY_REQUIRED', 'FAILED', 'ABORTED']),
  PAUSED: new Set(['RUNNING', 'RECOVERING', 'RECOVERY_REQUIRED', 'FAILED', 'ABORTED']),
  VERIFYING: new Set(['COMPLETE', 'RECOVERING', 'RECOVERY_REQUIRED', 'FAILED', 'ABORTED']),
  RECOVERING: new Set(['RUNNING', 'PAUSED', 'VERIFYING', 'RECOVERY_REQUIRED', 'FAILED', 'ABORTED']),
  RECOVERY_REQUIRED: new Set(['RECOVERING', 'FAILED', 'ABORTED']),
  COMPLETE: new Set(),
  FAILED: new Set(),
  ABORTED: new Set()
});

const FORBIDDEN_DURABLE_KEYS = new Set(['rawRows', 'rowBatch', 'rows', 'resolvedSecret', 'secretValue']);

function validateNonNegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a non-negative safe integer`);
}

export function validateCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) fail('INVALID_JOB_COUNTS', 'Job counts are required');
  validateNonNegativeInteger(counts.processedRows, 'INVALID_JOB_COUNTS', 'processedRows');
  validateNonNegativeInteger(counts.acceptedRows, 'INVALID_JOB_COUNTS', 'acceptedRows');
  validateNonNegativeInteger(counts.rejectedRows, 'INVALID_JOB_COUNTS', 'rejectedRows');
  if (counts.acceptedRows + counts.rejectedRows !== counts.processedRows) {
    fail('INVALID_JOB_COUNTS', 'acceptedRows + rejectedRows must equal processedRows');
  }
}

export function validateCheckpointContract(checkpoint, job) {
  if (checkpoint == null) return;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) fail('INVALID_CHECKPOINT', 'Checkpoint must be an object');
  if (checkpoint.planId !== job.planId || checkpoint.planRevision !== job.planRevision) {
    fail('CHECKPOINT_PLAN_MISMATCH', 'Checkpoint plan identity/revision does not match the job');
  }
  const counts = {
    processedRows: checkpoint.processedRows,
    acceptedRows: checkpoint.acceptedRows,
    rejectedRows: checkpoint.rejectedRows
  };
  validateCounts(counts);
  if (job.counts && (
    job.counts.processedRows !== counts.processedRows ||
    job.counts.acceptedRows !== counts.acceptedRows ||
    job.counts.rejectedRows !== counts.rejectedRows
  )) {
    fail('CHECKPOINT_PROGRESS_MISMATCH', 'Checkpoint and job progress must advance as one cumulative boundary');
  }
}

function validateTerminalEvidence(job) {
  if (job.state !== 'COMPLETE') return;
  const verificationPassed = job.verification?.status === 'PASS' || job.verification?.ok === true;
  if (!verificationPassed) fail('VERIFICATION_REQUIRED', 'A job cannot become COMPLETE before verification succeeds');
  if (typeof job.receiptId !== 'string' || !job.receiptId) fail('RECEIPT_REQUIRED', 'A job cannot become COMPLETE before an immutable receipt is linked');
}

export function validateJobRecord(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) fail('INVALID_JOB_RECORD', 'Job record must be an object');
  if (typeof job.jobId !== 'string' || !job.jobId) fail('INVALID_JOB_ID', 'jobId is required');
  if (typeof job.planId !== 'string' || !job.planId) fail('INVALID_PLAN_ID', 'planId is required');
  if (!Number.isSafeInteger(job.planRevision) || job.planRevision < 1) fail('INVALID_PLAN_REVISION', 'planRevision must be a positive safe integer');
  if (!JOB_STATES.has(job.state)) fail('INVALID_JOB_STATE', `Unknown job state ${job.state}`);
  validateNonNegativeInteger(job.stateVersion, 'INVALID_STATE_VERSION', 'stateVersion');
  validateNonNegativeInteger(job.executionEpoch, 'INVALID_EXECUTION_EPOCH', 'executionEpoch');
  validateCounts(job.counts);
  validateCheckpointContract(job.checkpoint, job);
  validateTerminalEvidence(job);
  safeDurableClone(job, 'job');
  return job;
}

export function assertJobTransition(previous, next) {
  validateJobRecord(previous);
  validateJobRecord(next);
  if (next.jobId !== previous.jobId || next.planId !== previous.planId || next.planRevision !== previous.planRevision) {
    fail('JOB_IDENTITY_MUTATION', 'Job identity and plan identity are immutable');
  }
  if (previous.state !== next.state && !TRANSITIONS[previous.state]?.has(next.state)) {
    fail('INVALID_JOB_TRANSITION', `Cannot transition job from ${previous.state} to ${next.state}`);
  }
  if (next.stateVersion !== previous.stateVersion + 1) {
    fail('INVALID_STATE_VERSION', 'Every persisted job mutation must advance stateVersion exactly once');
  }
  if (next.executionEpoch < previous.executionEpoch || next.executionEpoch > previous.executionEpoch + 1) {
    fail('INVALID_EXECUTION_EPOCH', 'executionEpoch may stay constant or advance exactly once');
  }
  return next;
}

export function validateExecutionOwnership(job, expectedEpoch) {
  validateNonNegativeInteger(expectedEpoch, 'INVALID_EXECUTION_EPOCH', 'expected execution epoch');
  if (job.executionEpoch !== expectedEpoch) {
    fail('STALE_EXECUTION_EPOCH', `Execution epoch ${expectedEpoch} no longer owns job ${job.jobId ?? ''}`.trim());
  }
  return true;
}

function inspectDurable(value, path, seen) {
  if (value == null || typeof value !== 'object') return;
  if (value[RUNTIME_ONLY] === true) fail('RUNTIME_ONLY_VALUE', `Runtime-only value cannot enter durable ${path}`);
  if (seen.has(value)) fail('INVALID_DURABLE_VALUE', `Circular value cannot enter durable ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) inspectDurable(value[index], `${path}[${index}]`, seen);
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DURABLE_KEYS.has(key)) fail('RAW_ROWS_FORBIDDEN', `${key} cannot enter durable ${path}`);
    inspectDurable(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function safeDurableClone(value, context = 'metadata') {
  inspectDurable(value, context, new WeakSet());
  return structuredClone(value);
}
