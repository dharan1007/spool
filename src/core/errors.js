const CATALOG = Object.freeze({
  SOURCE_TOO_LARGE: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Choose a smaller source', 'Use the local runner for larger bounded migrations']) }),
  STORAGE_CAPACITY_INSUFFICIENT: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Free browser storage', 'Export or remove an old workspace', 'Use the local runner']) }),
  STORAGE_WRITE_FAILED: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Free browser storage and retry', 'Keep this tab open until the workspace is durable', 'Use the local runner if browser storage remains unavailable']) }),
  APPROVAL_REQUIRED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Create a bound approval for the current plan', 'Do not reuse approval evidence from another plan or source snapshot']) }),
  SOURCE_CHANGED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Re-inspect the changed source', 'Create a new plan/approval against the new snapshot']) }),
  PATH_OUTSIDE_ALLOWED_ROOT: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Move the resource under the configured allow-root', 'Review the configured source/target root']) }),
  STALE_FENCE: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Stop the stale runner', 'Resume through the current lease holder']) }),
  TARGET_RECONCILIATION_CONFLICT: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Do not replay the batch', 'Inspect target ledger evidence and resolve the conflict explicitly']) }),
  CUTOVER_SOURCE_BARRIER_REQUIRED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Freeze source writes/routing for the armed cutover attempt', 'Mint a fresh signed cutover barrier attestation before commit']) }),
  CUTOVER_SOURCE_BARRIER_MISMATCH: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Do not reuse barrier evidence from another migration', 'Mint evidence for the currently armed migration']) }),
  CUTOVER_SOURCE_BARRIER_ATTEMPT_MISMATCH: Object.freeze({ severity: 'integrity', retryable: true, nextActions: Object.freeze(['Discard stale barrier evidence from the previous cutover attempt', 'Mint a fresh attestation after re-arm']) }),
  CUTOVER_SOURCE_BARRIER_PRINCIPAL_MISMATCH: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Do not reuse another principal\'s freeze evidence', 'Re-authenticate and mint evidence as the current cutover principal']) }),
  CUTOVER_SOURCE_BARRIER_SIGNATURE_INVALID: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Reject the barrier evidence', 'Mint a fresh server-authenticated attestation and investigate possible tampering']) }),
  CUTOVER_SOURCE_BARRIER_INVALID: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Reject malformed or modified barrier evidence', 'Mint fresh barrier evidence from the command service']) }),
  WRITE_BARRIER_ACQUIRE_TIMEOUT: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Identify and drain active source writers', 'Keep application routing frozen, then retry the cutover']) }),
  WRITE_BARRIER_NOT_PROVEN: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Do not commit cutover', 'Inspect PostgreSQL lock behavior and privileges before retrying']) }),
  WRITE_BARRIER_LOST: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Do not commit or complete cutover', 'Re-establish the source freeze and restart the cutover recovery path']) }),
  WRITE_BARRIER_RELEASED: Object.freeze({ severity: 'concurrency', retryable: false, nextActions: Object.freeze(['Do not reuse a released barrier handle', 'Acquire a new barrier for the current attempt']) }),
  WRITE_BARRIER_UNSAFE: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Use POSTGRES_TABLE_SHARE_LOCK instead of database read-only defaults', 'Keep the external source-routing freeze active through cutover']) })
});

export const ERROR_CATALOG = CATALOG;

export class SpoolError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SpoolError';
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new SpoolError(code, message, details);
};

function plainDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try { return structuredClone(value); } catch { return {}; }
}

export function toErrorEnvelope(error) {
  const spool = error instanceof SpoolError;
  if (!spool) {
    return Object.freeze({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected internal error',
      details: Object.freeze({}),
      severity: 'internal',
      retryable: false,
      nextActions: Object.freeze(['Review local logs without sharing sensitive row data', 'Retry only after the root cause is understood'])
    });
  }
  const policy = CATALOG[error.code] ?? {
    severity: 'operational', retryable: false,
    nextActions: Object.freeze(['Review the error code and current migration state'])
  };
  const message = error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;
  return Object.freeze({
    code: error.code,
    message,
    details: Object.freeze(plainDetails(error.details)),
    severity: policy.severity,
    retryable: policy.retryable,
    nextActions: policy.nextActions
  });
}
