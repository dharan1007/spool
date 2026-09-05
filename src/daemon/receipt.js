import { canonicalJson, sha256Json } from '../platform/canonical-json.js';
import { isSensitiveKey } from '../platform/redact.js';
import { fail } from '../core/errors.js';

function scrub(value, parentKey = '') {
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (!value || typeof value !== 'object') return value;

  if (parentKey === 'secretRefs') {
    return Object.fromEntries(Object.entries(value).map(([alias, ref]) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [alias, '[REDACTED]'];
      return [alias, {
        provider: typeof ref.provider === 'string' ? ref.provider : '[REDACTED]',
        key: typeof ref.key === 'string' ? ref.key : '[REDACTED]'
      }];
    }));
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : scrub(child, key)
  ]));
}

function normalizeCounts(counts = {}) {
  const processedRows = Number(counts.processedRows ?? 0);
  const acceptedRows = Number(counts.acceptedRows ?? 0);
  const rejectedRows = Number(counts.rejectedRows ?? 0);
  if (![processedRows, acceptedRows, rejectedRows].every(Number.isSafeInteger) || Math.min(processedRows, acceptedRows, rejectedRows) < 0) {
    fail('INVALID_RECEIPT_COUNTS', 'Receipt counts must be non-negative safe integers');
  }
  if (acceptedRows + rejectedRows !== processedRows) {
    fail('INVALID_RECEIPT_COUNTS', 'Receipt acceptedRows + rejectedRows must equal processedRows');
  }
  return { processedRows, acceptedRows, rejectedRows };
}

export async function createReceipt({ job, plan, connectors = [], verification, policyEvents = [], runtime = {} }) {
  if (!job || typeof job !== 'object') fail('INVALID_RECEIPT', 'Receipt job is required');
  if (!plan || typeof plan !== 'object') fail('INVALID_RECEIPT', 'Receipt plan is required');
  if (!['COMPLETE', 'FAILED', 'ABORTED'].includes(job.state)) {
    fail('INVALID_RECEIPT_STATE', 'Receipt requires a terminal job state');
  }
  if (job.planId !== plan.planId || job.planRevision !== plan.planRevision) {
    fail('RECEIPT_PLAN_MISMATCH', 'Receipt job and plan identities do not match');
  }

  const body = scrub({
    schemaVersion: 1,
    jobId: job.jobId,
    planId: job.planId,
    planRevision: job.planRevision,
    terminalStatus: job.state,
    sourceRef: plan.sourceRef ?? null,
    targetRef: plan.targetRef ?? null,
    counts: normalizeCounts(job.counts),
    verification: verification ?? null,
    connectors,
    policyEvents,
    timing: {
      createdAt: job.createdAt ?? null,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...runtime
    }
  });

  const receiptId = await sha256Json(body);
  const receipt = Object.freeze({ receiptId, ...body });
  canonicalJson(receipt);
  return receipt;
}
