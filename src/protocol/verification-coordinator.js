import { sha256Canonical, canonicalJson } from '../platform/canonical-json.js';
import { fail } from '../core/errors.js';
import { MigrationEngine } from '../core/migration.js';
import { createContentVerificationAccumulator } from '../execution/content-verification-manifest.js';
import { verifyMigration } from '../execution/verify.js';
import { createBatchIdentity } from '../execution/batch-identity.js';

export const VERIFICATION_MODE = Object.freeze({
  NORMAL: 'NORMAL',
  REPAIR_REVERIFY: 'REPAIR_REVERIFY',
  FINAL_PRE_CUTOVER: 'FINAL_PRE_CUTOVER',
  POST_CUTOVER: 'POST_CUTOVER'
});

export const VERIFICATION_LEVEL = Object.freeze({
  ROW_COUNT: 'ROW_COUNT',
  CONTENT_EXACT: 'CONTENT_EXACT',
  CONTENT_HIERARCHICAL: 'CONTENT_HIERARCHICAL',
  BUSINESS_INVARIANTS: 'BUSINESS_INVARIANTS'
});

const VERIFICATION_DOMAIN = 'spool-verification-v1';
const HASH_ID = /^sha256:[a-f0-9]{64}$/;
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/i;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_VERIFICATION_CONFIG', `${label} must be a non-empty string`);
  return value.trim();
}

function requireVerificationMode(value) {
  if (!Object.values(VERIFICATION_MODE).includes(value)) fail('INVALID_VERIFICATION_MODE', `Unknown verification mode ${value}`);
  return value;
}

function requireRelease(release, mode) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    fail('INVALID_RELEASE_IDENTITY', 'Verification requires release identity {version, commitSha}');
  }
  if (typeof release.version !== 'string' || !release.version.trim()) {
    fail('INVALID_RELEASE_IDENTITY', 'Verification requires release.version');
  }
  if (typeof release.commitSha !== 'string' || !RELEASE_SHA.test(release.commitSha)) {
    fail('INVALID_RELEASE_IDENTITY', `Verification mode ${mode} requires an exact 40-hex release commitSha; refusing to mint evidence bound to an unknown build`);
  }
  return Object.freeze({ version: release.version.trim(), commitSha: release.commitSha.toLowerCase() });
}

function requireLsn(value, label) {
  if (typeof value !== 'string' || !LSN.test(value)) fail('INVALID_CDC_POSITION', `${label} must be a valid PostgreSQL LSN`);
  return value.toUpperCase();
}

function toBigIntLsn(lsn) {
  const [hi, lo] = requireLsn(lsn, 'lsn').split('/');
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
}

function requiresContentExact(plan) {
  return Array.isArray(plan?.verification?.checks) && plan.verification.checks.includes('content_exact');
}

function requiredLevels(plan) {
  const levels = [VERIFICATION_LEVEL.ROW_COUNT];
  if (requiresContentExact(plan)) levels.push(VERIFICATION_LEVEL.CONTENT_EXACT);
  const checks = Array.isArray(plan?.verification?.checks) ? plan.verification.checks : [];
  if (checks.includes('content_hierarchical')) {
    fail('VERIFICATION_LEVEL_UNSUPPORTED', 'CONTENT_HIERARCHICAL verification is not implemented; refusing to silently downgrade');
  }
  if (checks.includes('business_invariants')) {
    fail('VERIFICATION_LEVEL_UNSUPPORTED', 'BUSINESS_INVARIANTS verification is not implemented; refusing to silently downgrade');
  }
  return Object.freeze(levels);
}

// Semantic identity of a verification: hash over the semantic evidence ONLY.
// Wall-clock timestamps (startedAt/completedAt) are metadata and are excluded
// so that the same semantic evidence always yields the same identity — this is
// what makes idempotent retry recognition and tamper detection possible:
// same evidence -> same ID; any semantic change -> different ID.
export function verificationSemanticId(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_VERIFICATION', 'Verification record is required');
  const {
    schemaVersion, migrationId, mode, planId, mappingRevision,
    sourceStateId, targetContractId, cutoverAttemptId,
    sourceBoundary, targetBoundary, cdc,
    counts, contentRoot, levels, invariants, release
  } = record;
  const semantic = {
    schemaVersion, migrationId, mode, planId, mappingRevision,
    sourceStateId, targetContractId, cutoverAttemptId,
    sourceBoundary, targetBoundary, cdc,
    counts, contentRoot, levels, invariants, release
  };
  // Absent fields hash as absent (not as undefined): removing a field changes
  // the identity, which is exactly the tamper-evidence property required.
  for (const key of Object.keys(semantic)) {
    if (semantic[key] === undefined) delete semantic[key];
  }
  return sha256Canonical(VERIFICATION_DOMAIN, semantic);
}

