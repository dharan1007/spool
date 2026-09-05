import { MigrationEngine } from '../core/migration.js';
import { fail } from '../core/errors.js';
import { assertAsyncIterable } from '../connectors/contract.js';
import { sha256Json } from '../platform/canonical-json.js';
import {
  assertPlanConnectorCompatibility,
  validateMigrationPlan
} from '../platform/plan.js';
import { normalizePublicError } from '../platform/public-dto.js';
import { redact } from '../platform/redact.js';
import { safeDurableClone } from '../platform/runtime-contracts.js';
import { createReceipt } from './receipt.js';

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_BATCH_SIZE = 100_000;
const RECONCILIATION_STATUSES = new Set(['COMMITTED', 'NOT_COMMITTED', 'UNKNOWN']);

function validateRunnerDependency(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    fail('INVALID_RUNNER_DEPENDENCY', `${label} must implement ${method}()`);
  }
}

function validateOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) {
    fail('INVALID_EXECUTION_OWNER', 'Shared runner ownerId must be a non-empty string of at most 200 characters');
  }
}

function validateLeaseMs(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1000) {
    fail('INVALID_EXECUTION_LEASE', 'Shared runner leaseMs must be between 1 and 86400000');
  }
}

function batchSizeFor(plan) {
  const batchSize = plan.writeStrategy?.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    fail('INVALID_BATCH_SIZE', `Runner batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return batchSize;
}

function writeRequestFor(plan) {
  return {
    resource: plan.targetRef.resource,
    mode: plan.writeStrategy.mode,
    targetSchema: plan.targetSchema,
    keyFields: plan.writeStrategy.keyFields ?? undefined
  };
}

function verificationRequestFor(plan, counts) {
  const request = { resource: plan.targetRef.resource };
  if (plan.writeStrategy.mode === 'create_insert') request.expectedRows = counts.acceptedRows;
  return request;
}

async function* oneBatch(rows) {
  yield { rows };
}

function normalizeTargetBoundary(ack, plan) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    fail('INVALID_TARGET_ACK', 'Target write must return a commit acknowledgement object');
  }
  if (typeof ack.checkpointToken === 'string' && ack.checkpointToken) return ack.checkpointToken;
  if (typeof ack.commitId === 'string' && ack.commitId) return ack.commitId;
  if (typeof ack.artifactHash === 'string' && ack.artifactHash) return ack.artifactHash;
  if (Number.isSafeInteger(ack.targetRows) && ack.targetRows >= 0) {
    return `${plan.targetRef.connector}:${plan.targetRef.resource}:rows:${ack.targetRows}`;
  }
  return null;
}

function boundedCommitEvidence(ack, targetBoundary) {
  const evidence = { targetBoundary };
  if (Number.isSafeInteger(ack?.committedRows) && ack.committedRows >= 0) evidence.committedRows = ack.committedRows;
  if (Number.isSafeInteger(ack?.targetRows) && ack.targetRows >= 0) evidence.targetRows = ack.targetRows;
  return safeDurableClone(evidence, 'runner commit evidence');
}

function boundedVerificationEvidence(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('INVALID_VERIFICATION_RESULT', 'Target verify() must return an object');
  }
  const redacted = redact(result);
  const evidence = {
    status: result.ok === true ? 'PASS' : 'FAIL',
    ok: result.ok === true
  };
  if (Number.isSafeInteger(result.targetRows) && result.targetRows >= 0) evidence.targetRows = result.targetRows;
  if (typeof result.checksum === 'string') evidence.checksum = result.checksum;
  if (typeof result.sampleHash === 'string') evidence.sampleHash = result.sampleHash;
  if (Array.isArray(redacted.checks)) evidence.checks = redacted.checks.slice(0, 32);
  if (Array.isArray(redacted.primaryKey)) evidence.primaryKey = redacted.primaryKey.slice(0, 32);
  if (redacted.primaryKeyCoverage && typeof redacted.primaryKeyCoverage === 'object') evidence.primaryKeyCoverage = redacted.primaryKeyCoverage;
  return safeDurableClone(evidence, 'runner verification evidence');
}

function connectorReceiptIdentity(connector) {
  const manifest = connector.manifest();
  return { name: manifest.name, version: manifest.version };
}

async function buildPendingBatch(plan, job, batch, transformed, payloadHash) {
  const nextCounts = {
    processedRows: job.counts.processedRows + transformed.processedRows,
    acceptedRows: job.counts.acceptedRows + transformed.validRows,
    rejectedRows: job.counts.rejectedRows + transformed.invalidRows
  };
  const identityPayload = {
    domain: 'spool-batch-v1',
    planId: plan.planId,
    planRevision: plan.planRevision,
    sourceIdentity: plan.sourceRef.identity ?? null,
    previousSourceCursor: job.checkpoint?.sourceCursor ?? null,
    sourceCursor: batch.cursor,
    payloadHash,
    targetRef: { connector: plan.targetRef.connector, resource: plan.targetRef.resource },
    counts: nextCounts
  };
  const batchIdentity = await sha256Json(identityPayload);
  return safeDurableClone({
    schemaVersion: 1,
    planId: plan.planId,
    planRevision: plan.planRevision,
    batchIdentity,
    sourceIdentity: plan.sourceRef.identity,
    previousSourceCursor: job.checkpoint?.sourceCursor ?? null,
    sourceCursor: batch.cursor,
    payloadHash,
    targetRef: { connector: plan.targetRef.connector, resource: plan.targetRef.resource },
    counts: nextCounts
  }, 'runner pending batch');
}

function checkpointFromPending(plan, pendingBatch, ack) {
  const targetBoundary = normalizeTargetBoundary(ack, plan);
  if (plan.connectorBinding.target.capabilityProfile.target.commitEvidence !== 'none' && !targetBoundary) {
    fail('TARGET_COMMIT_EVIDENCE_MISSING', 'Target commit evidence is required by the capability-bound plan');
  }
  const commitEvidence = boundedCommitEvidence(ack, targetBoundary);
  return {
    schemaVersion: 1,
    planId: plan.planId,
    planRevision: plan.planRevision,
    batchIdentity: pendingBatch.batchIdentity,
    sourceCursor: safeDurableClone(pendingBatch.sourceCursor, 'source cursor'),
    targetBoundary,
    commitEvidence,
    processedRows: pendingBatch.counts.processedRows,
    acceptedRows: pendingBatch.counts.acceptedRows,
    rejectedRows: pendingBatch.counts.rejectedRows,
    updatedAt: new Date().toISOString()
  };
}

function validateReconciliationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !RECONCILIATION_STATUSES.has(result.status)) {
    fail('INVALID_RECONCILIATION_RESULT', 'Target reconciliation must return COMMITTED, NOT_COMMITTED, or UNKNOWN');
  }
  if (result.status === 'COMMITTED' && (!result.ack || typeof result.ack !== 'object' || Array.isArray(result.ack))) {
    fail('INVALID_RECONCILIATION_RESULT', 'COMMITTED reconciliation requires bounded commit acknowledgement evidence');
  }
  return result;
}

export class SharedMigrationRunner {
  constructor({ registry, store, ownerId, leaseMs = DEFAULT_LEASE_MS } = {}) {
    validateRunnerDependency(registry, 'open', 'registry');
    validateRunnerDependency(store, 'acquireExecution', 'store');
    validateRunnerDependency(store, 'renewExecution', 'store');
    validateRunnerDependency(store, 'beginPendingBatch', 'store');
    validateRunnerDependency(store, 'clearPendingBatch', 'store');
    validateRunnerDependency(store, 'commitCheckpoint', 'store');
    validateRunnerDependency(store, 'finalizeVerifiedJob', 'store');
    validateOwnerId(ownerId);
    validateLeaseMs(leaseMs);
    this.registry = registry;
    this.store = store;
    this.ownerId = ownerId;
    this.leaseMs = leaseMs;
    this.engine = new MigrationEngine({ sampleLimit: 0 });
  }

  async enterRecoveryRequired(job, error, kind, details = {}) {
    const publicError = normalizePublicError(error);
    let current = await this.store.load(job.jobId);
    if (current.state !== 'RECOVERY_REQUIRED') {
      current = await this.store.update(
        job.jobId,
        value => ({
          ...value,
          state: 'RECOVERY_REQUIRED',
          lastError: publicError,
          executionOwner: null,
          executionLeaseExpiresAt: null
        }),
        {
          expectedStateVersion: current.stateVersion,
          expectedExecutionEpoch: current.executionEpoch
        }
      );
    }
    await this.store.appendRecoveryEvent(job.jobId, {
      schemaVersion: 1,
      kind,
      executionEpoch: current.executionEpoch,
      stateVersion: current.stateVersion,
      error: publicError,
      details: safeDurableClone(redact(details), 'runner recovery details')
    });
    fail('RECOVERY_REQUIRED', `Job ${job.jobId} requires reconciliation before execution can continue`);
  }

  async renewLease(job, epoch) {
    return this.store.renewExecution(job.jobId, {
      expectedStateVersion: job.stateVersion,
      expectedExecutionEpoch: epoch,
      ownerId: this.ownerId,
      leaseMs: this.leaseMs
    });
  }

  async reconcile(job, plan, target, epoch) {
    const capability = plan.connectorBinding.target.capabilityProfile.target;
    if (!job.pendingBatch || capability.reconcileAfterCrash !== true || typeof target.reconcileTargetCommit !== 'function') {
      await this.enterRecoveryRequired(job, { code: 'RECONCILIATION_UNAVAILABLE' }, 'reconciliation_required', {
        targetConnector: plan.targetRef.connector,
        targetResource: plan.targetRef.resource,
        hasPendingBatch: Boolean(job.pendingBatch),
        reconcileAfterCrash: capability.reconcileAfterCrash === true
      });
    }

    let result;
    try {
      result = validateReconciliationResult(await target.reconcileTargetCommit(
        {
          connection: target.connection,
          planId: plan.planId,
          jobId: job.jobId,
          executionEpoch: epoch,
          batchIdentity: job.pendingBatch.batchIdentity
        },
        {
          resource: plan.targetRef.resource,
          pendingBatch: safeDurableClone(job.pendingBatch, 'reconciliation pending batch'),
          previousCheckpoint: job.checkpoint ? safeDurableClone(job.checkpoint, 'reconciliation checkpoint') : null
        }
      ));
    } catch (error) {
      await this.enterRecoveryRequired(job, error, 'target_reconciliation_error', {
        targetConnector: plan.targetRef.connector,
        targetResource: plan.targetRef.resource,
        batchIdentity: job.pendingBatch.batchIdentity
      });
    }

    if (result.status === 'UNKNOWN') {
      await this.enterRecoveryRequired(job, { code: 'TARGET_RECONCILIATION_UNKNOWN' }, 'target_reconciliation_unknown', {
        targetConnector: plan.targetRef.connector,
        targetResource: plan.targetRef.resource,
        batchIdentity: job.pendingBatch.batchIdentity
      });
    }

    if (result.status === 'COMMITTED') {
      let checkpoint;
      try {
        checkpoint = checkpointFromPending(plan, job.pendingBatch, result.ack);
      } catch (error) {
        await this.enterRecoveryRequired(job, error, 'target_reconciliation_evidence_invalid', {
          targetConnector: plan.targetRef.connector,
          targetResource: plan.targetRef.resource,
          batchIdentity: job.pendingBatch.batchIdentity
        });
      }
      job = await this.store.commitCheckpoint(job.jobId, checkpoint, {
        expectedStateVersion: job.stateVersion,
        expectedExecutionEpoch: epoch
      });
    } else if (result.status === 'NOT_COMMITTED') {
      job = await this.store.clearPendingBatch(job.jobId, {
        expectedStateVersion: job.stateVersion,
        expectedExecutionEpoch: epoch
      });
    }

    return this.store.update(
      job.jobId,
      current => ({ ...current, state: 'RUNNING', lastError: null }),
      { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: epoch }
    );
  }

  async run({ plan, sourceConfig = {}, targetConfig = {}, jobId } = {}) {
    validateMigrationPlan(plan);
    if (!plan.connectorBinding) {
      fail('PLAN_CONNECTOR_BINDING_REQUIRED', 'Shared runner requires a capability-bound migration plan');
    }

    let source = null;
    let target = null;
    let job = null;

    try {
      source = await this.registry.open(plan.sourceRef.connector, sourceConfig, { role: 'source', planId: plan.planId });
      target = await this.registry.open(plan.targetRef.connector, targetConfig, { role: 'target', planId: plan.planId });

      assertPlanConnectorCompatibility(plan, {
        sourceManifest: source.manifest(),
        targetManifest: target.manifest()
      });

      job = jobId ? await this.store.load(jobId) : await this.store.create(plan);
      if (job.planId !== plan.planId || job.planRevision !== plan.planRevision) {
        fail('JOB_PLAN_MISMATCH', 'Existing job does not belong to the supplied plan');
      }
      if (job.state === 'COMPLETE') {
        const receipt = await this.store.loadReceipt(job.receiptId);
        return { job, receipt };
      }
      if (job.state === 'RECOVERY_REQUIRED' && !plan.connectorBinding.requirements.restartResume) {
        fail('RECOVERY_REQUIRED', `Job ${job.jobId} cannot auto-resume under a non-resumable plan`);
      }

      job = await this.store.acquireExecution(job.jobId, {
        expectedStateVersion: job.stateVersion,
        ownerId: this.ownerId,
        leaseMs: this.leaseMs
      });
      const epoch = job.executionEpoch;

      if (job.state === 'RECOVERING') {
        job = await this.reconcile(job, plan, target, epoch);
      }

      if (job.state === 'PLANNED' || job.state === 'PAUSED') {
        job = await this.store.update(
          job.jobId,
          current => ({ ...current, state: 'RUNNING' }),
          { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: epoch }
        );
      }
      if (job.state !== 'RUNNING') {
        fail('INVALID_JOB_TRANSITION', `Shared runner cannot execute job from ${job.state}`);
      }

      const batchSize = batchSizeFor(plan);
      const sourceCursor = job.checkpoint?.sourceCursor ?? null;
      const stream = source.read(
        { connection: source.connection, planId: plan.planId, jobId: job.jobId },
        { resource: plan.sourceRef.resource, batchSize, cursor: sourceCursor }
      );
      assertAsyncIterable(stream);

      for await (const batch of stream) {
        if (!batch || !Array.isArray(batch.rows) || !batch.cursor) {
          fail('INVALID_ROW_BATCH', 'Source connector emitted an invalid row batch');
        }

        const transformed = this.engine.run(batch.rows, plan.mapping, plan.planRevision, plan.targetSchema);
        const payloadHash = await sha256Json(transformed.output);
        job = await this.renewLease(job, epoch);

        const pendingBatch = await buildPendingBatch(plan, job, batch, transformed, payloadHash);
        job = await this.store.beginPendingBatch(job.jobId, pendingBatch, {
          expectedStateVersion: job.stateVersion,
          expectedExecutionEpoch: epoch
        });

        let ack;
        try {
          ack = await target.write(
            {
              connection: target.connection,
              planId: plan.planId,
              jobId: job.jobId,
              executionEpoch: epoch,
              batchIdentity: pendingBatch.batchIdentity
            },
            writeRequestFor(plan),
            oneBatch(transformed.output)
          );
        } catch (error) {
          await this.enterRecoveryRequired(job, error, 'target_commit_ambiguous', {
            targetConnector: plan.targetRef.connector,
            targetResource: plan.targetRef.resource,
            batchIdentity: pendingBatch.batchIdentity
          });
        }

        let checkpoint;
        try {
          checkpoint = checkpointFromPending(plan, pendingBatch, ack);
        } catch (error) {
          await this.enterRecoveryRequired(job, error, 'target_commit_evidence_missing', {
            targetConnector: plan.targetRef.connector,
            targetResource: plan.targetRef.resource,
            batchIdentity: pendingBatch.batchIdentity
          });
        }

        job = await this.store.commitCheckpoint(job.jobId, checkpoint, {
          expectedStateVersion: job.stateVersion,
          expectedExecutionEpoch: epoch
        });
      }

      job = await this.store.update(
        job.jobId,
        current => ({ ...current, state: 'VERIFYING' }),
        { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: epoch }
      );
      job = await this.renewLease(job, epoch);

      let verificationResult;
      try {
        verificationResult = await target.verify(
          { connection: target.connection, planId: plan.planId, jobId: job.jobId, executionEpoch: epoch },
          verificationRequestFor(plan, job.counts)
        );
      } catch (error) {
        await this.enterRecoveryRequired(job, error, 'verification_error', {
          targetConnector: plan.targetRef.connector,
          targetResource: plan.targetRef.resource
        });
      }

      const verification = boundedVerificationEvidence(verificationResult);
      if (!verification.ok) {
        await this.enterRecoveryRequired(job, { code: 'TARGET_VERIFICATION_FAILED' }, 'verification_failed', {
          targetConnector: plan.targetRef.connector,
          targetResource: plan.targetRef.resource,
          verification
        });
      }

      job = await this.store.update(
        job.jobId,
        current => ({ ...current, verification }),
        { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: epoch }
      );

      const receiptJob = {
        ...job,
        state: 'COMPLETE',
        completedAt: new Date().toISOString()
      };
      const receipt = await createReceipt({
        job: receiptJob,
        plan,
        connectors: [connectorReceiptIdentity(source), connectorReceiptIdentity(target)],
        verification,
        policyEvents: []
      });

      job = await this.store.finalizeVerifiedJob(job.jobId, receipt, {
        expectedStateVersion: job.stateVersion,
        expectedExecutionEpoch: epoch
      });

      return { job, receipt };
    } finally {
      const closers = [];
      if (source && typeof source.close === 'function') closers.push(Promise.resolve().then(() => source.close()));
      if (target && typeof target.close === 'function') closers.push(Promise.resolve().then(() => target.close()));
      if (closers.length) await Promise.allSettled(closers);
    }
  }
}
