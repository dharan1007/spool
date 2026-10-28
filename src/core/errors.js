const CATALOG = Object.freeze({
  SOURCE_LOAD_SUPERSEDED: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Wait for the newer selected file to finish loading', 'Review the source name and fingerprint before approving']) }),
  WORKSPACE_WRITE_PENDING: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Wait for the current workspace write to finish', 'Retry the action after the durable checkpoint updates']) }),
  SOURCE_SNAPSHOT_PRIVACY_FAILED: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Use an owner-controlled snapshot directory on a filesystem supporting private permissions', 'Restore private snapshot permissions before recovery; do not bypass the privacy check']) }),
  PRODUCTION_CAPABILITY_DENIED: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Use a release with independently qualified target evidence', 'Use marked disposable qualification only for synthetic engineering data']) }),
  POLICY_INTEGRITY_FAILED: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Reinstall the exact verified release package', 'Do not bypass a missing or altered capability policy']) }),
  QUALIFICATION_ROOT_INVALID: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Use an explicitly marked disposable scratch root bound to this run', 'Keep source, target and state inside that root']) }),
  SOURCE_TOO_LARGE: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Choose a smaller source', 'Use the local runner for larger bounded migrations']) }),
  STORAGE_CAPACITY_INSUFFICIENT: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Free browser storage', 'Export or remove an old workspace', 'Use the local runner']) }),
  STORAGE_WRITE_FAILED: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Free browser storage and retry', 'Keep this tab open until the workspace is durable', 'Use the local runner if browser storage remains unavailable']) }),
  APPROVAL_REQUIRED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Create a bound approval for the current plan', 'Do not reuse approval evidence from another plan or source snapshot']) }),
  SOURCE_CHANGED: Object.freeze({ severity: 'user_action', retryable: true, nextActions: Object.freeze(['Re-inspect the changed source', 'Create a new plan/approval against the new snapshot']) }),
  PATH_OUTSIDE_ALLOWED_ROOT: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Move the resource under the configured allow-root', 'Review the configured source/target root']) }),
  STALE_FENCE: Object.freeze({ severity: 'concurrency', retryable: true, nextActions: Object.freeze(['Stop the stale runner', 'Resume through the current lease holder']) }),
  TARGET_RECONCILIATION_CONFLICT: Object.freeze({ severity: 'integrity', retryable: false, nextActions: Object.freeze(['Do not replay the batch', 'Inspect target ledger evidence and resolve the conflict explicitly']) }),
  CONNECTOR_DRIVER_UNAVAILABLE: Object.freeze({ severity: 'environment', retryable: false, nextActions: Object.freeze(['Install the optional connector driver beside this release', 'Use a connector included in the core package if no optional driver is available']) }),
  CONNECTOR_DRIVER_INCOMPATIBLE: Object.freeze({ severity: 'environment', retryable: false, nextActions: Object.freeze(['Install the connector driver major version this release supports', 'Re-run preflight after changing installed packages']) }),
  CONNECTOR_DRIVER_LOAD_FAILED: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Reinstall the optional connector driver', 'Retry only after the driver load failure is understood']) }),
  INVALID_CLOUD_HTTP_ENDPOINT: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Use an http(s) endpoint without embedded credentials', 'Review the connector targetRef before planning']) }),
  CLOUD_HTTP_ENDPOINT_FORBIDDEN: Object.freeze({ severity: 'security', retryable: false, nextActions: Object.freeze(['Point the connector at the documented service endpoint', 'Do not route connector traffic through metadata or link-local addresses', 'Name a legitimate private endpoint explicitly with SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS']) }),
  CLOUD_HTTP_DNS_FAILED: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Verify the endpoint hostname and this host resolver configuration', 'Retry once DNS resolves the endpoint']) }),
  CLOUD_HTTP_REQUEST_TOO_LARGE: Object.freeze({ severity: 'user_action', retryable: false, nextActions: Object.freeze(['Reduce the request body or batch size', 'Use the native driver transport for large writes']) }),
  CLOUD_HTTP_TIMEOUT: Object.freeze({ severity: 'environment', retryable: true, nextActions: Object.freeze(['Verify the endpoint is reachable from this host', 'Retry once the endpoint responds within the request deadline']) }),
  CLOUD_HTTP_RESPONSE_TOO_LARGE: Object.freeze({ severity: 'environment', retryable: false, nextActions: Object.freeze(['Reduce the query result size', 'Use the native driver transport for large result sets']) })
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