// Derive the PASS/FAIL status from semantic content only. Never trust a
// stored status field: flipping status without changing the payload must not
// turn a FAILED verification into a VERIFIED one.
export function verificationStatus(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_VERIFICATION', 'Verification record is required');
  const invariants = record.invariants ?? null;
  const levels = record.levels ?? null;
  const hasInvariants = Array.isArray(invariants) && invariants.length > 0;
  const required = Array.isArray(levels?.required) ? levels.required : null;
  const completed = Array.isArray(levels?.completed) ? levels.completed : [];
  if (!required) return 'FAILED';
  const satisfied = required.every(level => completed.includes(level));
  return !hasInvariants && satisfied ? 'VERIFIED' : 'FAILED';
}

// Assert that a persisted verification record is authentic: recompute the
// semantic identity from the payload (excluding identity and execution
// metadata) and require it to match the stored verificationId. Any semantic
// mutation — changed counts, swapped CDC position, altered invariants —
// yields a different identity and is detected here.
export function assertVerificationIdentity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_VERIFICATION', 'Verification record is required');
  if (typeof record.verificationId !== 'string' || !HASH_ID.test(record.verificationId)) {
    fail('VERIFICATION_ID_MISMATCH', 'Persisted verification has no valid verificationId');
  }
  const {
    verificationId, fenceToken, startedAt, completedAt, contentProof, status,
    ...semantic
  } = record;
  void fenceToken; void startedAt; void completedAt; void contentProof; void status;
  const expected = verificationSemanticId(semantic);
  if (expected !== verificationId) {
    fail('VERIFICATION_ID_MISMATCH', 'Persisted verification identity does not match its canonical semantic contents; evidence was mutated', {
      expected,
      actual: verificationId
    });
  }
  return verificationId;
}

export class VerificationCoordinator {
  constructor() {}

