// Console error taxonomy. Every privileged operation returns a stable, sanitized
// envelope; unrecognised failures are never echoed to the renderer verbatim.
const CATALOG = Object.freeze({
  CONSOLE_VALIDATION_FAILED: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Correct the highlighted input', 'Reload the current step if the form state is stale']
  },
  WORKSPACE_NOT_FOUND: {
    severity: 'user_action',
    retryable: false,
    nextActions: ['Choose an existing workspace', 'Create a workspace before starting a migration']
  },
  WORKSPACE_NAME_REQUIRED: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Enter a workspace name']
  },
  WORKSPACE_ARCHIVED: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Restore the workspace before starting new work']
  },
  MIGRATION_NOT_FOUND: {
    severity: 'user_action',
    retryable: false,
    nextActions: ['Open Migrations and choose an existing migration']
  },
  MIGRATION_ALREADY_RUNNING: {
    severity: 'concurrency',
    retryable: false,
    nextActions: ['Wait for the active run to finish', 'Open the execution monitor instead of starting a second run']
  },
  MIGRATION_STEP_OUT_OF_ORDER: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Complete the previous wizard step', 'Return to Review and regenerate the plan']
  },
  SOURCE_PROFILE_NOT_FOUND: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Inspect the source file again']
  },
  SOURCE_UNCHANGED_CHECK_FAILED: {
    severity: 'security',
    retryable: true,
    nextActions: ['Re-inspect the source file', 'Create a new plan and approval for the changed file']
  },
  DESTINATION_NOT_CONFIGURED: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Select an existing SQLite database and table']
  },
  TABLE_NOT_AVAILABLE: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Choose an ordinary table from the destination database', 'Do not target SPOOL internal tables']
  },
  MAPPING_INCOMPLETE: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Map every required target column', 'Remove duplicate mappings']
  },
  RECIPE_INCOMPATIBLE: {
    severity: 'user_action',
    retryable: true,
    nextActions: ['Review the recipe against the current schema', 'Create a new recipe revision instead of forcing an incompatible one']
  },
  EVIDENCE_PATH_REJECTED: {
    severity: 'security',
    retryable: false,
    nextActions: ['Export evidence into a directory you control', 'Re-select the export directory']
  },
  EVIDENCE_BUNDLE_INVALID: {
    severity: 'integrity',
    retryable: false,
    nextActions: ['Re-export the bundle from the original migration', 'Do not treat a modified bundle as verified']
  },
  APPROVAL_KEY_UNAVAILABLE: {
    severity: 'security',
    retryable: false,
    nextActions: ['Sign in with the Windows profile that created the approval key', 'Re-run first-launch setup on this computer']
  },
  UPDATES_NOT_CONFIGURED: {
    severity: 'operational',
    retryable: false,
    nextActions: ['Distribute updates through the owner-controlled release process', 'Verify the installed release instead of checking for updates']
  },
  RELEASE_BUNDLE_UNVERIFIED: {
    severity: 'integrity',
    retryable: false,
    nextActions: ['Reinstall the exact verified SPOOL Console package', 'Do not run migrations from an altered engine bundle']
  },
  DIAGNOSTIC_EXPORT_FAILED: {
    severity: 'environment',
    retryable: true,
    nextActions: ['Choose a writable directory', 'Free disk space and retry the export']
  }
});

export class ConsoleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.details = details;
  }
}

export function consoleFail(code, message, details) {
  throw new ConsoleError(code, message, details);
}

export function toEnvelope(error) {
  if (error instanceof ConsoleError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      details: Object.freeze(sanitizeDetails(error.details)),
      severity: CATALOG[error.code]?.severity ?? 'operational',
      retryable: CATALOG[error.code]?.retryable ?? false,
      nextActions: Object.freeze([...(CATALOG[error.code]?.nextActions ?? ['Review the error code and current state'])])
    });
  }
  // Errors raised by the engine already carry a stable envelope contract.
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    const message = error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;
    const policy = CATALOG[error.code];
    return Object.freeze({
      code: error.code,
      message,
      details: Object.freeze(sanitizeDetails(error.details)),
      severity: policy?.severity ?? 'operational',
      retryable: policy?.retryable ?? false,
      nextActions: Object.freeze([...(policy?.nextActions ?? ['Review the error code and current migration state'])])
    });
  }
  return Object.freeze({
    code: 'CONSOLE_INTERNAL_ERROR',
    message: 'Unexpected internal error',
    details: Object.freeze({}),
    severity: 'internal',
    retryable: false,
    nextActions: Object.freeze(['Export a sanitized support bundle', 'Retry only after the root cause is understood'])
  });
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  try {
    return JSON.parse(JSON.stringify(details, (key, value) => {
      if (/password|secret|token|key|credential/i.test(key)) return '[REDACTED]';
      if (typeof value === 'string' && value.length > 4096) return `${value.slice(0, 4096)}…`;
      return value;
    }));
  } catch {
    return {};
  }
}
