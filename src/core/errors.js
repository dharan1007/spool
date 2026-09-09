const CATALOG = Object.freeze({
  SOURCE_TOO_LARGE: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Choose a smaller source', 'Use the local runner for larger bounded migrations']) }),
  STORAGE_CAPACITY_INSUFFICIENT: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Free browser storage', 'Export or remove an old workspace', 'Use the local runner']) }),
  STORAGE_WRITE_FAILED: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Free browser storage and retry', 'Keep this tab open until the workspace is durable', 'Use the local runner if browser storage remains unavailable']) }),
  APPROVAL_REQUIRED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Create a bound approval for the current plan', 'Do not reuse approval evidence from another plan or source snapshot']) }),
  SOURCE_CHANGED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Re-inspect the changed source', 'Create a new plan/approval against the new snapshot']) }),
  PATH_OUTSIDE_ALLOWED_ROOT: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Move the resource under the configured allow-root', 'Review the configured source/target root']) }),
  STALE_FENCE: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Stop the stale runner', 'Resume through the current lease holder']) }),
  TARGET_RECONCILIATION_CONFLICT: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Do not replay the batch', 'Inspect target ledger evidence and resolve the conflict explicitly']) })
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