  // Verification runs under a fenced target execution. Callers SHOULD pass
  // their already-leased `targetExecution` (shared fence, no second lease):
  // minting a second execution while the caller holds the lease would trip
  // lease ownership (LEASE_HELD) on single-writer targets. Passing
  // `targetRuntime` instead creates, leases, and closes a dedicated execution
  // (standalone/test use). The coordinator never closes a caller-owned
  // execution; lifecycle stays with the caller.
  async verify({
    migrationId, mode, plan, sourceState, targetContract,
    targetRuntime = null, targetExecution = null, sourceRuntime, sourceRows: knownSourceRows = null,
    snapshotCdcBoundary = null, expectedCdcPosition = null,
    cutoverAttemptId = null, expectedValidRows = null, release
  } = {}) {
    requireText(migrationId, 'migrationId');
    requireVerificationMode(mode);
    if (!plan || typeof plan !== 'object') fail('INVALID_VERIFICATION_CONFIG', 'plan is required');
    if (!targetContract || typeof targetContract !== 'object') fail('INVALID_VERIFICATION_CONFIG', 'targetContract is required');
    if ((!targetExecution || typeof targetExecution.renewLease !== 'function')
      && (!targetRuntime || typeof targetRuntime.createExecution !== 'function')) {
      fail('INVALID_VERIFICATION_CONFIG', 'either a leased targetExecution or a targetRuntime with createExecution is required');
    }
    if (!sourceRuntime || typeof sourceRuntime.streamRows !== 'function') fail('INVALID_VERIFICATION_CONFIG', 'sourceRuntime with streamRows is required');
    const releaseIdentity = requireRelease(release, mode);
    if ((mode === VERIFICATION_MODE.FINAL_PRE_CUTOVER || mode === VERIFICATION_MODE.POST_CUTOVER) && (cutoverAttemptId == null || !HASH_ID.test(cutoverAttemptId))) {
      fail('INVALID_VERIFICATION_CONFIG', `${mode} verification must be bound to the cutoverAttemptId it authorizes`);
    }
    if (mode === VERIFICATION_MODE.REPAIR_REVERIFY && (expectedValidRows == null || !Number.isSafeInteger(expectedValidRows))) {
      fail('INVALID_VERIFICATION_CONFIG', 'REPAIR_REVERIFY verification requires expectedValidRows from the approved verification batches');
    }

    const levels = requiredLevels(plan);
    const startedAt = new Date().toISOString();
    const completedLevels = [];
    const invariants = [];

    // Owns the execution only when it created it.
    const ownedExecution = targetExecution ?? targetRuntime.createExecution({ migrationId, targetRef: plan.targetRef });
    const renewFence = async () => {
      const leased = await ownedExecution.renewLease();
      const token = leased?.fencingToken ?? null;
      if (!Number.isSafeInteger(token) || token < 1) fail('FENCE_REQUIRED', 'Verification requires a fresh fence token');
      return token;
    };
    let fenceToken = await renewFence();

    let sourceRows = 0;
    let validRows = 0;
    let invalidRows = 0;
    let contentRoot = null;
    let contentProof = null;

    try {
      const batchSize = plan?.writeStrategy?.batchSize;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1) fail('INVALID_VERIFICATION_CONFIG', 'plan.writeStrategy.batchSize is required');
      const hasContentVerify = typeof ownedExecution.withContentVerifier === 'function';
      const needsContent = levels.includes(VERIFICATION_LEVEL.CONTENT_EXACT);

      if (needsContent && !hasContentVerify) {
        // Fail closed: never silently downgrade a required exact verification
        // to row counting. The plan demands content_exact and this target
        // cannot prove exact read-after-write content.
        fail('VERIFICATION_CAPABILITY_REQUIRED', 'Plan requires content_exact verification but the target execution does not implement content verification sessions');
      }

      // Content evidence is produced whenever the target is capable, even when
      // the plan only requires ROW_COUNT: strictly more proof is never a
      // downgrade, and repair re-verification always needs exact evidence.
      if (hasContentVerify) {
        const replayAccumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
        const content = await ownedExecution.withContentVerifier(
          { targetSchema: plan.targetSchema, targetContractId: targetContract.targetContractId },
          async verifier => {
            const contentAccumulator = createContentVerificationAccumulator({ targetReadState: verifier.targetReadState });
            let expectedRowsLocal = [];
            let replayLastSeen = -1;
            let flushed = 0;
            const flushBatch = async endExclusive => {
              // Keep the verification fence fresh while streaming; same-owner
              // renewal extends the lease without rotating the fencing token.
              fenceToken = await renewFence();
              const proof = await verifier.verifyBatch(expectedRowsLocal);
              contentAccumulator.add({ sourceRange: { start: flushed, endExclusive }, verification: proof });
              expectedRowsLocal = [];
              flushed = endExclusive;
            };
            for await (const { rowIndex, row } of sourceRuntime.streamRows()) {
              replayLastSeen = rowIndex;
              const transformed = replayAccumulator.process(row, rowIndex);
              if (transformed.ok) expectedRowsLocal.push(transformed.row);
              // Source-index-aligned batch boundaries, matching the execution
              // batch identities used for ledger coverage below.
              if ((rowIndex + 1) % batchSize === 0) {
                await flushBatch(rowIndex + 1);
              }
            }
            const totalRows = replayLastSeen + 1;
            if (knownSourceRows != null && totalRows !== knownSourceRows) {
              fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed during verification replay');
            }
            if (expectedRowsLocal.length !== 0 || totalRows === 0) {
              await flushBatch(totalRows);
            }
            return { summary: contentAccumulator.summary(), totalRows };
          }
        );
        const replaySummary = replayAccumulator.summary();
        sourceRows = replaySummary.processedRows;
        validRows = replaySummary.validRows;
        invalidRows = replaySummary.invalidRows;
        contentRoot = content.summary.rootHash;
        contentProof = content.summary;
        completedLevels.push(VERIFICATION_LEVEL.CONTENT_EXACT);
        if (mode === VERIFICATION_MODE.REPAIR_REVERIFY) {
          if (replaySummary.processedRows !== sourceRows || replaySummary.validRows !== expectedValidRows || replaySummary.invalidRows !== sourceRows - expectedValidRows) {
            fail('TRANSFORM_REPLAY_DIVERGED', 'Deterministic transform replay produced different row accounting during repair re-verification');
          }
          if (content.summary.sourceRowsCovered !== sourceRows || content.summary.rowCount !== expectedValidRows) {
            fail('CONTENT_VERIFICATION_ACCOUNTING_MISMATCH', 'Repair re-verification evidence does not cover the executed output exactly', {
              sourceRows, sourceRowsCovered: content.summary.sourceRowsCovered, verifiedRows: content.summary.rowCount
            });
          }
        }
        if (content.summary.status !== 'VERIFIED') {
          invariants.push({ code: 'CONTENT_VERIFICATION_DIFF', message: `Content verification found differences: ${JSON.stringify(content.summary.diffCounts)}` });
        }
      } else {
        // ROW_COUNT-only targets: recompute source accounting deterministically.
        const replayAccumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
        for await (const { rowIndex, row } of sourceRuntime.streamRows()) {
          replayAccumulator.process(row, rowIndex);
        }
        const replaySummary = replayAccumulator.summary();
        sourceRows = replaySummary.processedRows;
        validRows = replaySummary.validRows;
        invalidRows = replaySummary.invalidRows;
      }

      // ROW_COUNT level: real row-accounting + ledger completeness proof.
      // The source snapshot identity is mandatory: batch identities bind the
      // exact source state, and a missing identity must fail rather than fall
      // back to an unrelated identifier.
      const sourceStateId = sourceState?.sourceStateId ?? null;
      if (typeof sourceStateId !== 'string' || !sourceStateId) {
        fail('INVALID_VERIFICATION_CONFIG', 'Verification requires sourceState.sourceStateId for batch-identity binding');
      }
      const ledgerEntries = await ownedExecution.ledgerEntries();
      const expectedBatchIdentities = [];
      for (let start = 0; start < sourceRows; start += batchSize) {
        expectedBatchIdentities.push(createBatchIdentity({
          migrationId, planId: plan.planId, sourceSnapshotId: sourceStateId,
          mappingRevision: plan.mappingRevision,
          sourceRange: { start, endExclusive: Math.min(sourceRows, start + batchSize) },
          targetIdentity: plan.targetRef
        }));
      }
      try {
        verifyMigration({
          sourceRows, writtenRows: validRows, rejectedRows: invalidRows, filteredRows: 0,
          expectedBatchIdentities, ledgerEntries
        });
        completedLevels.push(VERIFICATION_LEVEL.ROW_COUNT);
      } catch (error) {
        invariants.push({ code: error?.code ?? 'ROW_ACCOUNTING_MISMATCH', message: error?.message ?? 'Row accounting failed' });
      }

      // CDC position check for cutover modes
      let observedCdcPosition = null;
      if (snapshotCdcBoundary || expectedCdcPosition) {
        const appliedLsn = snapshotCdcBoundary?.appliedLsn ?? snapshotCdcBoundary?.receivedLsn ?? snapshotCdcBoundary?.snapshotLsn ?? null;
        observedCdcPosition = appliedLsn;
        if (expectedCdcPosition) {
          requireLsn(expectedCdcPosition, 'expectedCdcPosition');
          if (appliedLsn != null) requireLsn(appliedLsn, 'appliedCdcPosition');
          if (!appliedLsn || toBigIntLsn(appliedLsn) < toBigIntLsn(expectedCdcPosition)) {
            invariants.push({ code: 'CDC_CATCHUP_INCOMPLETE', message: `CDC applied position ${appliedLsn} is before expected boundary ${expectedCdcPosition}` });
          }
        }
      }

      const requiredSatisfied = levels.every(level => completedLevels.includes(level));
      if (!requiredSatisfied) {
        invariants.push({ code: 'VERIFICATION_LEVEL_INCOMPLETE', message: `Required verification levels not completed: ${levels.filter(l => !completedLevels.includes(l)).join(',')}` });
      }
      const completedAt = new Date().toISOString();
      const semanticRecord = {
        schemaVersion: 1,
        migrationId,
        mode,
        planId: plan.planId,
        mappingRevision: plan.mappingRevision,
        sourceStateId,
        targetContractId: targetContract.targetContractId,
        cutoverAttemptId,
        sourceBoundary: Object.freeze({ snapshotId: sourceStateId }),
        targetBoundary: Object.freeze({ contractId: targetContract.targetContractId }),
        cdc: snapshotCdcBoundary ? Object.freeze({
          snapshotCdcBoundaryId: snapshotCdcBoundary.boundaryId ?? snapshotCdcBoundary.bindingId ?? null,
          expectedPosition: expectedCdcPosition,
          observedPosition: observedCdcPosition
        }) : null,
        counts: Object.freeze({ sourceRows, validRows, invalidRows }),
        contentRoot,
        levels: Object.freeze({ required: levels, completed: Object.freeze([...completedLevels]) }),
        invariants: invariants.length > 0 ? Object.freeze(invariants.map(i => Object.freeze({ ...i }))) : null,
        release: Object.freeze({ ...releaseIdentity })
      };
      const verificationId = verificationSemanticId(semanticRecord);
      const status = invariants.length === 0 && requiredSatisfied ? 'VERIFIED' : 'FAILED';
      return Object.freeze({
        ...semanticRecord,
        verificationId,
        // Execution metadata below is NOT part of the semantic identity: the
        // fence token and wall-clock timestamps describe when/how this evidence
        // was produced, not what it proves. Retrying the same semantic
        // verification therefore yields the same verificationId, which is what
        // makes idempotent retry recognition and tamper detection possible.
        fenceToken,
        startedAt,
        completedAt,
        contentProof: contentProof ? Object.freeze(contentProof) : null,
        status
      });
    } finally {
      // Close only executions this coordinator created; caller-owned
      // executions stay open for the caller's lifecycle.
      if (!targetExecution && ownedExecution && typeof ownedExecution.close === 'function') {
        try { await ownedExecution.close(); } catch {}
      }
    }
  }
}

export function createVerificationCoordinator() {
  return new VerificationCoordinator();
}
