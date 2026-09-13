import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import { connectorIdentity } from '../platform/contracts.js';

const REPAIR_PLAN_DOMAIN = 'spool-repair-plan-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireHash(name, value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_REPAIR_PLAN_INPUT', `${name} must be a canonical sha256 identity`);
  return value;
}

function requireMigrationId(value) {
  if (typeof value !== 'string' || !MIGRATION_ID.test(value)) fail('INVALID_REPAIR_PLAN_INPUT', 'migrationId is invalid');
  return value;
}

function requireTargetIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REPAIR_PLAN_INPUT', 'targetIdentity is required');
  return connectorIdentity(value);
}

function operationFromDiff(entry) {
  const base = {
    keyId: requireHash('keyId', entry.keyId),
    key: entry.key,
    expectedRowHash: entry.expectedRowHash,
    actualRowHash: entry.actualRowHash
  };
  if (entry.kind === 'MISSING') {
    if (!entry.expectedRow || entry.actualRow != null) fail('INVALID_REPAIR_VERIFICATION', 'Missing-row evidence is incomplete');
    return {
      effect: 'INSERT',
      ...base,
      row: entry.expectedRow,
      precondition: { absent: true }
    };
  }
  if (entry.kind === 'MISMATCH') {
    if (!entry.expectedRow || !entry.actualRow || !entry.actualRowHash) fail('INVALID_REPAIR_VERIFICATION', 'Mismatch evidence is incomplete');
    return {
      effect: 'UPDATE',
      ...base,
      row: entry.expectedRow,
      precondition: { actualRowHash: entry.actualRowHash }
    };
  }
  if (entry.kind === 'UNEXPECTED') {
    if (entry.expectedRow != null || !entry.actualRow || !entry.actualRowHash) fail('INVALID_REPAIR_VERIFICATION', 'Unexpected-row evidence is incomplete');
    return {
      effect: 'DELETE',
      ...base,
      precondition: { actualRowHash: entry.actualRowHash }
    };
  }
  fail('INVALID_REPAIR_VERIFICATION', `Unsupported diff kind ${entry.kind}`);
}

export function createRepairPlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REPAIR_PLAN_INPUT', 'Repair-plan input must be an object');
  const verification = input.verification;
  if (!verification || typeof verification !== 'object' || verification.level !== 'CONTENT_EXACT') fail('INVALID_REPAIR_VERIFICATION', 'Exact content verification evidence is required');
  requireHash('verificationId', verification.verificationId);
  if (verification.status === 'VERIFIED') fail('REPAIR_NOT_REQUIRED', 'Verified content has no repair work');
  if (verification.status !== 'DIFF' || !Array.isArray(verification.diff?.entries) || verification.diff.entries.length === 0) {
    fail('INVALID_REPAIR_VERIFICATION', 'Repair plan requires non-empty deterministic diff evidence');
  }

  const operations = verification.diff.entries.map(operationFromDiff);
  const effects = [...new Set(operations.map(operation => operation.effect))].sort();
  const record = {
    schemaVersion: 1,
    migrationId: requireMigrationId(input.migrationId),
    planId: requireHash('planId', input.planId),
    sourceSnapshotId: requireHash('sourceSnapshotId', input.sourceSnapshotId),
    targetIdentity: requireTargetIdentity(input.targetIdentity),
    targetContractId: requireHash('targetContractId', input.targetContractId),
    verificationId: verification.verificationId,
    primaryKey: verification.primaryKey,
    columns: verification.columns,
    effects,
    operations
  };
  const canonicalRecord = JSON.parse(canonicalJson(record));
  return Object.freeze({
    ...canonicalRecord,
    repairPlanId: sha256Canonical(REPAIR_PLAN_DOMAIN, canonicalRecord)
  });
}
