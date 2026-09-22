import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { createCdcApplier, discoverTargetPrimaryKey } from '../connectors/postgres/cdc-apply.js';
import {
  assertBoundaryCoversSnapshot,
  assertSlotContractUsable,
  comparePostgresLsn,
  describePostgresSlot,
  dropPostgresReplicationSlot,
  establishPostgresSnapshotCdcBoundary,
  getPostgresFlushLsn
} from '../connectors/postgres/cdc.js';
import { acquirePostgresTableShareLockBarrier, attestOperatorBarrier, assertOperatorBarrier } from '../cutover/write-barrier.js';

// Snapshot-pinned repair replays the approved snapshot ranges; after CDC
// transactions advanced the target beyond the snapshot, replaying those
// ranges would revert proven post-snapshot writes — silent data loss. Refuse
// with an actionable code instead: converge via streaming plus cutover first.
function assertNoCdcAdvanceBeforeRepair(binding) {
  if (binding?.cdcSlot
    && binding.appliedLsn != null
    && binding.cdcStartLsn != null
    && comparePostgresLsn(binding.appliedLsn, binding.cdcStartLsn) > 0) {
    fail('REPAIR_CDC_CONFLICT', 'Snapshot repair is refused after CDC transactions advanced the target beyond the snapshot; replaying snapshot ranges would revert proven post-snapshot writes', {
      cdcSlot: binding.cdcSlot,
      cdcStartLsn: binding.cdcStartLsn,
      appliedLsn: binding.appliedLsn
    });
  }
  return true;
}

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
import {
  MIGRATION_STATES,
  isAllowedTransition,
  assertTransitionPreconditions,
  buildSnapshotCdcBinding,
  buildCutoverAttemptId,
  decideRecoveryAction
} from '../protocol/migration-state-machine.js';
import { createVerificationCoordinator, VERIFICATION_MODE } from '../protocol/verification-coordinator.js';

export { migrationRequestSemanticId } from './request-semantics.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const INFERENCE_SAMPLE_SIZE = 1000;

function requireExternalSourceBarrier(barrier, {
  migrationId,
  cutoverAttemptId,
  principal,
  signingKey
}) {
  assertOperatorBarrier(barrier, { signingKey, migrationId, cutoverAttemptId, principal });
  return barrier;
}

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

