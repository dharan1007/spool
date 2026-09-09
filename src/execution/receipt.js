import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import { connectorIdentity } from '../platform/contracts.js';

const RECEIPT_DOMAIN = 'spool-migration-receipt-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function text(name, value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_RECEIPT_INPUT', `${name} must be a non-empty bounded string`);
  return value;
}
function hash(name, value) { text(name, value); if (!HASH.test(value)) fail('INVALID_RECEIPT_INPUT', `${name} must be a canonical sha256 identity`); return value; }
function nonNegative(name, value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RECEIPT_INPUT', `${name} must be a non-negative safe integer`); return value; }
function timestamp(name, value) { text(name, value, 64); const ms = Date.parse(value); if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('INVALID_RECEIPT_INPUT', `${name} must be canonical ISO UTC`); return value; }

function normalizeViolations(items) {
  if (!Array.isArray(items)) fail('INVALID_RECEIPT_INPUT', 'violationsSummary must be an array');
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INVALID_RECEIPT_INPUT', 'Violation summaries must be objects');
    return { code: text('violation code', item.code, 128), count: nonNegative('violation count', item.count) };
  }).sort((a, b) => a.code.localeCompare(b.code));
}

export function createMigrationReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_RECEIPT_INPUT', 'Receipt input must be an object');
  if (!input.release || typeof input.release !== 'object') fail('INVALID_RECEIPT_INPUT', 'Release identity is required');
  const commitSha = text('release commitSha', input.release.commitSha, 40);
  if (!COMMIT.test(commitSha)) fail('INVALID_RECEIPT_INPUT', 'release commitSha must be a 40-character lowercase git SHA');
  if (!input.verification || input.verification.status !== 'VERIFIED') fail('RECEIPT_REQUIRES_VERIFICATION', 'Receipt may only be created for a verified migration');
  if (!Array.isArray(input.batchIdentities)) fail('INVALID_RECEIPT_INPUT', 'batchIdentities must be an array');
  if (!input.counts || typeof input.counts !== 'object' || Array.isArray(input.counts)) fail('INVALID_RECEIPT_INPUT', 'counts are required');

  const record = {
    schemaVersion: 1,
    release: { version: text('release version', input.release.version, 64), commitSha },
    migrationId: text('migrationId', input.migrationId, 128),
    planId: hash('planId', input.planId),
    sourceSnapshotId: hash('sourceSnapshotId', input.sourceSnapshotId),
    targetIdentity: connectorIdentity(input.targetIdentity),
    targetContractId: input.targetContractId == null ? null : hash('targetContractId', input.targetContractId),
    batchIdentities: input.batchIdentities.map(value => hash('batchIdentity', value)),
    counts: {
      sourceRows: nonNegative('sourceRows', input.counts.sourceRows),
      writtenRows: nonNegative('writtenRows', input.counts.writtenRows),
      rejectedRows: nonNegative('rejectedRows', input.counts.rejectedRows),
      filteredRows: nonNegative('filteredRows', input.counts.filteredRows)
    },
    violationsSummary: normalizeViolations(input.violationsSummary),
    verification: JSON.parse(canonicalJson(input.verification)),
    startedAt: timestamp('startedAt', input.startedAt),
    completedAt: timestamp('completedAt', input.completedAt)
  };
  if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) fail('INVALID_RECEIPT_INPUT', 'completedAt cannot precede startedAt');
  const canonicalRecord = JSON.parse(canonicalJson(record));
  const receiptId = sha256Canonical(RECEIPT_DOMAIN, canonicalRecord);
  return Object.freeze({ receiptId, record: Object.freeze(canonicalRecord) });
}
