import { fail } from '../core/errors.js';
import { createBatchIdentity } from './batch-identity.js';
import { assertCheckpointBinding, createCheckpoint } from './checkpoint.js';

function requireMethod(value, name) {
  if (!value || typeof value[name] !== 'function') fail('INVALID_RUNNER_DEPENDENCY', `${name}() is required`);
}

function batchEvidence(input, described, batchIdentity) {
  return {
    batchIdentity,
    migrationId: input.migrationId,
    planId: input.planId,
    sourceSnapshotId: input.sourceSnapshotId,
    mappingRevision: input.mappingRevision,
    rowCount: described.rowCount,
    payloadHash: described.payloadHash
  };
}

function validateCheckpoint(prior, input, batchIdentity) {
  if (!prior) return null;
  assertCheckpointBinding(prior, input);
  if (prior.nextOffset > input.sourceRange.endExclusive) {
    fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint is ahead of the requested batch');
  }
  if (prior.nextOffset === input.sourceRange.endExclusive && prior.lastBatchIdentity === batchIdentity) {
    return prior;
  }
  if (prior.nextOffset !== input.sourceRange.start) {
    fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint does not align with the requested batch start');
  }
  return null;
}

function assertReconciliation(reconciliation, batchIdentity) {
  if (reconciliation.status === 'CONFLICT') {
    fail('TARGET_RECONCILIATION_CONFLICT', 'Target contains conflicting evidence for the logical batch', { batchIdentity });
  }
  if (reconciliation.status === 'INDETERMINATE') {
    fail('TARGET_RECONCILIATION_INDETERMINATE', 'Target commit state cannot be proven safely', { batchIdentity });
  }
}

function checkpointFor(input, batchIdentity) {
  return createCheckpoint({
    migrationId: input.migrationId,
    planId: input.planId,
    sourceSnapshotId: input.sourceSnapshotId,
    mappingRevision: input.mappingRevision,
    targetIdentity: input.targetIdentity,
    nextOffset: input.sourceRange.endExclusive,
    lastBatchIdentity: batchIdentity
  });
}

function alreadyCheckpointedResult(described, batchIdentity, checkpoint) {
  return Object.freeze({
    status: 'COMMITTED_EXACT',
    recovered: false,
    alreadyCheckpointed: true,
    batchIdentity,
    rowCount: described.rowCount,
    payloadHash: described.payloadHash,
    checkpoint
  });
}

function committedResult(result, batchIdentity, checkpoint, recovered) {
  return Object.freeze({
    status: 'COMMITTED_EXACT',
    recovered,
    alreadyCheckpointed: false,
    batchIdentity,
    rowCount: result.rowCount,
    payloadHash: result.payloadHash,
    checkpoint
  });
}

export class MigrationRunner {
  constructor({ target, checkpointStore } = {}) {
    requireMethod(target, 'describeBatch');
    requireMethod(target, 'reconcileTargetCommit');
    requireMethod(target, 'commitBatch');
    requireMethod(checkpointStore, 'load');
    requireMethod(checkpointStore, 'save');
    this.target = target;
    this.checkpointStore = checkpointStore;
  }

  runBatch(input = {}, { faultAfterTargetCommit = false } = {}) {
    const batchIdentity = createBatchIdentity(input);
    const described = this.target.describeBatch(input);
    const evidence = batchEvidence(input, described, batchIdentity);

    const prior = this.checkpointStore.load();
    const alreadyCheckpointed = validateCheckpoint(prior, input, batchIdentity);
    if (alreadyCheckpointed) return alreadyCheckpointedResult(described, batchIdentity, alreadyCheckpointed);

    const reconciliation = this.target.reconcileTargetCommit(evidence);
    assertReconciliation(reconciliation, batchIdentity);

    let result;
    let recovered = false;
    if (reconciliation.status === 'COMMITTED_EXACT') {
      result = reconciliation;
      recovered = true;
    } else if (reconciliation.status === 'NOT_COMMITTED') {
      result = this.target.commitBatch({ ...input, batchIdentity });
      if (result.status !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'Target did not return exact commit evidence');
      if (faultAfterTargetCommit) {
        fail('FAULT_AFTER_TARGET_COMMIT', 'Injected crash after target commit and before checkpoint persistence', { batchIdentity });
      }
    } else {
      fail('INVALID_RECONCILIATION_STATUS', `Unsupported reconciliation status ${String(reconciliation.status)}`);
    }

    const checkpoint = checkpointFor(input, batchIdentity);
    this.checkpointStore.save(checkpoint);
    return committedResult(result, batchIdentity, checkpoint, recovered);
  }

  async runBatchAsync(input = {}, { faultAfterTargetCommit = false } = {}) {
    const batchIdentity = createBatchIdentity(input);
    const described = await this.target.describeBatch(input);
    const evidence = batchEvidence(input, described, batchIdentity);

    const prior = await this.checkpointStore.load();
    const alreadyCheckpointed = validateCheckpoint(prior, input, batchIdentity);
    if (alreadyCheckpointed) return alreadyCheckpointedResult(described, batchIdentity, alreadyCheckpointed);

    const reconciliation = await this.target.reconcileTargetCommit(evidence);
    assertReconciliation(reconciliation, batchIdentity);

    let result;
    let recovered = false;
    if (reconciliation.status === 'COMMITTED_EXACT') {
      result = reconciliation;
      recovered = true;
    } else if (reconciliation.status === 'NOT_COMMITTED') {
      result = await this.target.commitBatch({ ...input, batchIdentity });
      if (result.status !== 'COMMITTED_EXACT') fail('TARGET_COMMIT_UNPROVEN', 'Target did not return exact commit evidence');
      if (faultAfterTargetCommit) {
        fail('FAULT_AFTER_TARGET_COMMIT', 'Injected crash after target commit and before checkpoint persistence', { batchIdentity });
      }
    } else {
      fail('INVALID_RECONCILIATION_STATUS', `Unsupported reconciliation status ${String(reconciliation.status)}`);
    }

    const checkpoint = checkpointFor(input, batchIdentity);
    await this.checkpointStore.save(checkpoint);
    return committedResult(result, batchIdentity, checkpoint, recovered);
  }
}
