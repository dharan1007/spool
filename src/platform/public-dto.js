import { safeDurableClone } from './runtime-contracts.js';

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
}

function classify(code) {
  if (/^(CONNECT|CONNECTION|SQLITE|FILESYSTEM|SOURCE|TARGET)_/.test(code)) return 'connector';
  if (/^(POLICY|APPROVAL|PERMISSION|UNAUTHORIZED|FORBIDDEN)_/.test(code)) return 'authorization';
  if (/^(INVALID|VALIDATION|SCHEMA|CHECKPOINT)_/.test(code)) return 'validation';
  return 'internal';
}

function publicMessage(code, kind) {
  if (kind === 'connector' || code === 'CONNECT_FAILED') return 'Connector operation failed';
  if (kind === 'authorization') return 'Operation not permitted';
  if (kind === 'validation') return 'Request validation failed';
  return 'Operation failed';
}

export function normalizePublicError(error) {
  if (!error) return null;
  const code = safeCode(error);
  const kind = classify(code);
  return Object.freeze({
    code,
    class: kind,
    retryable: error?.retryable === true,
    message: publicMessage(code, kind)
  });
}

function publicCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return safeDurableClone({
    sourceCursor: checkpoint.sourceCursor ?? null,
    targetBoundary: checkpoint.targetBoundary ?? null,
    processedRows: checkpoint.processedRows,
    acceptedRows: checkpoint.acceptedRows,
    rejectedRows: checkpoint.rejectedRows,
    planId: checkpoint.planId,
    planRevision: checkpoint.planRevision,
    updatedAt: checkpoint.updatedAt ?? null
  }, 'public checkpoint');
}

export function projectPublicJob(job) {
  const projected = {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    planId: job.planId,
    planRevision: job.planRevision,
    state: job.state,
    stateVersion: job.stateVersion,
    executionEpoch: job.executionEpoch,
    counts: job.counts,
    checkpoint: publicCheckpoint(job.checkpoint),
    verification: job.verification == null ? null : safeDurableClone(job.verification, 'public verification'),
    receiptId: job.receiptId ?? null,
    lastError: normalizePublicError(job.lastError),
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    updatedAt: job.updatedAt ?? null
  };
  return safeDurableClone(projected, 'public job');
}

export function projectPublicReceipt(receipt) {
  const projected = {
    receiptId: receipt.receiptId,
    schemaVersion: receipt.schemaVersion,
    jobId: receipt.jobId,
    planId: receipt.planId,
    planRevision: receipt.planRevision,
    terminalStatus: receipt.terminalStatus,
    sourceRef: receipt.sourceRef ?? null,
    targetRef: receipt.targetRef ?? null,
    counts: receipt.counts,
    verification: receipt.verification ?? null,
    connectors: receipt.connectors ?? [],
    policyEvents: receipt.policyEvents ?? [],
    timing: receipt.timing ?? null,
    runtime: receipt.runtime ?? null
  };
  return safeDurableClone(projected, 'public receipt');
}
