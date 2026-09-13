import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { inferSchema } from '../core/schema.js';
import { MigrationEngine } from '../core/migration.js';
import { ConnectorRegistry } from '../connectors/registry.js';
import {
  SQLITE_TARGET_DESCRIPTOR,
  createSqliteTargetRuntime
} from '../connectors/sqlite/runtime.js';
import {
  POSTGRES_TARGET_DESCRIPTOR,
  createPostgresTargetRuntime
} from '../connectors/postgres/runtime.js';
import { createPathPolicy } from '../platform/path-policy.js';
import { connectorIdentity } from '../platform/contracts.js';
import { createMigrationPlan } from '../platform/plan.js';
import { createBoundApproval, assertBoundApproval } from '../platform/approval.js';
import { createBatchIdentity } from '../execution/batch-identity.js';
import { assertCheckpointBinding } from '../execution/checkpoint.js';
import { MigrationRunner } from '../execution/migration-runner.js';
import { verifyMigration } from '../execution/verify.js';
import { createMigrationReceipt } from '../execution/receipt.js';
import { createRepairPlan } from '../execution/repair-plan.js';
import { createContentVerificationAccumulator } from '../execution/content-verification-manifest.js';
import { CredentialBroker } from './credential-broker.js';
import { createDurableSourceCoordinator } from './durable-source.js';
import { migrationRequestSemanticId } from './request-semantics.js';
import { RunStore } from './run-store.js';

export { migrationRequestSemanticId } from './request-semantics.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const INFERENCE_SAMPLE_SIZE = 1000;

function requireRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_MIGRATION_REQUEST', 'Migration request must be an object');
  if (!MIGRATION_ID.test(request.migrationId ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  if (typeof request.principal !== 'string' || !request.principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
  if (!request.planInput || typeof request.planInput !== 'object' || Array.isArray(request.planInput)) fail('INVALID_MIGRATION_REQUEST', 'planInput is required');
}

function approvalBinding(request, plan, snapshot, targetContractId, effects, expiresAt, nonce) {
  return {
    migrationId: request.migrationId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    sourceSnapshotId: snapshot.snapshotId,
    targetIdentity: plan.targetRef,
    targetContractId,
    effects: [...effects].sort(),
    writeStrategy: plan.writeStrategy,
    principal: request.principal,
    expiresAt,
    nonce
  };
}

function canonicalViolationSummary(violations) {
  return violations.map(item => Object.freeze({ code: item.code, count: item.count, message: item.message })).sort((a, b) => a.code.localeCompare(b.code));
}

function releaseIdentity(release) {
  if (!release || typeof release !== 'object' || typeof release.version !== 'string' || !release.version || !/^[a-f0-9]{40}$/.test(release.commitSha ?? '')) {
    fail('RELEASE_IDENTITY_REQUIRED', 'Production command service requires {version, commitSha} with an exact git SHA');
  }
  return Object.freeze({ version: release.version, commitSha: release.commitSha });
}

function requiresContentExact(plan) {
  return Array.isArray(plan?.verification?.checks) && plan.verification.checks.includes('content_exact');
}

function assertContentVerificationCapability(plan, targetRuntime) {
  if (!requiresContentExact(plan)) return;
  if (plan.capabilityAssumptions?.target?.readAfterWriteVerification !== true) {
    fail('CONTENT_VERIFICATION_CAPABILITY_UNDECLARED', 'content_exact requires capabilityAssumptions.target.readAfterWriteVerification=true');
  }
  if (targetRuntime?.descriptor?.capabilities?.readAfterWriteVerification !== true) {
    fail('CONTENT_VERIFICATION_CAPABILITY_REQUIRED', 'Target connector cannot prove exact read-after-write content');
  }
}

function sameExecutionSummary(left, right) {
  return left.processedRows === right.processedRows && left.validRows === right.validRows && left.invalidRows === right.invalidRows;
}

export class SpoolCommandService {
  static async create(options = {}) {
    if (typeof options.sourceRoot !== 'string' || typeof options.targetRoot !== 'string') fail('INVALID_SERVICE_CONFIG', 'sourceRoot and targetRoot are required');
    if (typeof options.statePath !== 'string' || !options.statePath) fail('INVALID_SERVICE_CONFIG', 'statePath is required');
    if (typeof options.approvalSigningKey !== 'string' && !Buffer.isBuffer(options.approvalSigningKey) && !(options.approvalSigningKey instanceof Uint8Array)) {
      fail('INVALID_SERVICE_CONFIG', 'approvalSigningKey is required');
    }
    const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) fail('INVALID_SERVICE_CONFIG', 'maxSourceBytes must be a positive safe integer');

    const snapshotRoot = resolve(options.snapshotDir ?? `${options.statePath}.snapshots`);
    const sourcePolicy = await createPathPolicy(options.sourceRoot);
    const credentialBroker = options.credentialBroker ?? new CredentialBroker();
    if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_SERVICE_CONFIG', 'credentialBroker.withSecret() is required');
    const sourceCoordinator = createDurableSourceCoordinator({
      sourcePolicy,
      credentialBroker,
      maxSourceBytes,
      sampleSize: INFERENCE_SAMPLE_SIZE
    });

    const targetConnectors = new ConnectorRegistry();
    const sqliteTargetRuntime = await createSqliteTargetRuntime({ targetRoot: options.targetRoot });
    const postgresTargetRuntime = createPostgresTargetRuntime({
      credentialBroker,
      leaseTtlMs: options.postgresLeaseTtlMs
    });
    targetConnectors.register(SQLITE_TARGET_DESCRIPTOR, async () => sqliteTargetRuntime);
    targetConnectors.register(POSTGRES_TARGET_DESCRIPTOR, async () => postgresTargetRuntime);

    return new SpoolCommandService({
      sourcePolicy,
      sourceCoordinator,
      targetConnectors,
      statePath: options.statePath,
      snapshotRoot,
      approvalSigningKey: options.approvalSigningKey,
      maxSourceBytes,
      release: releaseIdentity(options.release ?? {
        version: process.env.SPOOL_RELEASE_VERSION ?? '1.0.0',
        commitSha: process.env.SPOOL_COMMIT_SHA
      })
    });
  }

  constructor({ sourcePolicy, sourceCoordinator, targetConnectors, statePath, snapshotRoot, approvalSigningKey, maxSourceBytes, release }) {
    this.sourcePolicy = sourcePolicy;
    this.sourceCoordinator = sourceCoordinator;
    this.targetConnectors = targetConnectors;
    this.snapshotRoot = snapshotRoot;
    this.approvalSigningKey = approvalSigningKey;
    this.maxSourceBytes = maxSourceBytes;
    this.release = release;
    this.runs = new RunStore({ path: statePath });
    this.closed = false;
  }

  #open() { if (this.closed) fail('COMMAND_SERVICE_CLOSED', 'Command service is closed'); }

  #migrationSnapshotDir(migrationId) {
    return join(this.snapshotRoot, encodeURIComponent(migrationId));
  }

  async #cleanupSnapshots(migrationId) {
    await rm(this.#migrationSnapshotDir(migrationId), { recursive: true, force: true });
  }

  async #openTargetRuntime(targetRef) {
    const connector = targetRef?.connector;
    if (typeof connector !== 'string' || !connector) fail('INVALID_TARGET_REF', 'targetRef.connector is required');
    try {
      return await this.targetConnectors.open(connector, 'target', undefined, undefined, { minimumAssurance: 'C4' });
    } catch (error) {
      if (error?.code === 'CONNECTOR_NOT_REGISTERED') fail('UNSUPPORTED_TARGET_CONNECTOR', `Unsupported target connector ${connector}`);
      throw error;
    }
  }

  async #prepare(request, { expectedSourceSnapshotId = null } = {}) {
    this.#open(); requireRequest(request);
    let input = structuredClone(request.planInput);
    const targetRuntime = await this.#openTargetRuntime(input.targetRef);
    const source = await this.sourceCoordinator.prepare(input.sourceRef, {
      snapshotDir: this.#migrationSnapshotDir(request.migrationId),
      expectedSourceSnapshotId
    });
    input.sourceRef = structuredClone(source.sourceRef);
    input = await targetRuntime.normalizePlanInput(input);
    const plan = await createMigrationPlan(input);
    if (!plan.risk.approvals.includes('target_write')) fail('TARGET_WRITE_APPROVAL_REQUIRED', 'Production target mutations require target_write in plan.risk.approvals');
    assertContentVerificationCapability(plan, targetRuntime);
    const targetPreflight = await targetRuntime.preflight(plan);
    return {
      request, plan, snapshot: source.snapshot, source, sourceRows: source.sourceRows,
      sourceHeaders: source.sourceHeaders, sampleRows: source.sampleRows, sourcePath: source.sourcePath,
      targetRuntime, targetPreflight
    };
  }

  async inspect(request) {
    const prepared = await this.#prepare(request);
    return Object.freeze({
      migrationId: request.migrationId,
      sourceRows: prepared.sourceRows,
      sourceBytes: prepared.source.sourceBytes,
      sourceSnapshotId: prepared.snapshot.snapshotId,
      sourceSchema: Object.freeze(inferSchema(prepared.sampleRows).map(field => Object.freeze({ ...field }))),
      target: Object.freeze(connectorIdentity(prepared.plan.targetRef)),
      targetContractId: prepared.targetPreflight.targetContractId,
      targetPreflight: Object.freeze({
        status: prepared.targetPreflight.status,
        columns: prepared.targetPreflight.columns,
        indexes: prepared.targetPreflight.indexes,
        foreignKeys: prepared.targetPreflight.foreignKeys
      }),
      maxSourceBytes: prepared.source.connector === 'filesystem' ? this.maxSourceBytes : null
    });
  }

  async plan(request) { return (await this.#prepare(request)).plan; }

  async dryRun(request) {
    const prepared = await this.#prepare(request);
    const accumulator = new MigrationEngine().createAccumulator(prepared.plan.mapping, prepared.plan.mappingRevision, prepared.plan.targetSchema);
    for await (const { rowIndex, row } of prepared.source.streamRows()) accumulator.process(row, rowIndex);
    const result = accumulator.summary();
    return Object.freeze({
      migrationId: request.migrationId,
      planId: prepared.plan.planId,
      sourceSnapshotId: prepared.snapshot.snapshotId,
      targetContractId: prepared.targetPreflight.targetContractId,
      processedRows: result.processedRows,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      violations: Object.freeze(canonicalViolationSummary(result.violations))
    });
  }

  async approve(request, { expiresAt, nonce } = {}) {
    const prepared = await this.#prepare(request);
    if (typeof expiresAt !== 'string' || typeof nonce !== 'string') fail('INVALID_APPROVAL_REQUEST', 'expiresAt and nonce are required');
    const effects = await prepared.targetRuntime.approvalEffects(prepared.plan);
    return createBoundApproval(
      approvalBinding(request, prepared.plan, prepared.snapshot, prepared.targetPreflight.targetContractId, effects, expiresAt, nonce),
      { signingKey: this.approvalSigningKey }
    );
  }

  runSyncGuard() { fail('ASYNC_COMMAND_ONLY', 'Production command execution is asynchronous'); }

  async run(request, { approval = null } = {}) {
    this.#open(); requireRequest(request);
    const requestSemanticId = migrationRequestSemanticId(request);
    const current = this.runs.get(request.migrationId);
    if (current?.status === 'COMPLETE' && current.receipt?.record?.requestSemanticId) {
      if (current.receipt.record.requestSemanticId !== requestSemanticId) fail('MIGRATION_ID_REUSE_CONFLICT', 'Completed migrationId cannot be reused for changed request semantics');
      try { await this.#cleanupSnapshots(request.migrationId); } catch { }
      return Object.freeze({ status: 'COMPLETE', verification: current.verification, receipt: current.receipt, replay: true });
    }

    const expectedSourceSnapshotId = current?.status === 'COMPLETE' ? null : (approval?.record?.sourceSnapshotId ?? null);
    const prepared = await this.#prepare(request, { expectedSourceSnapshotId });
    const { plan, snapshot, source, sourceRows, targetRuntime, targetPreflight } = prepared;
    const targetIdentity = connectorIdentity(plan.targetRef);
    if (current?.status === 'COMPLETE') {
      const priorContractId = current.receipt?.record?.targetContractId ?? null;
      if (current.planId !== plan.planId || current.sourceSnapshotId !== snapshot.snapshotId || JSON.stringify(current.targetIdentity) !== JSON.stringify(targetIdentity) || priorContractId !== targetPreflight.targetContractId) {
        fail('MIGRATION_ID_REUSE_CONFLICT', 'Completed migrationId cannot be reused for changed semantics or target contract');
      }
      try { await this.#cleanupSnapshots(request.migrationId); } catch { }
      return Object.freeze({ status: 'COMPLETE', verification: current.verification, receipt: current.receipt, replay: true });
    }

    if (!approval) fail('APPROVAL_REQUIRED', 'This migration plan requires bound approval evidence');
    const effects = await targetRuntime.approvalEffects(plan);
    assertBoundApproval(
      approval,
      approvalBinding(request, plan, snapshot, targetPreflight.targetContractId, effects, approval.record?.expiresAt, approval.record?.nonce),
      { signingKey: this.approvalSigningKey }
    );
    await source.verify();

    const startedAt = current?.startedAt ?? new Date().toISOString();
    const targetExecution = await targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: plan.targetRef });
    let lease;
    let ownsRunState = false;
    const renewLease = async () => { lease = await targetExecution.renewLease(); return lease; };

    try {
      await renewLease();
      this.runs.start({ migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId, targetIdentity, startedAt });
      ownsRunState = true;
      const target = await targetExecution.openTarget();
      const checkpointStore = this.runs.checkpointStore(request.migrationId);
      const runner = new MigrationRunner({ target, checkpointStore });
      const accumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
      const batchSize = plan.writeStrategy.batchSize;
      const allRanges = [];
      for (let start = 0; start < sourceRows; start += batchSize) allRanges.push({ start, endExclusive: Math.min(sourceRows, start + batchSize) });
      const expectedBatchIdentities = allRanges.map(sourceRange => createBatchIdentity({
        migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId,
        mappingRevision: plan.mappingRevision, sourceRange, targetIdentity: plan.targetRef
      }));
      const checkpoint = await checkpointStore.load();
      const resumeOffset = checkpoint?.nextOffset ?? 0;
      if (checkpoint) assertCheckpointBinding(checkpoint, {
        migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId,
        mappingRevision: plan.mappingRevision, targetIdentity: plan.targetRef
      });
      if (resumeOffset > sourceRows) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint exceeds source row count');
      if (resumeOffset !== sourceRows && resumeOffset % batchSize !== 0) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint falls inside a batch boundary');

      let batchRows = [];
      let lastSeenRow = -1;
      for await (const { rowIndex, row } of source.streamRows()) {
        lastSeenRow = rowIndex;
        const transformed = accumulator.process(row, rowIndex);
        const sourceRangeStart = Math.floor(rowIndex / batchSize) * batchSize;
        const sourceRangeEnd = Math.min(sourceRows, sourceRangeStart + batchSize);
        if (rowIndex >= resumeOffset && transformed.ok) batchRows.push(transformed.row);
        if (rowIndex + 1 === sourceRangeEnd) {
          if (sourceRangeEnd <= resumeOffset) { batchRows = []; continue; }
          if (sourceRangeStart < resumeOffset) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint falls inside a batch boundary');
          await renewLease();
          await runner.runBatchAsync({
            migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId,
            mappingRevision: plan.mappingRevision, sourceRange: { start: sourceRangeStart, endExclusive: sourceRangeEnd },
            targetIdentity: plan.targetRef, targetContractId: targetPreflight.targetContractId, rows: batchRows,
            fencingToken: lease.fencingToken
          });
          batchRows = [];
        }
      }
      if (lastSeenRow + 1 !== sourceRows) fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed between preparation and execution');
      if (batchRows.length !== 0) fail('INTERNAL_BATCH_STATE', 'Streaming execution ended with an uncommitted batch');

      const summary = accumulator.summary();
      const ledgerEntries = await targetExecution.ledgerEntries();
      const basicVerification = verifyMigration({
        sourceRows, writtenRows: summary.validRows, rejectedRows: summary.invalidRows, filteredRows: 0,
        expectedBatchIdentities, ledgerEntries
      });

      let verification = basicVerification;
      if (requiresContentExact(plan)) {
        if (typeof targetExecution.withContentVerifier !== 'function') {
          fail('CONTENT_VERIFICATION_CAPABILITY_REQUIRED', 'Target execution does not implement content verification sessions');
        }
        this.runs.clearVerificationBatches(request.migrationId);
        const replayAccumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
        const content = await targetExecution.withContentVerifier({
          targetSchema: plan.targetSchema,
          targetContractId: targetPreflight.targetContractId
        }, async verifier => {
          const evidence = createContentVerificationAccumulator({ targetReadState: verifier.targetReadState });
          let expectedRows = [];
          let replayLastSeen = -1;
          let ordinal = 0;
          for await (const { rowIndex, row } of source.streamRows()) {
            replayLastSeen = rowIndex;
            const transformed = replayAccumulator.process(row, rowIndex);
            if (transformed.ok) expectedRows.push(transformed.row);
            const sourceRangeStart = Math.floor(rowIndex / batchSize) * batchSize;
            const sourceRangeEnd = Math.min(sourceRows, sourceRangeStart + batchSize);
            if (rowIndex + 1 === sourceRangeEnd) {
              await renewLease();
              const contentProof = await verifier.verifyBatch(expectedRows);
              const repair = contentProof.status === 'DIFF' ? createRepairPlan({
                migrationId: request.migrationId,
                planId: plan.planId,
                sourceSnapshotId: snapshot.snapshotId,
                targetIdentity: plan.targetRef,
                targetContractId: targetPreflight.targetContractId,
                verification: contentProof
              }) : null;
              const sourceRange = { start: sourceRangeStart, endExclusive: sourceRangeEnd };
              this.runs.saveVerificationBatch({
                migrationId: request.migrationId,
                ordinal,
                sourceRange,
                verification: contentProof,
                repair
              });
              evidence.add({ sourceRange, verification: contentProof });
              expectedRows = [];
              ordinal += 1;
            }
          }
          if (replayLastSeen + 1 !== sourceRows) fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed during verification replay');
          if (expectedRows.length !== 0) fail('INTERNAL_BATCH_STATE', 'Content verification replay ended with an incomplete batch');
          return evidence.summary();
        });
        const replaySummary = replayAccumulator.summary();
        if (!sameExecutionSummary(summary, replaySummary)) {
          fail('TRANSFORM_REPLAY_DIVERGED', 'Deterministic transform replay produced different row accounting', {
            execution: { processedRows: summary.processedRows, validRows: summary.validRows, invalidRows: summary.invalidRows },
            verification: { processedRows: replaySummary.processedRows, validRows: replaySummary.validRows, invalidRows: replaySummary.invalidRows }
          });
        }
        if (content.sourceRowsCovered !== sourceRows || content.rowCount !== summary.validRows) {
          fail('CONTENT_VERIFICATION_ACCOUNTING_MISMATCH', 'Content verification evidence does not cover the executed output exactly', {
            sourceRows, sourceRowsCovered: content.sourceRowsCovered, writtenRows: summary.validRows, verifiedRows: content.rowCount
          });
        }
        verification = Object.freeze({ ...basicVerification, content });
        if (content.status !== 'VERIFIED') {
          this.runs.verificationFailed({ migrationId: request.migrationId, verification });
          fail('VERIFICATION_FAILED', 'Exact target-content verification found deterministic differences', {
            rootHash: content.rootHash,
            diffCounts: content.diffCounts
          });
        }
      }

      const completedAt = new Date().toISOString();
      const receipt = createMigrationReceipt({
        release: this.release,
        migrationId: request.migrationId,
        requestSemanticId,
        planId: plan.planId,
        sourceSnapshotId: snapshot.snapshotId,
        targetIdentity: plan.targetRef,
        targetContractId: targetPreflight.targetContractId,
        batchIdentities: expectedBatchIdentities,
        counts: { sourceRows, writtenRows: summary.validRows, rejectedRows: summary.invalidRows, filteredRows: 0 },
        violationsSummary: canonicalViolationSummary(summary.violations).map(({ code, count }) => ({ code, count })),
        verification,
        startedAt,
        completedAt
      });
      this.runs.complete({ migrationId: request.migrationId, verification, receipt, completedAt });
      try { this.runs.clearCheckpoint(request.migrationId); } catch { }
      try { await this.#cleanupSnapshots(request.migrationId); } catch { }
      return Object.freeze({ status: 'COMPLETE', verification, receipt, replay: false });
    } catch (error) {
      if (ownsRunState) {
        const existing = this.runs.get(request.migrationId);
        if (existing?.status !== 'COMPLETE' && existing?.status !== 'VERIFICATION_FAILED') {
          this.runs.fail({ migrationId: request.migrationId, errorCode: error?.code ?? 'MIGRATION_FAILED' });
        }
      }
      throw error;
    } finally {
      await targetExecution.close();
    }
  }

  status(migrationId) { this.#open(); return this.runs.get(migrationId); }
  verification(migrationId) { const run = this.status(migrationId); if (!run?.verification) fail('VERIFICATION_NOT_AVAILABLE', 'Verification is not available'); return run.verification; }
  receipt(migrationId) { const run = this.status(migrationId); if (!run?.receipt) fail('RECEIPT_NOT_AVAILABLE', 'Receipt is not available'); return run.receipt; }
  repairEvidence(migrationId) {
    this.#open();
    return Object.freeze(this.runs.verificationBatches(migrationId)
      .filter(item => item.repair != null)
      .map(item => Object.freeze({ ordinal: item.ordinal, sourceRange: item.sourceRange, repair: item.repair })));
  }
  close() { if (!this.closed) { this.runs.close(); this.closed = true; } }
}
