import { fail } from '../core/errors.js';
import { connectorIdentity } from '../platform/contracts.js';
import { sha256Canonical } from '../platform/canonical-json.js';

export const BATCH_IDENTITY_ALGORITHM = 'spool-batch-v1';
const HASH_ID = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function buildBatchIdentityRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_BATCH_IDENTITY', 'Batch identity input must be an object');
  if (!MIGRATION_ID.test(input.migrationId ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  if (!HASH_ID.test(input.planId ?? '')) fail('INVALID_PLAN_ID', 'Invalid planId');
  if (!HASH_ID.test(input.sourceSnapshotId ?? '')) fail('INVALID_SOURCE_SNAPSHOT_ID', 'Invalid sourceSnapshotId');
  if (!Number.isInteger(input.mappingRevision) || input.mappingRevision < 1) fail('INVALID_MAPPING_REVISION', 'mappingRevision must be >= 1');
  if (!input.sourceRange || !Number.isInteger(input.sourceRange.start) || !Number.isInteger(input.sourceRange.endExclusive) || input.sourceRange.start < 0 || input.sourceRange.endExclusive <= input.sourceRange.start) {
    fail('INVALID_SOURCE_RANGE', 'sourceRange must be a non-empty integer half-open range');
  }
  return {
    migrationId: input.migrationId,
    planId: input.planId,
    sourceSnapshotId: input.sourceSnapshotId,
    mappingRevision: input.mappingRevision,
    sourceRange: { start: input.sourceRange.start, endExclusive: input.sourceRange.endExclusive },
    targetIdentity: connectorIdentity(input.targetIdentity)
  };
}

export function createBatchIdentity(input) {
  return sha256Canonical(BATCH_IDENTITY_ALGORITHM, buildBatchIdentityRecord(input));
}
