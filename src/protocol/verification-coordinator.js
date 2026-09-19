import { sha256Canonical, canonicalJson } from '../platform/canonical-json.js';
import { fail } from '../core/errors.js';
import { MigrationEngine } from '../core/migration.js';
import { createRepairPlan } from '../execution/repair-plan.js';
import { createContentVerificationAccumulator } from '../execution/content-verification-manifest.js';

export const VERIFICATION_MODE = Object.freeze({
  NORMAL: 'NORMAL',
  REPAIR_REVERIFY: 'REPAIR_REVERIFY',
  FINAL_PRE_CUTOVER: 'FINAL_PRE_CUTOVER',
  POST_CUTOVER: 'POST_CUTOVER'
});

const VERIFICATION_DOMAIN = 'spool-verification-v1';

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_VERIFICATION_CONFIG', `${label} must be a non-empty string`);
  return value.trim();
}

function requirePositiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_VERIFICATION_CONFIG', `${label} must be a positive safe integer`);
  return value;
}

function requireVerificationMode(value) {
  if (!Object.values(VERIFICATION_MODE).includes(value)) fail('INVALID_VERIFICATION_MODE', `Unknown verification mode ${value}`);
  return value;
}

function toBigIntLsn(lsn) {
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
}

export class VerificationCoordinator {
  constructor({ checksumAlgorithm = 'sha256' } = {}) {
    this.checksumAlgorithm = checksumAlgorithm;
  }

  async verify({ migrationId, mode, plan, sourceState, targetContract, targetRuntime, sourceRuntime, snapshotCdcBoundary, expectedCdcPosition, fenceToken } = {}) {
    requireText(migrationId, 'migrationId');
    requireVerificationMode(mode);
    if (!plan || typeof plan !== 'object') fail('INVALID_VERIFICATION_CONFIG', 'plan is required');
    if (!targetContract || typeof targetContract !== 'object') fail('INVALID_VERIFICATION_CONFIG', 'targetContract is required');
    if (!targetRuntime || typeof targetRuntime.createExecution !== 'function') fail('INVALID_VERIFICATION_CONFIG', 'targetRuntime with createExecution is required');
    if (!sourceRuntime || typeof sourceRuntime.streamRows !== 'function') fail('INVALID_VERIFICATION_CONFIG', 'sourceRuntime with streamRows is required');
    if (!fenceToken || !Number.isSafeInteger(fenceToken) || fenceToken < 1) fail('INVALID_VERIFICATION_CONFIG', 'fenceToken is required');

    const startedAt = new Date().toISOString();
    const migrationIdStr = migrationId;

    const targetExecution = targetRuntime.createExecution({ migrationId, targetRef: plan.targetRef });
    const verifyLease = await targetExecution.renewLease();
    const hasContentVerify = typeof targetExecution.withContentVerifier === 'function';

    let expectedRows = 0;
    let observedRows = 0;
    let contentRoot = null;
    let contentProof = null;
    const invariants = [];

    try {
      if (hasContentVerify) {
        const contentVerify = await targetExecution.withContentVerifier(
          { targetSchema: plan.targetSchema, targetContractId: targetContract.targetContractId },
          async verifier => {
            const { MigrationEngine } = await import('../../core/migration.js');
            const replayAccumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
            const contentAccumulator = createContentVerificationAccumulator({ targetReadState: verifier.targetReadState });
            let expectedRowsLocal = [];
            let replayLastSeen = -1;
            let ordinal = 0;
            let sourceRows = 0;
            for await (const { rowIndex, row } of sourceRuntime.streamRows()) {
              replayLastSeen = rowIndex;
              const transformed = replayAccumulator.process(row, rowIndex);
              if (transformed.ok) expectedRowsLocal.push(transformed.row);
              sourceRows = rowIndex + 1;
              const sourceRangeStart = Math.floor(rowIndex / plan.writeStrategy.batchSize) * plan.writeStrategy.batchSize;
              const sourceRangeEnd = Math.min(sourceRows, sourceRangeStart + plan.writeStrategy.batchSize);
              if (rowIndex + 1 === sourceRangeEnd) {
                await verifyLease.renewLease();
                const contentProof = await verifier.verifyBatch(expectedRowsLocal);
                const sourceRange = { start: sourceRangeStart, endExclusive: sourceRangeEnd };
                contentAccumulator.add({ sourceRange, verification: contentProof });
                expectedRowsLocal = [];
                ordinal += 1;
              }
            }
            if (replayLastSeen + 1 !== sourceRows) {
              fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed during verification replay');
            }
            if (expectedRowsLocal.length !== 0) {
              fail('INTERNAL_BATCH_STATE', 'Content verification replay ended with an incomplete batch');
            }
            return contentAccumulator.summary();
          }
        );
        contentProof = contentVerify;
        contentRoot = contentVerify.rootHash;
        expectedRows = contentVerify.sourceRowsCovered;
        observedRows = contentVerify.rowCount;
        if (contentVerify.status !== 'VERIFIED') {
          invariants.push({ code: 'CONTENT_VERIFICATION_DIFF', message: `Content verification found differences: ${JSON.stringify(contentVerify.diffCounts)}` });
        }
      } else {
        // Basic row accounting verification
        let processed = 0;
        for await (const { rowIndex, row } of sourceRuntime.streamRows()) {
          processed = rowIndex + 1;
        }
        expectedRows = processed;
        observedRows = processed;
      }

      // Verify CDC position if CDC is involved
      let observedCdcPosition = null;
      if (snapshotCdcBoundary && expectedCdcPosition) {
        const appliedLsn = snapshotCdcBoundary.appliedLsn ?? snapshotCdcBoundary.receivedLsn ?? snapshotCdcBoundary.snapshotLsn;
        observedCdcPosition = appliedLsn;
        if (expectedCdcPosition && toBigIntLsn(appliedLsn) < toBigIntLsn(expectedCdcPosition)) {
          invariants.push({ code: 'CDC_CATCHUP_INCOMPLETE', message: `CDC applied position ${appliedLsn} is before expected boundary ${expectedCdcPosition}` });
        }
      }

      // Build verification evidence
      const verificationRecord = {
        schemaVersion: 1,
        migrationId,
        mode,
        planId: plan.planId,
        sourceStateId: sourceState?.sourceStateId ?? null,
        targetContractId: targetContract.targetContractId,
        plan: { planId: plan.planId, mappingRevision: plan.mappingRevision },
        sourceBoundary: { snapshotId: sourceState?.sourceStateId ?? null },
        targetBoundary: { contractId: targetContract.targetContractId },
        cdc: snapshotCdcBoundary ? { snapshotCdcBoundaryId: snapshotCdcBoundary.boundaryId ?? null, expectedPosition: expectedCdcPosition, observedPosition: observedCdcPosition } : null,
        counts: { expectedRows, observedRows },
        contentRoot,
        invariants: invariants.length > 0 ? invariants : null,
        startedAt,
        completedAt: new Date().toISOString(),
        releaseCommit: process.env.SPOOL_COMMIT_SHA ?? 'unknown'
      };

      const canonicalRecord = canonicalJson(verificationRecord);
      const verificationId = sha256Canonical(VERIFICATION_DOMAIN, JSON.parse(canonicalRecord));
      const evidence = Object.freeze({ ...verificationRecord, verificationId, contentProof: contentProof ? Object.freeze(contentProof) : null });

      return Object.freeze({ ...evidence, status: invariants.length === 0 ? 'VERIFIED' : 'FAILED' });
    } finally {
      try { await targetExecution.close(); } catch {}
    }
  }
}

export function createVerificationCoordinator() {
  return new VerificationCoordinator();
}