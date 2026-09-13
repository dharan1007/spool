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
import {
  MYSQL_TARGET_DESCRIPTOR,
  createMysqlTargetRuntime
} from '../connectors/mysql/runtime.js';
import {
  MSSQL_TARGET_DESCRIPTOR,
  createMssqlTargetRuntime
} from '../connectors/mssql/runtime.js';
import { createPathPolicy } from '../platform/path-policy.js';
import { canonicalJson } from '../platform/canonical-json.js';
import { connectorIdentity } from '../platform/contracts.js';
import { createMigrationPlan } from '../platform/plan.js';
import { createBoundApproval, assertBoundApproval } from '../platform/approval.js';
import { createRepairApproval, assertRepairApproval } from '../platform/repair-approval.js';
import { createBatchIdentity } from '../execution/batch-identity.js';
import { assertCheckpointBinding } from '../execution/checkpoint.js';
import { MigrationRunner } from '../execution/migration-runner.js';
import { verifyMigration } from '../execution/verify.js';
import { createMigrationReceipt, createRepairReceipt } from '../execution/receipt.js';
import { createRepairPlan } from '../execution/repair-plan.js';
import { executeRepairOperations, summarizeRepairOperations } from '../execution/repair-runner.js';
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

function requiresBulkWrite(plan) {
  return plan?.writeStrategy?.bulk === true;
}

function assertBulkWriteCapability(plan, targetRuntime) {
  if (!requiresBulkWrite(plan)) return;
  if (targetRuntime?.descriptor?.capabilities?.bulkWrite !== true) {
    fail('BULK_WRITE_CAPABILITY_REQUIRED', 'Target connector cannot execute bulk COPY writes');
  }
}

function repairApprovalEffects(connector) {
  if (typeof connector !== 'string' || !connector) fail('INVALID_TARGET_REF', 'targetRef.connector is required');
  return Object.freeze([`${connector}:apply_repair`, `${connector}:read_after_write_verify`].sort());
}

function assertRepairCapability(targetRuntime, targetExecution = null) {
  if (targetRuntime?.descriptor?.capabilities?.repairExecution !== true) {
    fail('REPAIR_CAPABILITY_REQUIRED', 'Target connector cannot execute fenced repair operations');
  }
  if (targetExecution != null && (typeof targetExecution.applyRepairOperation !== 'function' || typeof targetExecution.withContentVerifier !== 'function')) {
    fail('REPAIR_CAPABILITY_REQUIRED', 'Target execution does not implement repair execution and re-verification');
  }
}

