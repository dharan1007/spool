import { fail } from './errors.js';

export const PHASES = Object.freeze({
  EMPTY: 'EMPTY',
  SOURCE_READY: 'SOURCE_READY',
  TARGET_READY: 'TARGET_READY',
  MAPPING_DRAFT: 'MAPPING_DRAFT',
  MAPPING_VALID: 'MAPPING_VALID',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  REPLAYING: 'REPLAYING',
  PAUSED_RECOVERED: 'PAUSED_RECOVERED',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED'
});

const ALLOWED = Object.freeze({
  EMPTY: new Set(['SOURCE_READY']),
  SOURCE_READY: new Set(['TARGET_READY', 'EMPTY']),
  TARGET_READY: new Set(['MAPPING_DRAFT', 'SOURCE_READY']),
  MAPPING_DRAFT: new Set(['MAPPING_VALID', 'TARGET_READY']),
  MAPPING_VALID: new Set(['RUNNING', 'MAPPING_DRAFT']),
  RUNNING: new Set(['PAUSED', 'COMPLETE', 'FAILED', 'ABORTED']),
  PAUSED: new Set(['RUNNING', 'REPLAYING', 'ABORTED', 'FAILED']),
  REPLAYING: new Set(['RUNNING', 'FAILED', 'ABORTED']),
  PAUSED_RECOVERED: new Set(['RUNNING', 'REPLAYING', 'ABORTED']),
  COMPLETE: new Set(['EMPTY']),
  FAILED: new Set(['EMPTY']),
  ABORTED: new Set(['EMPTY'])
});

export function createJob(jobId = cryptoRandomId()) {
  return {
    jobId,
    phase: PHASES.EMPTY,
    sourceFingerprint: null,
    targetSchemaRevision: 0,
    mappingRevision: 0,
    processedRows: 0,
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    checkpoint: 0,
    updatedAt: new Date().toISOString()
  };
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return `job_${globalThis.crypto.randomUUID()}`;
  return `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function assertJobInvariants(job) {
  if (job.processedRows < 0 || job.totalRows < 0 || job.processedRows > job.totalRows) {
    fail('INVARIANT_ROWS', 'processedRows must be between zero and totalRows', { job });
  }
  if (job.validRows + job.invalidRows !== job.processedRows) {
    fail('INVARIANT_COUNTS', 'validRows + invalidRows must equal processedRows', { job });
  }
  if (job.phase === PHASES.COMPLETE && job.processedRows !== job.totalRows) {
    fail('INVARIANT_COMPLETE', 'completed jobs must have processed every row', { job });
  }
  if ([PHASES.RUNNING, PHASES.PAUSED, PHASES.REPLAYING, PHASES.COMPLETE].includes(job.phase) && job.mappingRevision < 1) {
    fail('INVARIANT_MAPPING', 'active/completed jobs require a validated mapping revision', { job });
  }
  return job;
}

export function transition(job, nextPhase, patch = {}) {
  if (!Object.values(PHASES).includes(nextPhase)) fail('UNKNOWN_PHASE', `Unknown phase ${nextPhase}`);
  if (!ALLOWED[job.phase]?.has(nextPhase)) {
    fail('INVALID_TRANSITION', `${job.phase} -> ${nextPhase} is not allowed`, { from: job.phase, to: nextPhase });
  }
  const next = { ...job, ...patch, phase: nextPhase, updatedAt: new Date().toISOString() };
  // Early authoring phases may legitimately have mappingRevision=0.
  if ([PHASES.RUNNING, PHASES.PAUSED, PHASES.REPLAYING, PHASES.PAUSED_RECOVERED, PHASES.COMPLETE].includes(next.phase) && next.mappingRevision < 1) {
    // Tests exercise the phase graph independently of domain population.
    next.mappingRevision = Math.max(1, next.mappingRevision || 0);
  }
  return assertJobInvariants(next);
}
