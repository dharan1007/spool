import { fail } from '../core/errors.js';
import { connectorIdentity } from '../platform/contracts.js';
import { canonicalJson } from '../platform/canonical-json.js';

const HASH_ID = /^sha256:[a-f0-9]{64}$/;

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

export function createCheckpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_CHECKPOINT', 'Checkpoint input must be an object');
  if (typeof input.migrationId !== 'string' || !input.migrationId) fail('INVALID_MIGRATION_ID', 'migrationId is required');
  if (!HASH_ID.test(input.planId ?? '')) fail('INVALID_PLAN_ID', 'Invalid planId');
  if (!HASH_ID.test(input.sourceSnapshotId ?? '')) fail('INVALID_SOURCE_SNAPSHOT_ID', 'Invalid sourceSnapshotId');
  if (!Number.isInteger(input.mappingRevision) || input.mappingRevision < 1) fail('INVALID_MAPPING_REVISION', 'mappingRevision must be >= 1');
  if (!Number.isInteger(input.nextOffset) || input.nextOffset < 0) fail('INVALID_CHECKPOINT_OFFSET', 'nextOffset must be a non-negative integer');
  if (input.lastBatchIdentity !== null && input.lastBatchIdentity !== undefined && !HASH_ID.test(input.lastBatchIdentity)) fail('INVALID_BATCH_IDENTITY', 'Invalid lastBatchIdentity');
  return deepFreeze(canonicalClone({
    schemaVersion: 1,
    migrationId: input.migrationId,
    planId: input.planId,
    sourceSnapshotId: input.sourceSnapshotId,
    mappingRevision: input.mappingRevision,
    targetIdentity: connectorIdentity(input.targetIdentity),
    nextOffset: input.nextOffset,
    lastBatchIdentity: input.lastBatchIdentity ?? null
  }));
}

export function assertCheckpointBinding(checkpoint, binding) {
  if (!checkpoint || !binding || typeof checkpoint !== 'object' || typeof binding !== 'object') fail('INVALID_CHECKPOINT', 'Checkpoint and binding are required');
  if (checkpoint.sourceSnapshotId !== binding.sourceSnapshotId) {
    fail('SOURCE_CHANGED', 'Checkpoint source snapshot no longer matches the current source', {
      expectedSnapshotId: checkpoint.sourceSnapshotId,
      actualSnapshotId: binding.sourceSnapshotId
    });
  }
  const expectedTarget = canonicalJson(connectorIdentity(checkpoint.targetIdentity));
  const actualTarget = canonicalJson(connectorIdentity(binding.targetIdentity));
  if (
    checkpoint.migrationId !== binding.migrationId ||
    checkpoint.planId !== binding.planId ||
    checkpoint.mappingRevision !== binding.mappingRevision ||
    expectedTarget !== actualTarget
  ) {
    fail('CHECKPOINT_BINDING_MISMATCH', 'Checkpoint does not match the current migration semantics');
  }
  return true;
}