function repairApprovalBinding({ migrationId, plans, plan, snapshot, targetContractId, effects, principal, expiresAt, nonce }) {
  return {
    migrationId,
    repairPlanIds: plans.map(item => item.repairPlanId),
    planId: plan.planId,
    sourceSnapshotId: snapshot.snapshotId,
    targetIdentity: plan.targetRef,
    targetContractId,
    effects: [...effects].sort(),
    principal,
    expiresAt,
    nonce
  };
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
    const mysqlTargetRuntime = createMysqlTargetRuntime({
      credentialBroker,
      leaseTtlMs: options.mysqlLeaseTtlMs
    });
    const mssqlTargetRuntime = createMssqlTargetRuntime({
      credentialBroker,
      leaseTtlMs: options.mssqlLeaseTtlMs
    });
    targetConnectors.register(SQLITE_TARGET_DESCRIPTOR, async () => sqliteTargetRuntime);
    targetConnectors.register(POSTGRES_TARGET_DESCRIPTOR, async () => postgresTargetRuntime);
    targetConnectors.register(MYSQL_TARGET_DESCRIPTOR, async () => mysqlTargetRuntime);
    targetConnectors.register(MSSQL_TARGET_DESCRIPTOR, async () => mssqlTargetRuntime);

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
    assertBulkWriteCapability(plan, targetRuntime);
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
    requireRequest(request); this.#requireCutoverOpen(request.migrationId);
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
    this.#open(); requireRequest(request); this.#requireCutoverOpen(request.migrationId);
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
            fencingToken: lease.fencingToken, bulk: plan.writeStrategy.bulk === true
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

  #repairPlans(migrationId, repairPlanIds) {
    const wanted = new Set(repairPlanIds);
    const plans = this.runs.verificationBatches(migrationId)
      .filter(item => item.repair != null && wanted.has(item.repair.repairPlanId))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(item => item.repair);
    if (plans.length !== wanted.size) fail('REPAIR_PLAN_UNKNOWN', 'One or more repair plans are not part of the stored verification evidence');
    return Object.freeze(plans);
  }

  async #reverifyContentExact({ migrationId, source, plan, sourceRows, targetExecution, targetPreflight, renewLease }) {
    const batchSize = plan.writeStrategy.batchSize;
    const replayAccumulator = new MigrationEngine().createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
    const content = await targetExecution.withContentVerifier({
      targetSchema: plan.targetSchema,
      targetContractId: targetPreflight.targetContractId
    }, async verifier => {
      const evidence = createContentVerificationAccumulator({ targetReadState: verifier.targetReadState });
      let expectedRows = [];
      let replayLastSeen = -1;
      for await (const { rowIndex, row } of source.streamRows()) {
        replayLastSeen = rowIndex;
        const transformed = replayAccumulator.process(row, rowIndex);
        if (transformed.ok) expectedRows.push(transformed.row);
        const sourceRangeStart = Math.floor(rowIndex / batchSize) * batchSize;
        const sourceRangeEnd = Math.min(sourceRows, sourceRangeStart + batchSize);
        if (rowIndex + 1 === sourceRangeEnd) {
          await renewLease();
          evidence.add({
            sourceRange: { start: sourceRangeStart, endExclusive: sourceRangeEnd },
            verification: await verifier.verifyBatch(expectedRows)
          });
          expectedRows = [];
        }
      }
      if (replayLastSeen + 1 !== sourceRows) fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed during repair re-verification');
      if (expectedRows.length !== 0) fail('INTERNAL_BATCH_STATE', 'Repair re-verification ended with an incomplete batch');
      return evidence.summary();
    });
    const expectedValidRows = this.runs.verificationBatches(migrationId)
      .reduce((total, item) => total + (item.verification?.expected?.rowCount ?? 0), 0);
    const replaySummary = replayAccumulator.summary();
    if (replaySummary.processedRows !== sourceRows || replaySummary.validRows !== expectedValidRows || replaySummary.invalidRows !== sourceRows - expectedValidRows) {
      fail('TRANSFORM_REPLAY_DIVERGED', 'Deterministic transform replay produced different row accounting during repair re-verification');
    }
    if (content.sourceRowsCovered !== sourceRows || content.rowCount !== expectedValidRows) {
      fail('CONTENT_VERIFICATION_ACCOUNTING_MISMATCH', 'Repair re-verification evidence does not cover the executed output exactly', {
        sourceRows, sourceRowsCovered: content.sourceRowsCovered, verifiedRows: content.rowCount
      });
    }
    return content;
  }

  async approveRepair(request, { repairPlanIds, expiresAt, nonce } = {}) {
    this.#open(); requireRequest(request); this.#requireCutoverOpen(request.migrationId);
    if (!Array.isArray(repairPlanIds) || repairPlanIds.length === 0) fail('INVALID_REPAIR_REQUEST', 'repairPlanIds must be a non-empty array');
    if (typeof expiresAt !== 'string' || typeof nonce !== 'string') fail('INVALID_REPAIR_REQUEST', 'expiresAt and nonce are required');
    const run = this.runs.get(request.migrationId);
    if (!run || run.status !== 'VERIFICATION_FAILED') fail('REPAIR_NOT_REQUIRED', 'Repair approval requires a run in VERIFICATION_FAILED status');
    const prepared = await this.#prepare(request, { expectedSourceSnapshotId: run.sourceSnapshotId });
    assertRepairCapability(prepared.targetRuntime);
    const plans = this.#repairPlans(request.migrationId, repairPlanIds);
    return createRepairApproval(
      repairApprovalBinding({
        migrationId: request.migrationId,
        plans,
        plan: prepared.plan,
        snapshot: prepared.snapshot,
        targetContractId: prepared.targetPreflight.targetContractId,
        effects: repairApprovalEffects(prepared.plan.targetRef.connector),
        principal: request.principal,
        expiresAt,
        nonce
      }),
      { signingKey: this.approvalSigningKey }
    );
  }

  async runRepair(request, { repairApproval = null } = {}) {
    this.#open(); requireRequest(request); this.#requireCutoverOpen(request.migrationId);
    if (!repairApproval) fail('REPAIR_APPROVAL_REQUIRED', 'Repair execution requires a separately-authorized repair approval');
    const run = this.runs.get(request.migrationId);
    if (!run) fail('REPAIR_NOT_REQUIRED', 'Repair execution requires a run in VERIFICATION_FAILED status');
    const prepared = await this.#prepare(request, { expectedSourceSnapshotId: repairApproval.record?.sourceSnapshotId ?? null });
    const plans = this.#repairPlans(request.migrationId, repairApproval.record?.repairPlanIds ?? []);
    const expectedBinding = repairApprovalBinding({
      migrationId: request.migrationId,
      plans,
      plan: prepared.plan,
      snapshot: prepared.snapshot,
      targetContractId: prepared.targetPreflight.targetContractId,
      effects: repairApprovalEffects(prepared.plan.targetRef.connector),
      principal: request.principal,
      expiresAt: repairApproval.record?.expiresAt,
      nonce: repairApproval.record?.nonce
    });
    assertRepairApproval(repairApproval, expectedBinding, { signingKey: this.approvalSigningKey });

    if (run.status === 'REPAIR_COMPLETE' && run.repair?.receipt) {
      const storedPlanIds = [...(run.repair.repairPlanIds ?? [])].sort();
      if (JSON.stringify(storedPlanIds) === JSON.stringify(repairApproval.record.repairPlanIds)) {
        return Object.freeze({ status: 'REPAIR_COMPLETE', repair: run.repair, receipt: run.repair.receipt, replay: true });
      }
      fail('REPAIR_PLAN_SUPERSEDED', 'A different repair outcome is already recorded for this migration');
    }
    if (run.status !== 'VERIFICATION_FAILED') fail('REPAIR_NOT_REQUIRED', 'Repair execution requires a run in VERIFICATION_FAILED status');

    const { plan, snapshot, source, sourceRows, targetRuntime, targetPreflight } = prepared;
    assertRepairCapability(targetRuntime);
    const targetExecution = await targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: plan.targetRef });
    let lease;
    const renewLease = async () => { lease = await targetExecution.renewLease(); return lease; };
    const repairStartedAt = new Date().toISOString();
    try {
      assertRepairCapability(targetRuntime, targetExecution);
      await renewLease();
      await targetExecution.openTarget();
      const storedOps = new Map(this.runs.repairOperations(request.migrationId).map(item => [`${item.repairPlanId}\0${item.keyId}`, item]));
      const progress = {
        loadOperation: async (repairPlanId, keyId) => storedOps.get(`${repairPlanId}\0${keyId}`) ?? null,
        saveOperation: async record => {
          this.runs.saveRepairOperation({ migrationId: request.migrationId, ...record });
          storedOps.set(`${record.repairPlanId}\0${record.keyId}`, { ...record, applied: record.applied === true });
        }
      };
      const opResults = await executeRepairOperations({
        plans,
        target: targetExecution,
        targetSchema: plan.targetSchema,
        fencingToken: lease.fencingToken,
        targetContractId: targetPreflight.targetContractId,
        progress
      });
      const content = await this.#reverifyContentExact({
        migrationId: request.migrationId, source, plan, sourceRows, targetExecution, targetPreflight, renewLease
      });
      if (content.status !== 'VERIFIED') {
        fail('REPAIR_REVERIFICATION_FAILED', 'Target content still differs after repair execution', {
          rootHash: content.rootHash,
          diffCounts: content.diffCounts
        });
      }
      const completedAt = new Date().toISOString();
      const receipt = createRepairReceipt({
        release: this.release,
        migrationId: request.migrationId,
        requestSemanticId: migrationRequestSemanticId(request),
        repairApprovalId: repairApproval.approvalId,
        repairPlanIds: repairApproval.record.repairPlanIds,
        planId: plan.planId,
        sourceSnapshotId: snapshot.snapshotId,
        targetIdentity: plan.targetRef,
        targetContractId: targetPreflight.targetContractId,
        opCounts: summarizeRepairOperations(opResults),
        verification: content,
        startedAt: repairStartedAt,
        completedAt
      });
      const repair = Object.freeze({
        repairApprovalId: repairApproval.approvalId,
        repairPlanIds: Object.freeze([...repairApproval.record.repairPlanIds]),
        opCounts: summarizeRepairOperations(opResults),
        operations: opResults,
        verification: content,
        receipt,
        startedAt: repairStartedAt,
        completedAt
      });
      this.runs.completeRepair({ migrationId: request.migrationId, repair, completedAt });
      return Object.freeze({ status: 'REPAIR_COMPLETE', repair, receipt, replay: false });
    } finally {
      await targetExecution.close();
    }
  }

  repairReceipt(migrationId) {
    const run = this.status(migrationId);
    if (!run?.repair?.receipt) fail('REPAIR_RECEIPT_NOT_AVAILABLE', 'Repair receipt is not available');
    return run.repair.receipt;
  }

  #requireCutoverOpen(migrationId) {
    if (this.runs.cutover(migrationId)?.status === 'COMMITTED') {
      fail('CUTOVER_ALREADY_COMMITTED', 'Target is cut over; migration mutation is frozen');
    }
  }

  async beginCutover(request, { receipt } = {}) {
    this.#open(); requireRequest(request);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('INVALID_CUTOVER_REQUEST', 'Cutover arming requires the recorded migration or repair receipt');
    const run = this.runs.get(request.migrationId);
    if (!run || (run.status !== 'COMPLETE' && run.status !== 'REPAIR_COMPLETE')) fail('CUTOVER_NOT_ALLOWED', 'Cutover requires a completed verified run');
    let receiptKind = null;
    let recorded = null;
    if (run.status === 'COMPLETE' && run.receipt?.receiptId === receipt.receiptId) {
      receiptKind = 'migration';
      recorded = run.receipt.record;
    } else if (run.status === 'REPAIR_COMPLETE' && run.repair?.receipt?.receiptId === receipt.receiptId) {
      receiptKind = 'repair';
      recorded = run.repair.receipt.record;
    } else {
      fail('CUTOVER_RECEIPT_MISMATCH', 'Cutover receipt does not match the recorded run outcome');
    }
    if (recorded.migrationId !== request.migrationId) fail('CUTOVER_RECEIPT_MISMATCH', 'Cutover receipt is bound to a different migration');
    if (canonicalJson(receipt.record) !== canonicalJson(recorded)) {
      fail('CUTOVER_RECEIPT_MISMATCH', 'Cutover receipt content does not match the recorded run outcome');
    }
    const existing = this.runs.cutover(request.migrationId);
    if (existing?.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'Cutover is already committed');
    return this.runs.beginCutover({
      migrationId: request.migrationId,
      receiptId: receipt.receiptId,
      receiptKind,
      planId: recorded.planId,
      sourceSnapshotId: recorded.sourceSnapshotId,
      targetIdentity: recorded.targetIdentity,
      targetContractId: recorded.targetContractId,
      armedAt: new Date().toISOString()
    });
  }

  async commitCutover(request) {
    this.#open(); requireRequest(request);
    const armed = this.runs.cutover(request.migrationId);
    if (!armed) fail('CUTOVER_NOT_ARMED', 'Cutover commit requires an armed cutover');
    if (armed.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'Cutover is already committed');
    if (armed.status !== 'ARMED') fail('CUTOVER_NOT_ARMED', 'Cutover commit requires an armed cutover');
    const run = this.runs.get(request.migrationId);
    if (!run || (run.status !== 'COMPLETE' && run.status !== 'REPAIR_COMPLETE')) fail('CUTOVER_NOT_ALLOWED', 'Cutover requires a completed verified run');
    const prepared = await this.#prepare(request);
    if (prepared.plan.planId !== armed.planId) fail('CUTOVER_PLAN_CHANGED', 'Migration plan changed since cutover arming');
    if (prepared.targetPreflight.targetContractId !== armed.targetContractId) {
      fail('CUTOVER_CONTRACT_CHANGED', 'Target contract changed since cutover arming', {
        armedTargetContractId: armed.targetContractId,
        actualTargetContractId: prepared.targetPreflight.targetContractId
      });
    }
    const targetExecution = await prepared.targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: prepared.plan.targetRef });
    try {
      const lease = await targetExecution.renewLease();
      const decidedAt = new Date().toISOString();
      return this.runs.commitCutover({
        migrationId: request.migrationId,
        commitEvidence: {
          targetContractId: prepared.targetPreflight.targetContractId,
          leaseResource: targetExecution.leaseResource ?? null,
          fencingToken: lease.fencingToken,
          fenced: true,
          committedAt: decidedAt
        },
        decidedAt
      });
    } finally {
      await targetExecution.close();
    }
  }

  async abortCutover(migrationId, { reason } = {}) {
    this.#open();
    if (typeof migrationId !== 'string' || !migrationId) fail('INVALID_CUTOVER_REQUEST', 'migrationId is required');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 256) fail('INVALID_CUTOVER_REQUEST', 'abort reason must be a non-empty bounded string');
    const armed = this.runs.cutover(migrationId);
    if (!armed) fail('CUTOVER_NOT_ARMED', 'Cutover abort requires an armed cutover');
    if (armed.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'A committed cutover cannot be aborted');
    if (armed.status !== 'ARMED') fail('CUTOVER_NOT_ARMED', 'Cutover abort requires an armed cutover');
    return this.runs.abortCutover({ migrationId, reason: reason.trim(), decidedAt: new Date().toISOString() });
  }

  cutover(migrationId) { this.#open(); return this.runs.cutover(migrationId); }

  close() { if (!this.closed) { this.runs.close(); this.closed = true; } }
}