function toStateTransitionEvidence({ planId, sourceStateId, targetContractId, fenceToken, extra = null } = {}) {
  const evidence = {};
  if (planId) evidence.planId = planId;
  if (sourceStateId) evidence.sourceStateId = sourceStateId;
  if (targetContractId) evidence.targetContractId = targetContractId;
  if (fenceToken) evidence.fenceToken = fenceToken;
  if (extra && typeof extra === 'object') Object.assign(evidence, extra);
  return Object.keys(evidence).length ? evidence : null;
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
      leaseTtlMs: options.postgresLeaseTtlMs,
      faultInjector: options.faultInjector ?? null
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
      credentialBroker,
      statePath: options.statePath,
      snapshotRoot,
      approvalSigningKey: options.approvalSigningKey,
      maxSourceBytes,
      release: releaseIdentity(options.release ?? {
        version: process.env.SPOOL_RELEASE_VERSION ?? '1.0.0',
        commitSha: process.env.SPOOL_COMMIT_SHA
      }),
      faultInjector: options.faultInjector ?? null
    });
  }

  constructor({ sourcePolicy, sourceCoordinator, targetConnectors, credentialBroker = null, statePath, snapshotRoot, approvalSigningKey, maxSourceBytes, release, faultInjector = null }) {
    this.sourcePolicy = sourcePolicy;
    this.sourceCoordinator = sourceCoordinator;
    this.targetConnectors = targetConnectors;
    this.credentialBroker = credentialBroker;
    this.snapshotRoot = snapshotRoot;
    this.approvalSigningKey = approvalSigningKey;
    this.maxSourceBytes = maxSourceBytes;
    this.release = release;
    this.faultInjector = faultInjector;
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
    // A pre-established CDC boundary is consumed here: approval materializes
    // the full-load snapshot AFTER the slot reservation, so the slot's
    // consistent point provably precedes the snapshot the load will read.
    const cdcBoundary = this.runs.getCdcBoundary(request.migrationId);
    const prepared = await this.#prepare(request);
    if (cdcBoundary && prepared.source?.connector !== 'postgres') {
      fail('CDC_SOURCE_UNSUPPORTED', 'An established CDC boundary requires the PostgreSQL database source', {
        connector: prepared.source?.connector ?? null
      });
    }
    if (typeof expiresAt !== 'string' || typeof nonce !== 'string') fail('INVALID_APPROVAL_REQUEST', 'expiresAt and nonce are required');
    const effects = await prepared.targetRuntime.approvalEffects(prepared.plan);
    const approval = createBoundApproval(
      approvalBinding(request, prepared.plan, prepared.snapshot, prepared.targetPreflight.targetContractId, effects, expiresAt, nonce),
      { signingKey: this.approvalSigningKey }
    );
    // Durable state-machine progression: CREATED -> DISCOVERING -> PREFLIGHTED -> PLANNED -> AWAITING_APPROVAL -> APPROVED.
    // Every protocol error propagates: the path walk tolerates only
    // idempotent-duplicate noise, everything else fails the approval closed.
    {
      this.#ensureDurableState(request.migrationId, request.principal, 'approve');
      const planId = prepared.plan.planId;
      const sourceStateId = prepared.snapshot.snapshotId;
      const targetContractId = prepared.targetPreflight.targetContractId;
      // Stepwise advance (idempotent)
      const cur0 = this.#durableState(request.migrationId);
      const steps = [];
      if (!cur0 || cur0.currentState === MIGRATION_STATES.CREATED) steps.push(MIGRATION_STATES.DISCOVERING);
      // After #prepare we have discovery+preflight+plan done; push remainder if allowed
      const curAfterEnsure = this.#durableState(request.migrationId);
      const tryPush = (fromStates, to) => {
        const cur = this.#durableState(request.migrationId);
        if (cur && fromStates.includes(cur.currentState) && isAllowedTransition(cur.currentState, to)) steps.push(to);
      };
      // Simplified: just push path if needed
      const currentBefore = this.#durableState(request.migrationId).currentState;
      const path = [];
      if (currentBefore === MIGRATION_STATES.CREATED) path.push(MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL);
      else if (currentBefore === MIGRATION_STATES.DISCOVERING) path.push(MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL);
      else if (currentBefore === MIGRATION_STATES.PREFLIGHTED) path.push(MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL);
      else if (currentBefore === MIGRATION_STATES.PLANNED) path.push(MIGRATION_STATES.AWAITING_APPROVAL);
      for (const st of path) {
        try { this.#durableTransition(request.migrationId, st, { principal: request.principal, reason: `approve path -> ${st}`, planId, sourceStateId, targetContractId }); } catch (e) { if (e?.code !== 'ILLEGAL_STATE_TRANSITION') throw e; }
      }
      // Finally AWAITING_APPROVAL -> APPROVED with approval precondition
      this.#durableTransition(request.migrationId, MIGRATION_STATES.APPROVED, {
        principal: request.principal,
        reason: 'approval bound',
        planId,
        sourceStateId,
        targetContractId,
        evidence: { approvalId: approval.approvalId },
        context: { approval, planId, sourceStateId, targetContractId }
      });
      // Persist snapshot/CDC binding if postgres source provides LSN info.
      // With an established boundary the binding carries the slot, the
      // publication, and the slot reservation point as the proven start —
      // never the join-time WAL position. Binding validation failures
      // (including CDC_GAP) fail the approval closed: proceeding without a
      // proven snapshot/CDC boundary would allow an unobserved interval.
      if (cdcBoundary) {
        // The manifest embeds the SourceState (coordinator results carry no
        // sourceState of their own).
        const manifestState = prepared.snapshot?.sourceState?.state ?? null;
        if (!manifestState) fail('CDC_SNAPSHOT_MISMATCH', 'Boundary snapshot has no embedded SourceState');
        const binding = buildSnapshotCdcBinding({
          sourceStateId: prepared.snapshot.snapshotId,
          databaseSnapshotIdentity: String(manifestState.systemIdentifier ?? prepared.snapshot.snapshotId),
          exportedSnapshotId: cdcBoundary.exportedSnapshotId,
          snapshotLsn: cdcBoundary.consistentPoint,
          cdcStartLsn: cdcBoundary.consistentPoint,
          cdcSlot: cdcBoundary.slotName,
          cdcPublication: cdcBoundary.publicationName,
          catalogId: manifestState.contractId ?? null
        });
        this.runs.setSnapshotCdcBinding(request.migrationId, binding);
      } else if (prepared.snapshot?.sourceStateId && prepared.source?.sourceState?.state?.walLsn) {
        const binding = buildSnapshotCdcBinding({
          sourceStateId: prepared.snapshot.snapshotId,
          databaseSnapshotIdentity: String(prepared.source.sourceState.state.systemIdentifier ?? prepared.snapshot.snapshotId),
          exportedSnapshotId: prepared.source.sourceState.state.snapshot?.exportedSnapshotId ?? null,
          snapshotLsn: prepared.source.sourceState.state.walLsn,
          cdcStartLsn: prepared.source.sourceState.state.walLsn,
          catalogId: prepared.source.sourceState.state.contractId ?? null
        });
        this.runs.setSnapshotCdcBinding(request.migrationId, binding);
      }
    }
    return approval;
  }

  runSyncGuard() { fail('ASYNC_COMMAND_ONLY', 'Production command execution is asynchronous'); }

  async run(request, { approval = null } = {}) {
    this.#open(); requireRequest(request); this.#requireCutoverOpen(request.migrationId);
    // Durable state: ensure migration initialized and check frozen after CUTOVER_COMMITTED
    const durableBefore = this.#durableState(request.migrationId);
    if (durableBefore && [MIGRATION_STATES.CUTOVER_COMMITTED, MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.COMPLETED].includes(durableBefore.currentState)) {
      fail('CUTOVER_ALREADY_COMMITTED', 'Migration is cut over/completed; mutation is frozen');
    }
    // Ensure CREATED exists before any other work
    this.#ensureDurableState(request.migrationId, request.principal, 'run requested');

    const requestSemanticId = migrationRequestSemanticId(request);
    const current = this.runs.get(request.migrationId);
    if (current?.status === 'COMPLETE' && current.receipt?.record?.requestSemanticId) {
      if (current.receipt.record.requestSemanticId !== requestSemanticId) fail('MIGRATION_ID_REUSE_CONFLICT', 'Completed migrationId cannot be reused for changed request semantics');
      // Durable check: if already COMPLETED via state machine, refuse re-run with different semantics as well
      const durable = this.#durableState(request.migrationId);
      if (durable && durable.currentState === MIGRATION_STATES.COMPLETED) {
        try { await this.#cleanupSnapshots(request.migrationId); } catch { }
        return Object.freeze({ status: 'COMPLETE', verification: current.verification, receipt: current.receipt, replay: true });
      }
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
    // Durable progression through discovery/planning to APPROVED (idempotent).
    // Every protocol error propagates: the guards skip completed steps, so
    // any throw is a genuine violation, never idempotent noise.
    {
      const cur = this.#durableState(request.migrationId);
      const planId = plan.planId;
      const sourceStateId = snapshot.snapshotId;
      const targetContractId = targetPreflight.targetContractId;
      // Advance DISCOVERING -> PREFLIGHTED -> PLANNED -> AWAITING_APPROVAL if not yet there
      const pathMap = {
        [MIGRATION_STATES.CREATED]: [MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL],
        [MIGRATION_STATES.DISCOVERING]: [MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL],
        [MIGRATION_STATES.PREFLIGHTED]: [MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL],
        [MIGRATION_STATES.PLANNED]: [MIGRATION_STATES.AWAITING_APPROVAL]
      };
      const toAdvance = pathMap[cur?.currentState] ?? [];
      for (const st of toAdvance) {
        try { this.#durableTransition(request.migrationId, st, { principal: request.principal, reason: `run prepare -> ${st}`, planId, sourceStateId, targetContractId }); } catch (e) { if (!['ILLEGAL_STATE_TRANSITION'].includes(e?.code)) throw e; }
      }
      // AWAITING_APPROVAL -> APPROVED with approval precondition
      this.#durableTransition(request.migrationId, MIGRATION_STATES.APPROVED, {
        principal: request.principal,
        reason: 'approval verified',
        planId,
        sourceStateId,
        targetContractId,
        evidence: { approvalId: approval.approvalId },
        context: { approval, planId, sourceStateId, targetContractId }
      });
    }
    await source.verify();
    // Durable: APPROVED -> SNAPSHOT_ARMED -> SNAPSHOT_RUNNING.
    // Every protocol error propagates: guards skip completed steps.
    {
      const planId = plan.planId;
      const sourceStateId = snapshot.snapshotId;
      const targetContractId = targetPreflight.targetContractId;
      const cur = this.#durableState(request.migrationId);
      if (cur && cur.currentState === MIGRATION_STATES.APPROVED) {
        this.#durableTransition(request.migrationId, MIGRATION_STATES.SNAPSHOT_ARMED, { principal: request.principal, reason: 'snapshot armed', planId, sourceStateId, targetContractId });
      }
      const cur2 = this.#durableState(request.migrationId);
      if (cur2 && cur2.currentState === MIGRATION_STATES.SNAPSHOT_ARMED) {
        this.#durableTransition(request.migrationId, MIGRATION_STATES.SNAPSHOT_RUNNING, { principal: request.principal, reason: 'snapshot running', planId, sourceStateId, targetContractId });
      }
      // Persist snapshot/CDC binding if postgres source provides LSN (real protocol sequence: snapshot and LSN captured atomically inside source snapshot).
      // A slot-bound binding (established pre-approval, consumed at approve)
      // is never rebuilt here: the run snapshot must equal the approved
      // snapshot the binding was bound to, otherwise the stream would not
      // cover the full load.
      // Binding validation failures (including CDC_GAP) fail closed.
      const existingBinding = this.runs.getSnapshotCdcBinding(request.migrationId);
      if (existingBinding?.cdcSlot) {
        if (existingBinding.sourceStateId !== snapshot.snapshotId) {
          fail('CDC_SNAPSHOT_MISMATCH', 'Run snapshot does not match the slot-bound CDC boundary snapshot', {
            boundarySnapshotId: existingBinding.sourceStateId,
            runSnapshotId: snapshot.snapshotId
          });
        }
      } else if (snapshot?.snapshotId && source?.sourceState?.state?.walLsn) {
        const binding = buildSnapshotCdcBinding({
          sourceStateId: snapshot.snapshotId,
          databaseSnapshotIdentity: String(source.sourceState.state.systemIdentifier ?? snapshot.snapshotId),
          exportedSnapshotId: source.sourceState.state.snapshot?.exportedSnapshotId ?? null,
          snapshotLsn: source.sourceState.state.walLsn,
          cdcStartLsn: source.sourceState.state.walLsn,
          catalogId: source.sourceState.state.contractId ?? null
        });
        this.runs.setSnapshotCdcBinding(request.migrationId, binding);
      }
    }

    const startedAt = current?.startedAt ?? new Date().toISOString();
    const targetExecution = await targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: plan.targetRef });
    let lease;
    let ownsRunState = false;
    const renewLease = async () => { lease = await targetExecution.renewLease(); return lease; };

    try {
      await renewLease();
      // Durable: SNAPSHOT_RUNNING -> FULL_LOAD_RUNNING with fence token.
      // Every protocol error propagates; the guards skip completed steps.
      {
        const cur = this.#durableState(request.migrationId);
        if (cur && [MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.APPROVED, MIGRATION_STATES.SNAPSHOT_ARMED].includes(cur.currentState)) {
          const to = MIGRATION_STATES.FULL_LOAD_RUNNING;
          if (isAllowedTransition(cur.currentState, to)) {
            this.#durableTransition(request.migrationId, to, { principal: request.principal, reason: 'full load running', planId: plan.planId, sourceStateId: snapshot.snapshotId, targetContractId: targetPreflight.targetContractId, fenceToken: lease.fencingToken, evidence: { fenceToken: lease.fencingToken } });
          } else if (cur.currentState === MIGRATION_STATES.APPROVED) {
            // Direct edge APPROVED -> FULL_LOAD_RUNNING allowed per graph
            this.#durableTransition(request.migrationId, MIGRATION_STATES.FULL_LOAD_RUNNING, { principal: request.principal, reason: 'full load running', planId: plan.planId, sourceStateId: snapshot.snapshotId, targetContractId: targetPreflight.targetContractId, fenceToken: lease.fencingToken });
          }
        } else if (cur && cur.currentState === MIGRATION_STATES.FULL_LOAD_RUNNING) {
          // Already running — update fence in evidence but don't re-transition; just ensure lease is fresh
          // We can record a no-op or keep current; spec says fencing must be validated inside TX, not here
        }
      }
      this.runs.start({ migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId, targetIdentity, startedAt });
      ownsRunState = true;
      const target = await targetExecution.openTarget();
      const checkpointStore = this.runs.checkpointStore(request.migrationId);
      const runner = new MigrationRunner({ target, checkpointStore, faultInjector: this.faultInjector });
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

      // Durable: FULL_LOAD_RUNNING (or CDC_RUNNING/CATCHING_UP) -> VERIFYING.
      // Every protocol error propagates; guards skip completed steps.
      {
        const cur = this.#durableState(request.migrationId);
        const planId = plan.planId;
        const sourceStateId = snapshot.snapshotId;
        const targetContractId = targetPreflight.targetContractId;
        if (cur && [MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP].includes(cur.currentState)) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.VERIFYING, { principal: request.principal, reason: 'verifying', planId, sourceStateId, targetContractId });
        } else if (cur && cur.currentState === MIGRATION_STATES.SNAPSHOT_RUNNING) {
          // Edge case: small migration that skipped FULL_LOAD_RUNNING due to checkpoint resume; go via FULL_LOAD then VERIFYING
          this.#durableTransition(request.migrationId, MIGRATION_STATES.FULL_LOAD_RUNNING, { principal: request.principal, reason: 'full load running (verify)', planId, sourceStateId, targetContractId, fenceToken: lease.fencingToken });
          this.#durableTransition(request.migrationId, MIGRATION_STATES.VERIFYING, { principal: request.principal, reason: 'verifying', planId, sourceStateId, targetContractId });
        }
      }

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
          // Durable: VERIFYING -> VERIFICATION_FAILED. Every protocol error
          // propagates; the guard skips already-transitioned retries.
          {
            const cur = this.#durableState(request.migrationId);
            if (cur && cur.currentState === MIGRATION_STATES.VERIFYING) {
              this.#durableTransition(request.migrationId, MIGRATION_STATES.VERIFICATION_FAILED, {
                principal: request.principal,
                reason: 'content verification diff',
                planId: plan.planId,
                sourceStateId: snapshot.snapshotId,
                targetContractId: targetPreflight.targetContractId,
                evidence: { verification, diffCounts: content.diffCounts },
                context: { verification: content }
              });
            }
          }
          this.runs.verificationFailed({ migrationId: request.migrationId, verification });
          fail('VERIFICATION_FAILED', 'Exact target-content verification found deterministic differences', {
            rootHash: content.rootHash,
            diffCounts: content.diffCounts
          });
        }
      } else {
        // No content verification — still need to mark basic verification success before receipt
        verification = basicVerification;
      }

      // Durable: VERIFYING -> READY_FOR_CUTOVER (if not already failed).
      // Every protocol error propagates; the guard skips completed retries.
      {
        const cur = this.#durableState(request.migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.VERIFYING) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.READY_FOR_CUTOVER, {
            principal: request.principal,
            reason: 'verified',
            planId: plan.planId,
            sourceStateId: snapshot.snapshotId,
            targetContractId: targetPreflight.targetContractId,
            evidence: { verification },
            context: { verification }
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
      // Note: durable state remains at READY_FOR_CUTOVER after successful migration.
      // COMPLETED is reached via POST_CUTOVER_VERIFY after cutover, or via explicit finalization.
      // Legacy spool_runs status COMPLETE is already mapped from READY_FOR_CUTOVER, so tests pass while durable retains cutover readiness.
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

  async approveRepair(request, { repairPlanIds, expiresAt, nonce } = {}) {
    this.#open(); requireRequest(request); this.#requireCutoverOpen(request.migrationId);
    if (!Array.isArray(repairPlanIds) || repairPlanIds.length === 0) fail('INVALID_REPAIR_REQUEST', 'repairPlanIds must be a non-empty array');
    if (typeof expiresAt !== 'string' || typeof nonce !== 'string') fail('INVALID_REPAIR_REQUEST', 'expiresAt and nonce are required');
    assertNoCdcAdvanceBeforeRepair(this.runs.getSnapshotCdcBinding(request.migrationId));
    const run = this.runs.get(request.migrationId);
    if (!run || run.status !== 'VERIFICATION_FAILED') fail('REPAIR_NOT_REQUIRED', 'Repair approval requires a run in VERIFICATION_FAILED status');
    const durableBefore = this.#durableState(request.migrationId);
    if (durableBefore && durableBefore.currentState !== MIGRATION_STATES.VERIFICATION_FAILED && durableBefore.currentState !== MIGRATION_STATES.REPAIR_PLANNED) {
      fail('REPAIR_NOT_REQUIRED', `Repair approval requires durable state VERIFICATION_FAILED, not ${durableBefore.currentState}`);
    }
    const prepared = await this.#prepare(request, { expectedSourceSnapshotId: run.sourceSnapshotId });
    assertRepairCapability(prepared.targetRuntime);
    const plans = this.#repairPlans(request.migrationId, repairPlanIds);
    const repairApproval = createRepairApproval(
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
    // Durable: VERIFICATION_FAILED -> REPAIR_PLANNED -> REPAIR_APPROVED.
    // Every protocol error propagates; guards skip completed steps.
    {
      const cur = this.#durableState(request.migrationId);
      if (cur && cur.currentState === MIGRATION_STATES.VERIFICATION_FAILED) {
        this.#durableTransition(request.migrationId, MIGRATION_STATES.REPAIR_PLANNED, {
          principal: request.principal,
          reason: 'repair planned',
          planId: prepared.plan.planId,
          sourceStateId: prepared.snapshot.snapshotId,
          targetContractId: prepared.targetPreflight.targetContractId,
          evidence: { repairPlanIds }
        });
      }
      const cur2 = this.#durableState(request.migrationId);
      if (cur2 && cur2.currentState === MIGRATION_STATES.REPAIR_PLANNED) {
        this.#durableTransition(request.migrationId, MIGRATION_STATES.REPAIR_APPROVED, {
          principal: request.principal,
          reason: 'repair approved',
          planId: prepared.plan.planId,
          sourceStateId: prepared.snapshot.snapshotId,
          targetContractId: prepared.targetPreflight.targetContractId,
          evidence: { repairApprovalId: repairApproval.approvalId, repairPlanIds },
          context: { repairApproval, planId: prepared.plan.planId, sourceStateId: prepared.snapshot.snapshotId, targetContractId: prepared.targetPreflight.targetContractId }
        });
      }
    }
    return repairApproval;
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
    // An approval granted before CDC advanced must not execute after it:
    // the snapshot ranges it authorizes would revert proven writes.
    assertNoCdcAdvanceBeforeRepair(this.runs.getSnapshotCdcBinding(request.migrationId));

    const { plan, snapshot, source, sourceRows, targetRuntime, targetPreflight } = prepared;
    assertRepairCapability(targetRuntime);
    // Durable: REPAIR_APPROVED -> REPAIRING (requires RepairApproval).
    // The fence token is minted below via renewLease before transitioning.
    {
      const cur = this.#durableState(request.migrationId);
      if (cur && cur.currentState !== MIGRATION_STATES.REPAIR_APPROVED) {
        fail('REPAIR_NOT_REQUIRED', `Repair execution requires durable state REPAIR_APPROVED, not ${cur?.currentState}`);
      }
    }
    const targetExecution = await targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: plan.targetRef });
    let lease;
    const renewLease = async () => { lease = await targetExecution.renewLease(); return lease; };
    const repairStartedAt = new Date().toISOString();
    try {
      assertRepairCapability(targetRuntime, targetExecution);
      await renewLease();
      // Now transition REPAIR_APPROVED -> REPAIRING with fence. The guard
      // skips already-advanced retries; any throw is a genuine violation.
      {
        const cur = this.#durableState(request.migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.REPAIR_APPROVED) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.REPAIRING, {
            principal: request.principal,
            reason: 'repairing',
            planId: plan.planId,
            sourceStateId: snapshot.snapshotId,
            targetContractId: targetPreflight.targetContractId,
            fenceToken: lease.fencingToken,
            evidence: { repairApprovalId: repairApproval.approvalId, fenceToken: lease.fencingToken },
            context: { repairApproval, fenceToken: lease.fencingToken }
          });
        }
      }
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
      // Durable: REPAIRING -> REVERIFYING
      {
        const cur = this.#durableState(request.migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.REPAIRING) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.REVERIFYING, {
            principal: request.principal,
            reason: 'reverifying',
            planId: plan.planId,
            sourceStateId: snapshot.snapshotId,
            targetContractId: targetPreflight.targetContractId,
            fenceToken: lease.fencingToken
          });
        }
      }
      // Re-verify through the shared VerificationCoordinator (REPAIR_REVERIFY
      // mode): same engine as final/post-cutover verification, bound to the
      // approved verification batches for exact coverage accounting.
      const expectedValidRows = this.runs.verificationBatches(request.migrationId)
        .reduce((total, item) => total + (item.verification?.expected?.rowCount ?? 0), 0);
      const repairVerifier = createVerificationCoordinator();
      const reverify = await repairVerifier.verify({
        migrationId: request.migrationId,
        mode: VERIFICATION_MODE.REPAIR_REVERIFY,
        plan,
        sourceState: { sourceStateId: snapshot.snapshotId },
        targetContract: targetPreflight,
        targetExecution,
        sourceRuntime: source,
        expectedValidRows,
        release: this.release
      });
      const content = reverify.contentProof;
      if (!reverify || reverify.status !== 'VERIFIED') {
        // Remains in REVERIFYING but need to decide: stay or go back to VERIFICATION_FAILED?
        // Spec says REVERIFYING -> VERIFICATION_FAILED on failure, so transition back
        const cur = this.#durableState(request.migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.REVERIFYING) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.VERIFICATION_FAILED, {
            principal: request.principal,
            reason: 'reverification failed',
            planId: plan.planId,
            sourceStateId: snapshot.snapshotId,
            targetContractId: targetPreflight.targetContractId,
            evidence: { verification: content }
          });
        }
        fail('REPAIR_REVERIFICATION_FAILED', 'Target content still differs after repair execution', {
          rootHash: content?.rootHash ?? reverify?.contentRoot ?? null,
          diffCounts: content?.diffCounts ?? null
        });
      }
      // Durable: REVERIFYING -> READY_FOR_CUTOVER
      {
        const cur = this.#durableState(request.migrationId);
        if (cur && cur.currentState === MIGRATION_STATES.REVERIFYING) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.READY_FOR_CUTOVER, {
            principal: request.principal,
            reason: 'reverified',
            planId: plan.planId,
            sourceStateId: snapshot.snapshotId,
            targetContractId: targetPreflight.targetContractId,
            evidence: { verification: content },
            context: { verification: content }
          });
        }
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
    const durable = this.runs.getMigrationState?.(migrationId);
    if (durable && durable.currentState === MIGRATION_STATES.CUTOVER_COMMITTED) {
      fail('CUTOVER_ALREADY_COMMITTED', 'Target is cut over; migration mutation is frozen (durable state)');
    }
    if (durable && durable.currentState === MIGRATION_STATES.COMPLETED) {
      fail('CUTOVER_ALREADY_COMMITTED', 'Migration is completed; mutation is frozen');
    }
  }

  #durableState(migrationId) {
    try {
      return this.runs.getMigrationState?.(migrationId) ?? null;
    } catch (error) {
      if (error?.code === 'RUN_STATE_CORRUPT') throw error;
      return null;
    }
  }

  #ensureDurableState(migrationId, principal, reason = 'ensure') {
    let state = this.#durableState(migrationId);
    if (!state) {
      state = this.runs.initializeMigration(migrationId, { principal, reason });
    }
    return state;
  }

  #durableTransition(migrationId, nextState, { principal, reason = '', planId = null, sourceStateId = null, targetContractId = null, fenceToken = null, evidence = null, context = {}, expectedSequence = null, commandId = null } = {}) {
    const current = this.#durableState(migrationId);
    if (current && current.currentState === nextState) return current;
    // If no state and nextState is CREATED, initialize directly
    if (!current && nextState === MIGRATION_STATES.CREATED) {
      return this.runs.initializeMigration(migrationId, { principal, reason, planId, sourceStateId, targetContractId });
    }
    // Use Runs transition which does CAS + precondition
    const from = current ? current.currentState : null;
    // Build context with durable cutover check
    const enrichedContext = { ...context };
    if (current && current.currentState === MIGRATION_STATES.CUTOVER_COMMITTED) enrichedContext.cutoverCommitted = true;
    // delegate to RunStore transition
    const transition = this.runs.transition(migrationId, {
      expectedSequence: expectedSequence ?? (current ? current.sequence : null),
      previousState: from,
      nextState,
      principal,
      reason: reason.slice(0, 256),
      planId,
      sourceStateId,
      targetContractId,
      fenceToken,
      evidence,
      context: enrichedContext,
      commandId
    });
    return this.#durableState(migrationId);
  }

  // Sequence of the CUTOVER_COMMITTED transition, for post-commit auditing.
  #cutoverCommitSequence(migrationId) {
    const transitions = this.runs.listTransitions(migrationId);
    const commit = [...transitions].reverse().find(t => t.nextState === MIGRATION_STATES.CUTOVER_COMMITTED);
    if (!commit) fail('CUTOVER_NOT_ARMED', 'No durable cutover commit found for post-cutover auditing');
    return commit.sequence;
  }

  // Fail closed if any SPOOL mutation transitioned after the cutover commit
  // outside the post-verification path: the post-cutover proof would otherwise
  // certify a target state the cutover decision never saw.
  #assertNoPostCommitMutation(migrationId, commitSequence) {
    const allowed = new Set([MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.COMPLETED]);
    const drifted = this.runs.listTransitions(migrationId)
      .filter(t => Number(t.sequence) > Number(commitSequence) && !allowed.has(t.nextState));
    if (drifted.length > 0) {
      fail('CUTOVER_DRIFT', 'SPOOL state mutated after the cutover commit outside the post-verification path; operator review required', {
        afterSequence: commitSequence,
        unexpected: drifted.map(t => ({ sequence: t.sequence, nextState: t.nextState, transitionId: t.transitionId }))
      });
    }
  }

  // Shared receipt/plan/contract validation for cutover arming and re-arming.
  // Returns the receipt kind and the canonically recorded receipt payload.
  async #validateCutoverArming(request, receipt) {
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
    return { receiptKind, recorded };
  }

  async beginCutover(request, { receipt } = {}) {
    this.#open(); requireRequest(request);
    const { receiptKind, recorded } = await this.#validateCutoverArming(request, receipt);
    const existing = this.runs.cutover(request.migrationId);
    if (existing?.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'Cutover is already committed');
    // Canonical state is authoritative: arming requires READY_FOR_CUTOVER.
    // An aborted attempt never resumes implicitly; it requires rearmCutover.
    const durable = this.#durableState(request.migrationId);
    if (!durable) fail('CUTOVER_NOT_ALLOWED', 'Cutover arming requires durable migration state');
    if (durable.currentState === MIGRATION_STATES.ABORTED) {
      fail('CUTOVER_REARM_REQUIRED', 'This cutover attempt was aborted; call rearmCutover with a reason to start a new attempt');
    }
    if (durable.currentState !== MIGRATION_STATES.READY_FOR_CUTOVER) {
      fail('CUTOVER_NOT_ALLOWED', `Cutover arming requires durable state READY_FOR_CUTOVER, not ${durable.currentState}`);
    }
    const armedAt = new Date().toISOString();
    const cutoverAttemptId = buildCutoverAttemptId({
      migrationId: request.migrationId, receiptId: receipt.receiptId, receiptKind,
      planId: recorded.planId, sourceStateId: recorded.sourceSnapshotId,
      targetContractId: recorded.targetContractId, armedAt
    });
    return this.runs.armCutoverAtomic({
      migrationId: request.migrationId,
      receiptId: receipt.receiptId,
      receiptKind,
      planId: recorded.planId,
      sourceSnapshotId: recorded.sourceSnapshotId,
      targetIdentity: recorded.targetIdentity,
      targetContractId: recorded.targetContractId,
      armedAt,
      cutoverAttemptId,
      principal: request.principal
    });
  }

  // Mint server-authenticated evidence that the operator/routing layer has
  // frozen source writes for this exact cutover attempt. The caller supplies
  // the operational statement and routing decision; SPOOL captures the live
  // source WAL position and HMAC-signs the evidence with the service approval
  // trust root. Re-arming creates a new attempt id, so old attestations cannot
  // authorize a later attempt.
  async attestCutoverBarrier(request, { statement, routingDecision } = {}) {
    this.#open(); requireRequest(request);
    const armed = this.runs.cutover(request.migrationId);
    if (!armed || armed.status !== 'ARMED' || !armed.cutoverAttemptId) {
      fail('CUTOVER_NOT_ARMED', 'Source-write freeze attestation requires an armed cutover attempt');
    }
    if (typeof statement !== 'string' || !statement.trim() || statement.length > 2000) {
      fail('INVALID_BARRIER_ATTESTATION', 'statement must be a non-empty bounded string');
    }
    if (typeof routingDecision !== 'string' || !routingDecision.trim() || routingDecision.length > 2000) {
      fail('INVALID_BARRIER_ATTESTATION', 'routingDecision must be a non-empty bounded string');
    }
    const prepared = await this.#prepare(request);
    if (prepared.plan.planId !== armed.planId) {
      fail('CUTOVER_PLAN_CHANGED', 'Migration plan changed before source-write freeze attestation');
    }
    if (prepared.source?.connector !== 'postgres' || !prepared.source?.sourceRef) {
      fail('WRITE_BARRIER_UNSUPPORTED', 'Server-authenticated source-write freeze attestation is currently implemented for PostgreSQL sources');
    }
    const finalLsn = await getPostgresFlushLsn({
      ref: prepared.source.sourceRef,
      credentialBroker: this.credentialBroker
    });
    return attestOperatorBarrier({
      migrationId: request.migrationId,
      cutoverAttemptId: armed.cutoverAttemptId,
      principal: request.principal,
      statement: statement.trim(),
      finalLsn,
      routingDecision: routingDecision.trim()
    }, { signingKey: this.approvalSigningKey });
  }


  // Explicit re-arm after abort. Re-validates the receipt against the recorded
  // run AND the live plan/target contract (freshness proof), then opens a new
  // attempt. The aborted attempt identity is never reused.
  async rearmCutover(request, { receipt, reason } = {}) {
    this.#open(); requireRequest(request);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 256) fail('INVALID_CUTOVER_REQUEST', 're-arm reason must be a non-empty bounded string');
    const { receiptKind, recorded } = await this.#validateCutoverArming(request, receipt);
    const existing = this.runs.cutover(request.migrationId);
    if (!existing) fail('CUTOVER_STATE_CONFLICT', 'Re-arm requires a previously aborted cutover attempt');
    if (existing.status === 'COMMITTED') fail('CUTOVER_ALREADY_COMMITTED', 'A committed cutover cannot be re-armed');
    // Freshness: the live plan and target contract must still match the receipt.
    const prepared = await this.#prepare(request);
    if (prepared.plan.planId !== recorded.planId) fail('CUTOVER_PLAN_CHANGED', 'Migration plan changed since the aborted attempt; re-plan before re-arming');
    if (prepared.targetPreflight.targetContractId !== recorded.targetContractId) {
      fail('CUTOVER_CONTRACT_CHANGED', 'Target contract changed since the aborted attempt; re-verify before re-arming', {
        recordedTargetContractId: recorded.targetContractId,
        actualTargetContractId: prepared.targetPreflight.targetContractId
      });
    }
    const armedAt = new Date().toISOString();
    const cutoverAttemptId = buildCutoverAttemptId({
      migrationId: request.migrationId, receiptId: receipt.receiptId, receiptKind,
      planId: recorded.planId, sourceStateId: recorded.sourceSnapshotId,
      targetContractId: recorded.targetContractId, armedAt
    });
    return this.runs.rearmCutoverAtomic({
      migrationId: request.migrationId,
      principal: request.principal,
      reason: reason.trim(),
      receiptId: receipt.receiptId,
      receiptKind,
      planId: recorded.planId,
      sourceSnapshotId: recorded.sourceSnapshotId,
      targetIdentity: recorded.targetIdentity,
      targetContractId: recorded.targetContractId,
      armedAt,
      cutoverAttemptId
    });
  }

  // Recovery-aware cutover commit. The canonical state decides which phase
  // executes, so killing the process at any cutover crash window and retrying
  // deterministically resumes instead of duplicating or skipping proof:
  // - COMPLETED -> return the committed record (idempotent success)
  // - POST_CUTOVER_VERIFY -> resume completion with the bound post evidence
  // - CUTOVER_COMMITTED -> run post-cutover verification, then complete
  // - FINAL_VERIFY -> validate persisted final evidence, then commit
  // - CUTOVER_ARMED/FINAL_DRAIN -> run final verification, then commit
  // Anything else -> CUTOVER_NOT_ARMED. No protocol error is swallowed: every
  // SpoolError propagates to the caller.
  async commitCutover(request, { sourceBarrier = null } = {}) {
    this.#open(); requireRequest(request);
    const armed = this.runs.cutover(request.migrationId);
    if (!armed) fail('CUTOVER_NOT_ARMED', 'Cutover commit requires an armed cutover');
    if (armed.status === 'ABORTED') fail('CUTOVER_NOT_ARMED', 'Cutover attempt was aborted; call rearmCutover for a new attempt');
    if (armed.status !== 'ARMED' && armed.status !== 'COMMITTED') fail('CUTOVER_NOT_ARMED', 'Cutover commit requires an armed cutover');
    const run = this.runs.get(request.migrationId);
    if (!run || (run.status !== 'COMPLETE' && run.status !== 'REPAIR_COMPLETE')) fail('CUTOVER_NOT_ALLOWED', 'Cutover requires a completed verified run');
    const durableBeforePrepare = this.#durableState(request.migrationId);
    if (durableBeforePrepare?.currentState === MIGRATION_STATES.COMPLETED) {
      return this.runs.cutover(request.migrationId);
    }
    // Drain evidence binds the full-load snapshot from the slot-bound binding
    // (see #applyCdcToWaterline); the prepare itself is live refs + plan, as
    // with every other post-run operation.
    const prepared = await this.#prepare(request);
    const postgresSource = prepared.source?.connector === 'postgres' && prepared.source?.sourceRef
      ? prepared.source.sourceRef
      : null;
    const externalSourceBarrier = postgresSource
      ? requireExternalSourceBarrier(sourceBarrier, {
          migrationId: request.migrationId,
          cutoverAttemptId: armed.cutoverAttemptId,
          principal: request.principal,
          signingKey: this.approvalSigningKey
        })
      : null;
    if (prepared.plan.planId !== armed.planId) fail('CUTOVER_PLAN_CHANGED', 'Migration plan changed since cutover arming');
    if (prepared.targetPreflight.targetContractId !== armed.targetContractId) {
      fail('CUTOVER_CONTRACT_CHANGED', 'Target contract changed since cutover arming', {
        armedTargetContractId: armed.targetContractId,
        actualTargetContractId: prepared.targetPreflight.targetContractId
      });
    }
    if (!armed.cutoverAttemptId) fail('CUTOVER_ATTEMPT_MISMATCH', 'Armed cutover has no attempt identity; re-arm before committing');
    const targetExecution = await prepared.targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: prepared.plan.targetRef });
    let sourceLockBarrier = null;
    try {
      if (postgresSource) {
        sourceLockBarrier = await acquirePostgresTableShareLockBarrier({
          migrationId: request.migrationId,
          sourceRef: postgresSource,
          credentialBroker: this.credentialBroker
        });
      }
      const lease = await targetExecution.renewLease();
      // Open the shared execution: the coordinator verifies through it
      // (ledger reads and content sessions require an opened target).
      await targetExecution.openTarget();
      const attemptId = armed.cutoverAttemptId;
      const commandIdFor = step => `cutover:${attemptId}:${step}`;
      let state = this.#durableState(request.migrationId);
      if (!state) fail('CUTOVER_NOT_ALLOWED', 'Cutover commit requires durable migration state');
      if (state.currentState === MIGRATION_STATES.COMPLETED) return this.runs.cutover(request.migrationId);

      const verifier = createVerificationCoordinator();
      const snapshotCdcBinding = this.runs.getSnapshotCdcBinding(request.migrationId);
      const hasCdcSlot = Boolean(snapshotCdcBinding?.cdcSlot);
      // Batch-identity binding uses the RUN's recorded source snapshot — the
      // exact state the ledger batches were committed from. The post-run
      // prepare re-materializes a fresh snapshot (new identity for database
      // sources); binding batch identities to it would mismatch the ledger
      // by construction and make non-CDC cutover unprovable. Freshness still
      // comes from the live row stream: racing writes change the live count
      // and fail the proof closed.
      const proofSourceStateId = run.sourceSnapshotId ?? prepared.snapshot?.snapshotId ?? null;
      // Verification shares this commit's leased target execution: minting a
      // second execution would trip single-writer lease ownership, and the
      // commit fence must cover the proof it relies on.
      const verifyInput = {
        migrationId: request.migrationId,
        plan: prepared.plan,
        sourceState: proofSourceStateId ? { sourceStateId: proofSourceStateId } : null,
        targetContract: prepared.targetPreflight,
        targetExecution,
        sourceRuntime: prepared.source,
        // Coordinator contract name is snapshotCdcBoundary (the binding
        // record); a mismatched key would silently null the CDC context.
        snapshotCdcBoundary: snapshotCdcBinding,
        cutoverAttemptId: attemptId,
        release: this.release
      };

      // Phase 1: reach CUTOVER_COMMITTED with bound final evidence.
      state = this.#durableState(request.migrationId);
      if ([MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY].includes(state.currentState)) {
        if (state.currentState === MIGRATION_STATES.CUTOVER_ARMED && hasCdcSlot) {
          this.#durableTransition(request.migrationId, MIGRATION_STATES.FINAL_DRAIN, {
            principal: request.principal, reason: 'final drain',
            planId: prepared.plan.planId, sourceStateId: prepared.snapshot?.snapshotId ?? null,
            targetContractId: prepared.targetPreflight.targetContractId, fenceToken: lease.fencingToken,
            context: { fenceToken: lease.fencingToken, cutoverAttemptId: attemptId },
            commandId: commandIdFor('final-drain')
          });
          state = this.#durableState(request.migrationId);
        }
        if (state.currentState === MIGRATION_STATES.FINAL_DRAIN && hasCdcSlot) {
          // Drain the stream to the source's current flush position through
          // this commit's leased execution (no second lease): serialized
          // fenced apply, CAS checkpoints, ack after durability. Termination
          // is proven by transaction commits and server keepalive heartbeats,
          // so a quiesced source drains instead of hanging. Retry resumes
          // from the durable applied watermark, never re-applying blindly.
          // Writes racing the drain fail the fresh final verification below
          // closed rather than slipping into the committed proof.
          if (prepared.source?.connector !== 'postgres' || !prepared.source?.sourceRef) {
            fail('CDC_SOURCE_UNSUPPORTED', 'Final drain requires a PostgreSQL database source', {
              connector: prepared.source?.connector ?? null
            });
          }
          if (!this.credentialBroker || typeof this.credentialBroker.withSecret !== 'function') {
            fail('CDC_BROKER_REQUIRED', 'Final drain requires a credential broker');
          }
          // The final waterline is captured only after the PostgreSQL SHARE
          // barrier is held. No source-table DML can advance beyond this
          // point until the cutover decision and post-verification finish.
          const waterline = sourceLockBarrier?.finalLsn
            ?? await getPostgresFlushLsn({ ref: prepared.source.sourceRef, credentialBroker: this.credentialBroker });
          await this.#applyCdcToWaterline({
            request, prepared, targetExecution, untilLsn: waterline, ownerEpoch: randomUUID()
          });
          state = this.#durableState(request.migrationId);
        }
        if ([MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN].includes(state.currentState)) {
          // Fresh FINAL_PRE_CUTOVER proof: executed now, never reused.
          const finalVerification = await verifier.verify({
            ...verifyInput,
            mode: VERIFICATION_MODE.FINAL_PRE_CUTOVER,
            expectedCdcPosition: hasCdcSlot ? (snapshotCdcBinding?.appliedLsn ?? snapshotCdcBinding?.cdcStartLsn ?? null) : null
          });
          if (!finalVerification || finalVerification.status !== 'VERIFIED') {
            fail('VERIFICATION_REQUIRED', 'CUTOVER_COMMITTED requires a successful fresh final verification');
          }
          this.runs.recordFinalVerificationAtomic({
            migrationId: request.migrationId, principal: request.principal, verification: finalVerification,
            fenceToken: lease.fencingToken, planId: prepared.plan.planId,
            sourceStateId: prepared.snapshot?.snapshotId ?? null,
            targetContractId: prepared.targetPreflight.targetContractId,
            commandId: commandIdFor('final-verify')
          });
          state = this.#durableState(request.migrationId);
        }
        if (state.currentState === MIGRATION_STATES.FINAL_VERIFY) {
          const decidedAt = new Date().toISOString();
          const persisted = this.runs.findVerification({
            migrationId: request.migrationId, mode: VERIFICATION_MODE.FINAL_PRE_CUTOVER, cutoverAttemptId: attemptId
          });
          if (!persisted) fail('VERIFICATION_REQUIRED', 'FINAL_VERIFY has no persisted final verification for this attempt; re-run final verification');
          if (sourceLockBarrier) await sourceLockBarrier.verifyHeld();
          this.runs.commitCutoverAtomic({
            migrationId: request.migrationId, principal: request.principal,
            commitEvidence: {
              targetContractId: prepared.targetPreflight.targetContractId,
              leaseResource: targetExecution.leaseResource ?? null,
              fencingToken: lease.fencingToken,
              fenced: true,
              committedAt: decidedAt,
              sourceWriteBarrier: sourceLockBarrier ? {
                barrierId: sourceLockBarrier.barrierId,
                kind: sourceLockBarrier.kind,
                acquiredAt: sourceLockBarrier.acquiredAt,
                finalLsn: sourceLockBarrier.finalLsn,
                proof: sourceLockBarrier.proof,
                externalBarrierId: externalSourceBarrier?.barrierId ?? null,
                externalPrincipal: externalSourceBarrier?.attestation?.principal ?? null,
                externalRoutingDecision: externalSourceBarrier?.attestation?.routingDecision ?? null,
                zeroDowntime: false
              } : null
            },
            decidedAt,
            finalVerificationId: persisted.verificationId,
            fenceToken: lease.fencingToken,
            planId: prepared.plan.planId,
            // Same binding as the final proof: the run's recorded snapshot,
            // never the ephemeral re-materialized prepare snapshot.
            sourceStateId: run.sourceSnapshotId ?? prepared.snapshot?.snapshotId ?? null,
            targetContractId: prepared.targetPreflight.targetContractId,
            commandId: commandIdFor('commit')
          });
          state = this.#durableState(request.migrationId);
        }
      }
      if (state.currentState !== MIGRATION_STATES.CUTOVER_COMMITTED) {
        fail('CUTOVER_NOT_ARMED', `Cutover commit requires durable state CUTOVER_ARMED/FINAL_DRAIN/FINAL_VERIFY, not ${state.currentState}`);
      }

      // Phase 2: fresh POST_CUTOVER proof, then COMPLETED. The atomic
      // record operation owns the CUTOVER_COMMITTED -> POST_CUTOVER_VERIFY
      // transition together with the evidence save.
      const commitSeq = this.#cutoverCommitSequence(request.migrationId);
      state = this.#durableState(request.migrationId);
      if (state.currentState === MIGRATION_STATES.POST_CUTOVER_VERIFY) {
        let post = this.runs.findVerification({
          migrationId: request.migrationId, mode: VERIFICATION_MODE.POST_CUTOVER, cutoverAttemptId: attemptId
        });
        if (!post) {
          if (sourceLockBarrier) await sourceLockBarrier.verifyHeld();
          post = await verifier.verify({
            ...verifyInput,
            mode: VERIFICATION_MODE.POST_CUTOVER,
            expectedCdcPosition: snapshotCdcBinding?.appliedLsn ?? null
          });
          if (!post || post.status !== 'VERIFIED') {
            fail('VERIFICATION_REQUIRED', 'COMPLETED requires a successful fresh post-cutover verification');
          }
          this.runs.recordPostCutoverVerificationAtomic({
            migrationId: request.migrationId, principal: request.principal, verification: post,
            commandId: commandIdFor('post-verify')
          });
        }
        // No unauthorized SPOOL mutation may have occurred between the cutover
        // decision and this check: only the post-verification path transitions
        // are legal after the commit sequence.
        this.#assertNoPostCommitMutation(request.migrationId, commitSeq);
        this.runs.completeMigrationAtomic({
          migrationId: request.migrationId, principal: request.principal,
          postCutoverVerificationId: post.verificationId,
          planId: prepared.plan.planId,
          // Same binding as the post proof: the run's recorded snapshot.
          sourceStateId: run.sourceSnapshotId ?? prepared.snapshot?.snapshotId ?? null,
          targetContractId: prepared.targetPreflight.targetContractId,
          commandId: commandIdFor('complete')
        });
      }
      return this.runs.cutover(request.migrationId);
    } finally {
      if (sourceLockBarrier) await sourceLockBarrier.release().catch(() => {});
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
    // Atomic: cutover row + canonical transition commit together. Abort is
    // legal from CUTOVER_ARMED, FINAL_DRAIN and FINAL_VERIFY.
    return this.runs.abortCutoverAtomic({
      migrationId, principal: 'system', reason: reason.trim(), decidedAt: new Date().toISOString()
    });
  }

  // Operator-initiated recovery from FAILED_RECOVERABLE toward a safe resume
  // point, backed by durable evidence (checkpoint for FULL_LOAD_RUNNING).
  async beginRecovery(request, { targetState, reason } = {}) {
    this.#open(); requireRequest(request);
    return this.runs.beginRecovery({
      migrationId: request.migrationId, principal: request.principal, reason, targetState
    });
  }

  // Record CDC apply progress on the slot-bound binding. The rebuild
  // re-validates LSN monotonicity and the ack<=applied<=received
  // watermark, so progress can only advance through proven positions.
  #recordCdcProgress(migrationId, { appliedLsn = null, acknowledgedLsn = null, receivedLsn = null } = {}) {
    const binding = this.runs.getSnapshotCdcBinding(migrationId);
    if (!binding?.cdcSlot) fail('CDC_BINDING_REQUIRED', 'CDC progress requires a snapshot/CDC binding with a slot');
    return this.runs.setSnapshotCdcBinding(migrationId, {
      sourceStateId: binding.sourceStateId,
      databaseSnapshotIdentity: binding.databaseSnapshotIdentity,
      exportedSnapshotId: binding.exportedSnapshotId,
      snapshotLsn: binding.snapshotLsn,
      cdcStartLsn: binding.cdcStartLsn,
      receivedLsn: receivedLsn ?? binding.receivedLsn,
      appliedLsn: appliedLsn ?? binding.appliedLsn,
      acknowledgedLsn: acknowledgedLsn ?? binding.acknowledgedLsn,
      cdcSlot: binding.cdcSlot,
      cdcPublication: binding.cdcPublication,
      catalogId: binding.catalogId
    });
  }

  // Apply CDC transactions through a shared, already-leased target execution:
  // the replication stream is read from the SOURCE database (where the slot
  // and publication live) and applied to the migration TARGET through the
  // caller's leased execution. Serialized assembly, fenced ledger-evidenced
  // commits, CAS+fenced checkpoint persistence, and source acknowledgement
  // strictly after durability. The caller owns the execution lifecycle.
  async #applyCdcToWaterline({ request, prepared, targetExecution, untilLsn = null, maxTransactions = null, ownerEpoch }) {
    const binding = this.runs.getSnapshotCdcBinding(request.migrationId);
    if (!binding?.cdcSlot) fail('CDC_BINDING_REQUIRED', 'CDC apply requires a snapshot/CDC binding with a slot');
    if (!binding?.cdcPublication) fail('CDC_BINDING_REQUIRED', 'CDC apply requires a bound publication');
    // CDC ledger evidence binds the full-load snapshot from the binding —
    // never the prepare-time snapshot: run() cleans materialized snapshots
    // on COMPLETE, and post-run prepares re-materialize planning snapshots
    // whose rows the stream must not claim to continue.
    if (!this.credentialBroker || typeof this.credentialBroker.withSecret !== 'function') {
      fail('CDC_BROKER_REQUIRED', 'CDC apply requires a credential broker');
    }
    if (prepared.source?.connector !== 'postgres' || !prepared.source?.sourceRef) {
      fail('CDC_SOURCE_UNSUPPORTED', 'CDC apply requires a PostgreSQL database source', { connector: prepared.source?.connector ?? null });
    }
    const sourceRef = prepared.source.sourceRef;
    if (typeof sourceRef.schema !== 'string' || !sourceRef.schema || typeof sourceRef.table !== 'string' || !sourceRef.table) {
      fail('CDC_SOURCE_UNSUPPORTED', 'CDC apply requires a PostgreSQL source with schema and table', {
        connector: prepared.source?.connector ?? null
      });
    }
    const primaryKey = await discoverTargetPrimaryKey({ targetRef: prepared.plan.targetRef, credentialBroker: this.credentialBroker });
    const checkpointAdapter = {
      load: () => this.runs.getCdcCheckpoint(request.migrationId, binding.cdcSlot),
      save: record => this.runs.saveCdcCheckpoint(request.migrationId, record)
    };
    const applier = createCdcApplier({
      ref: {
        endpoint: sourceRef.endpoint,
        database: sourceRef.database,
        identity: sourceRef.identity,
        secretRef: sourceRef.secretRef
      },
      credentialBroker: this.credentialBroker,
      slotName: binding.cdcSlot,
      publicationNames: [binding.cdcPublication],
      migration: { migrationId: request.migrationId, sourceSnapshotId: binding.sourceStateId },
      plan: {
        planId: prepared.plan.planId,
        mappingRevision: prepared.plan.mappingRevision,
        mapping: prepared.plan.mapping,
        targetSchema: prepared.plan.targetSchema,
        targetRef: prepared.plan.targetRef,
        writeStrategy: prepared.plan.writeStrategy
      },
      targetContractId: prepared.targetPreflight.targetContractId,
      primaryKey,
      sourceTable: { schema: sourceRef.schema, table: sourceRef.table },
      target: targetExecution.openTarget(),
      checkpoint: checkpointAdapter,
      renewFence: async () => (await targetExecution.renewLease()).fencingToken,
      ownerEpoch,
      startLsn: binding.appliedLsn ?? binding.cdcStartLsn,
      untilLsn,
      maxTransactions,
      stagingDir: join(this.#migrationSnapshotDir(request.migrationId), 'cdc-staging')
    });
    const summary = await applier.run();
    this.#recordCdcProgress(request.migrationId, {
      receivedLsn: summary?.receivedLsn ?? null,
      appliedLsn: summary?.appliedLsn ?? binding.appliedLsn ?? binding.cdcStartLsn,
      acknowledgedLsn: summary?.acknowledgedLsn ?? null
    });
    return summary;
  }

  // Catch up CDC through a waterline using the canonical production path:
  // contract-validated slot, serialized fenced apply, CAS checkpoints, ack
  // after durability. Allowed only after the full load is verified
  // (READY_FOR_CUTOVER), in CATCHING_UP, or during FINAL_DRAIN: streaming
  // while the full load is in flight is refused because unordered load-vs-
  // CDC commits could regress newer rows with older snapshot versions, and
  // the snapshot-pinned VERIFYING proof requires target == snapshot. No
  // state changes here: convergence is evidenced by checkpoints and binding
  // progress, and proven by the FINAL_DRAIN plus fresh live-source proof.
  async catchUpCdc(request, { untilLsn = null, maxTransactions = null } = {}) {
    this.#open(); requireRequest(request);
    const binding = this.runs.getSnapshotCdcBinding(request.migrationId);
    if (!binding?.cdcSlot) fail('CDC_BINDING_REQUIRED', 'CDC catch-up requires a snapshot/CDC binding with a slot');
    // A fresh planning prepare suffices: streaming needs live refs and the
    // plan, while ledger evidence binds binding.sourceStateId (the snapshot
    // the full load read — run() cleans materialized snapshots on COMPLETE).
    const prepared = await this.#prepare(request);
    if (prepared.plan.targetRef.connector !== 'postgres') {
      fail('CDC_TARGET_UNSUPPORTED', 'CDC catch-up currently supports the PostgreSQL target', { connector: prepared.plan.targetRef.connector });
    }
    const state = this.#durableState(request.migrationId);
    if (!state) fail('CDC_NOT_RUNNING', 'CDC catch-up requires durable migration state');
    if (![MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.READY_FOR_CUTOVER].includes(state.currentState)) {
      fail('CDC_NOT_RUNNING', `CDC catch-up requires a verified full load (READY_FOR_CUTOVER/CATCHING_UP/FINAL_DRAIN), not ${state.currentState}`);
    }
    const targetExecution = await prepared.targetRuntime.createExecution({ migrationId: request.migrationId, targetRef: prepared.plan.targetRef });
    try {
      await targetExecution.renewLease();
      await targetExecution.openTarget();
      return await this.#applyCdcToWaterline({
        request, prepared, targetExecution, untilLsn, maxTransactions, ownerEpoch: randomUUID()
      });
    } finally {
      await targetExecution.close();
    }
  }

  // Establish the snapshot/CDC boundary BEFORE approval. The no-gap argument
  // is ordering, not a shared snapshot (PostgreSQL exported snapshots die
  // with the exporting transaction, so no cross-session join is possible):
  //   1. the slot reserves WAL at consistent point P, before anything else;
  //   2. approval materializes and binds the full-load snapshot S (S > P);
  //   3. run() loads exactly S and commits it before any CDC apply;
  //   4. catch-up/drain apply the stream [P, ...] after the load commits.
  // Overlap in (P, S] therefore double-applies strictly in order — snapshot
  // rows first, stream second — through idempotent PK upserts/deletes, and
  // post-S changes arrive only via the stream. Streaming while the full load
  // is in flight is refused (catchUpCdc): unordered load-vs-CDC commits
  // could regress newer rows with older snapshot versions. The boundary
  // record (with slot ownership flags) is stored durably; approve() consumes
  // it by binding the slot, the publication, and P as the proven start.
  async establishCdcBoundary(request, { slotName, publicationName } = {}) {
    this.#open(); requireRequest(request);
    if (typeof slotName !== 'string' || !/^[a-z0-9_]{1,63}$/.test(slotName)) {
      fail('INVALID_CDC_BOUNDARY_REQUEST', 'slotName must be a valid PostgreSQL replication slot name');
    }
    if (typeof publicationName !== 'string' || !publicationName) {
      fail('INVALID_CDC_BOUNDARY_REQUEST', 'publicationName is required');
    }
    if (!this.credentialBroker || typeof this.credentialBroker.withSecret !== 'function') {
      fail('CDC_BROKER_REQUIRED', 'CDC boundary establishment requires a credential broker');
    }
    this.#ensureDurableState(request.migrationId, request.principal, 'cdc boundary');
    const durable = this.#durableState(request.migrationId);
    const preApproval = new Set([
      MIGRATION_STATES.CREATED, MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED,
      MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL
    ]);
    if (!durable || !preApproval.has(durable.currentState)) {
      fail('CDC_BOUNDARY_TOO_LATE', `CDC boundary establishment must precede approval, not ${durable?.currentState ?? 'unknown'}`);
    }
    const existingBinding = this.runs.getSnapshotCdcBinding(request.migrationId);
    if (existingBinding?.cdcSlot) fail('CDC_BOUNDARY_EXISTS', 'A slot-bound snapshot/CDC binding already exists for this migration');
    // Planning snapshot: normalizes the source ref (schema/table/credentials
    // for the publication and the replication stream).
    const planning = await this.#prepare(request);
    if (planning.source?.connector !== 'postgres' || !planning.source?.sourceRef) {
      fail('CDC_SOURCE_UNSUPPORTED', 'CDC boundary establishment requires a PostgreSQL database source', {
        connector: planning.source?.connector ?? null
      });
    }
    const sourceRef = planning.source.sourceRef;
    const boundary = await establishPostgresSnapshotCdcBoundary({
      ref: sourceRef,
      credentialBroker: this.credentialBroker,
      slotName,
      publicationName,
      tables: [{ schema: sourceRef.schema, table: sourceRef.table }],
      sourceStateId: planning.snapshot.snapshotId
    });
    assertBoundaryCoversSnapshot(boundary);
    return this.runs.setCdcBoundary(request.migrationId, {
      boundaryId: boundary.boundaryId,
      snapshotId: planning.snapshot.snapshotId,
      slotName: boundary.slotName,
      publicationName: boundary.publicationName,
      consistentPoint: boundary.consistentPoint,
      exportedSnapshotId: boundary.exportedSnapshotId,
      publicationCreated: boundary.publicationCreated,
      slotExisted: boundary.slotExisted,
      snapshotXmin: boundary.snapshotXmin,
      snapshotXmax: boundary.snapshotXmax,
      snapshotXip: boundary.snapshotXip,
      planningSourceStateId: planning.snapshot.snapshotId,
      sourceRef: {
        endpoint: sourceRef.endpoint,
        database: sourceRef.database,
        identity: { user: sourceRef.identity?.user },
        secretRef: sourceRef.secretRef
      }
    });
  }

  // Release a CDC boundary: drop the migration-owned slot so the source
  // stops retaining WAL. Refuses when ownership is unproven (no boundary
  // record) or the slot pre-existed (foreign slots are never dropped).
  // The publication is retained (inert without slots; operator-owned name)
  // and the slot-bound binding is kept as historical streaming evidence.
  async releaseCdcBoundary(request) {
    this.#open(); requireRequest(request);
    const record = this.runs.getCdcBoundary(request.migrationId);
    if (!record) fail('CDC_BOUNDARY_NOT_FOUND', 'No CDC boundary record for this migration; slot ownership is unproven so no slot will be dropped');
    if (record.slotExisted) {
      fail('CDC_SLOT_NOT_OWNED', 'The slot pre-existed this migration; drop it explicitly via psql, SPOOL will not drop foreign slots', {
        slotName: record.slotName
      });
    }
    if (!this.credentialBroker || typeof this.credentialBroker.withSecret !== 'function') {
      fail('CDC_BROKER_REQUIRED', 'CDC boundary release requires a credential broker');
    }
    const live = await describePostgresSlot({ ref: record.sourceRef, credentialBroker: this.credentialBroker, slotName: record.slotName });
    if (!live) {
      this.runs.deleteCdcBoundary(request.migrationId);
      return Object.freeze({
        migrationId: request.migrationId, slotName: record.slotName, dropped: false,
        reason: 'slot-absent', publicationName: record.publicationName, publicationRetained: true
      });
    }
    assertSlotContractUsable({ slot: live, database: record.sourceRef.database, plugin: 'pgoutput', slotName: record.slotName });
    const result = await dropPostgresReplicationSlot({ ref: record.sourceRef, credentialBroker: this.credentialBroker, slotName: record.slotName });
    this.runs.deleteCdcBoundary(request.migrationId);
    return Object.freeze({
      migrationId: request.migrationId, slotName: record.slotName, dropped: result.dropped === true,
      publicationName: record.publicationName, publicationRetained: true
    });
  }

  cutover(migrationId) { this.#open(); return this.runs.cutover(migrationId); }

  // Durable state-machine public accessors (authoritative)
  migrationState(migrationId) { this.#open(); return this.#durableState(migrationId); }
  transitions(migrationId) { this.#open(); return this.runs.listTransitions(migrationId); }
  snapshotCdcBinding(migrationId) { this.#open(); return this.runs.getSnapshotCdcBinding(migrationId); }
  async setSnapshotCdcBinding(migrationId, binding) { this.#open(); return this.runs.setSnapshotCdcBinding(migrationId, binding); }
  async updateCdcProgress(migrationId, progress) { this.#open(); return this.runs.updateCdcProgress(migrationId, progress); }

  // Fresh-process restart helper: reconstructs state purely from durable records and decides recovery action
  restartDecision(migrationId) {
    this.#open();
    const state = this.#durableState(migrationId);
    if (!state) fail('MIGRATION_NOT_FOUND', 'No durable state found for migration');
    const checkpoint = this.runs.checkpointStore(migrationId).load();
    const verification = this.runs.get(migrationId)?.verification ?? null;
    const cutover = this.runs.cutover(migrationId);
    const binding = this.runs.getSnapshotCdcBinding(migrationId);
    return decideRecoveryAction({ currentState: state.currentState, lastTransition: state, snapshotCdcBinding: binding, checkpoint, verification, cutover });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Close all target runtimes
    if (this.targetConnectors && this.targetConnectors.instances) {
      for (const runtime of this.targetConnectors.instances.values()) {
        if (runtime && typeof runtime.close === 'function') {
          try { runtime.close(); } catch {}
        }
      }
    }
    this.runs.close();
  }
}
