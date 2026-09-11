import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { inferSchema } from '../core/schema.js';
import { MigrationEngine } from '../core/migration.js';
import {
  createDurableFileSnapshot,
  loadDurableFileSnapshot,
  verifyFileAgainstSnapshot
} from '../connectors/source-snapshot.js';
import { inspectCsvStream, streamCsvRows } from '../connectors/filesystem/stream-csv.js';
import { ConnectorRegistry } from '../connectors/registry.js';
import {
  SQLITE_TARGET_DESCRIPTOR,
  createSqliteTargetRuntime
} from '../connectors/sqlite/runtime.js';
import { createPathPolicy } from '../platform/path-policy.js';
import { connectorIdentity } from '../platform/contracts.js';
import { createMigrationPlan } from '../platform/plan.js';
import { createBoundApproval, assertBoundApproval } from '../platform/approval.js';
import { createBatchIdentity } from '../execution/batch-identity.js';
import { assertCheckpointBinding } from '../execution/checkpoint.js';
import { MigrationRunner } from '../execution/migration-runner.js';
import { verifyMigration } from '../execution/verify.js';
import { createMigrationReceipt } from '../execution/receipt.js';
import { RunStore } from './run-store.js';

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

    const targetConnectors = new ConnectorRegistry();
    const sqliteTargetRuntime = await createSqliteTargetRuntime({ targetRoot: options.targetRoot });
    targetConnectors.register(SQLITE_TARGET_DESCRIPTOR, async () => sqliteTargetRuntime);

    return new SpoolCommandService({
      sourcePolicy,
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

  constructor({ sourcePolicy, targetConnectors, statePath, snapshotRoot, approvalSigningKey, maxSourceBytes, release }) {
    this.sourcePolicy = sourcePolicy;
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
    if (typeof connector !== 'string' || !connector) {
      fail('INVALID_TARGET_REF', 'targetRef.connector is required');
    }

    try {
      return await this.targetConnectors.open(connector, 'target');
    } catch (error) {
      if (error?.code === 'CONNECTOR_NOT_REGISTERED') {
        fail('UNSUPPORTED_TARGET_CONNECTOR', `Unsupported target connector ${connector}`);
      }
      throw error;
    }
  }

  async #prepare(request, { expectedSourceSnapshotId = null } = {}) {
    this.#open(); requireRequest(request);
    let input = structuredClone(request.planInput);
    if (input.sourceRef?.connector !== 'filesystem') fail('UNSUPPORTED_SOURCE_CONNECTOR', 'Gate B supports filesystem CSV sources only');
    if (input.sourceRef.secretRef) fail('UNSUPPORTED_LOCAL_CONNECTOR_SECRET', 'Filesystem Gate B source does not accept credentials');

    const targetRuntime = await this.#openTargetRuntime(input.targetRef);

    let sourcePath;
    try {
      sourcePath = await this.sourcePolicy.resolve(input.sourceRef.path ?? input.sourceRef.resource);
    } catch (error) {
      if (expectedSourceSnapshotId && error?.code === 'PATH_NOT_FOUND') {
        fail('SOURCE_CHANGED', 'Source file is no longer available at the approved path');
      }
      throw error;
    }

    input.sourceRef.path = sourcePath;
    input = await targetRuntime.normalizePlanInput(input);

    const snapshotDir = this.#migrationSnapshotDir(request.migrationId);
    const durable = expectedSourceSnapshotId
      ? await loadDurableFileSnapshot(sourcePath, { snapshotDir, snapshotId: expectedSourceSnapshotId, maxBytes: this.maxSourceBytes })
      : await createDurableFileSnapshot(sourcePath, { snapshotDir, maxBytes: this.maxSourceBytes });
    const streamed = await inspectCsvStream(durable.snapshotPath, {
      sampleSize: INFERENCE_SAMPLE_SIZE,
      maxInputBytes: this.maxSourceBytes
    });
    if (streamed.rowCount === 0) fail('EMPTY_SOURCE', 'CSV source must contain at least one data row');

    const plan = await createMigrationPlan(input);
    if (!plan.risk.approvals.includes('target_write')) {
      fail('TARGET_WRITE_APPROVAL_REQUIRED', 'Production target mutations require target_write in plan.risk.approvals');
    }
    const targetPreflight = await targetRuntime.preflight(plan);
    return {
      request,
      plan,
      snapshot: durable.snapshot,
      snapshotPath: durable.snapshotPath,
      sourceRows: streamed.rowCount,
      sourceHeaders: streamed.headers,
      sampleRows: streamed.sampleRows,
      sourcePath,
      targetRuntime,
      targetPreflight
    };
  }

  async inspect(request) {
    const prepared = await this.#prepare(request);
    return Object.freeze({
      migrationId: request.migrationId,
      sourceRows: prepared.sourceRows,
      sourceBytes: prepared.snapshot.size,
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
      maxSourceBytes: this.maxSourceBytes
    });
  }

  async plan(request) {
    return (await this.#prepare(request)).plan;
  }

  async dryRun(request) {
    const prepared = await this.#prepare(request);
    const accumulator = new MigrationEngine().createAccumulator(prepared.plan.mapping, prepared.plan.mappingRevision, prepared.plan.targetSchema);
    for await (const { rowIndex, row } of streamCsvRows(prepared.snapshotPath, { maxInputBytes: this.maxSourceBytes })) {
      accumulator.process(row, rowIndex);
    }
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
      approvalBinding(
        request,
        prepared.plan,
        prepared.snapshot,
        prepared.targetPreflight.targetContractId,
        effects,
        expiresAt,
        nonce
      ),
      { signingKey: this.approvalSigningKey }
    );
  }

  runSyncGuard() { fail('ASYNC_COMMAND_ONLY', 'Production command execution is asynchronous'); }

  async run(request, { approval = null } = {}) {
    this.#open(); requireRequest(request);
    const current = this.runs.get(request.migrationId);
    const expectedSourceSnapshotId = current?.status === 'COMPLETE' ? null : (approval?.record?.sourceSnapshotId ?? null);
    const prepared = await this.#prepare(request, { expectedSourceSnapshotId });
    const { plan, snapshot, snapshotPath, sourceRows, targetRuntime, targetPreflight } = prepared;
    const targetIdentity = connectorIdentity(plan.targetRef);

    if (current?.status === 'COMPLETE') {
      const priorContractId = current.receipt?.record?.targetContractId ?? null;
      if (current.planId !== plan.planId || current.sourceSnapshotId !== snapshot.snapshotId || JSON.stringify(current.targetIdentity) !== JSON.stringify(targetIdentity) || priorContractId !== targetPreflight.targetContractId) {
        fail('MIGRATION_ID_REUSE_CONFLICT', 'Completed migrationId cannot be reused for changed semantics or target contract');
      }
      try { await this.#cleanupSnapshots(request.migrationId); } catch { /* terminal truth is already durable */ }
      return Object.freeze({ status: 'COMPLETE', verification: current.verification, receipt: current.receipt, replay: true });
    }

    if (!approval) fail('APPROVAL_REQUIRED', 'This migration plan requires bound approval evidence');
    const effects = await targetRuntime.approvalEffects(plan);
    assertBoundApproval(
      approval,
      approvalBinding(
        request,
        plan,
        snapshot,
        targetPreflight.targetContractId,
        effects,
        approval.record?.expiresAt,
        approval.record?.nonce
      ),
      { signingKey: this.approvalSigningKey }
    );

    // Execute only the bytes represented by the bound approval. If the user's original
    // file changed since approval, fail before acquiring a target write lease.
    await verifyFileAgainstSnapshot(snapshot);

    const startedAt = current?.startedAt ?? new Date().toISOString();
    const targetExecution = await targetRuntime.createExecution({
      migrationId: request.migrationId,
      targetRef: plan.targetRef
    });
    let lease;
    let ownsRunState = false;
    const renewLease = async () => {
      lease = await targetExecution.renewLease();
      return lease;
    };

    try {
      await renewLease();
      this.runs.start({ migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId, targetIdentity, startedAt });
      ownsRunState = true;

      const target = await targetExecution.openTarget();
      const checkpointStore = this.runs.checkpointStore(request.migrationId);
      const runner = new MigrationRunner({ target, checkpointStore });
      const engine = new MigrationEngine();
      const accumulator = engine.createAccumulator(plan.mapping, plan.mappingRevision, plan.targetSchema);
      const batchSize = plan.writeStrategy.batchSize;
      const allRanges = [];
      for (let start = 0; start < sourceRows; start += batchSize) {
        allRanges.push({ start, endExclusive: Math.min(sourceRows, start + batchSize) });
      }
      const expectedBatchIdentities = allRanges.map(sourceRange => createBatchIdentity({
        migrationId: request.migrationId,
        planId: plan.planId,
        sourceSnapshotId: snapshot.snapshotId,
        mappingRevision: plan.mappingRevision,
        sourceRange,
        targetIdentity: plan.targetRef
      }));

      const checkpoint = await checkpointStore.load();
      const resumeOffset = checkpoint?.nextOffset ?? 0;
      if (checkpoint) {
        assertCheckpointBinding(checkpoint, {
          migrationId: request.migrationId,
          planId: plan.planId,
          sourceSnapshotId: snapshot.snapshotId,
          mappingRevision: plan.mappingRevision,
          targetIdentity: plan.targetRef
        });
      }
      if (resumeOffset > sourceRows) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint exceeds source row count');
      if (resumeOffset !== sourceRows && resumeOffset % batchSize !== 0) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint falls inside a batch boundary');

      let batchRows = [];
      let lastSeenRow = -1;
      for await (const { rowIndex, row } of streamCsvRows(snapshotPath, { maxInputBytes: this.maxSourceBytes })) {
        lastSeenRow = rowIndex;
        const transformed = accumulator.process(row, rowIndex);
        const sourceRangeStart = Math.floor(rowIndex / batchSize) * batchSize;
        const sourceRangeEnd = Math.min(sourceRows, sourceRangeStart + batchSize);
        if (rowIndex >= resumeOffset && transformed.ok) batchRows.push(transformed.row);

        if (rowIndex + 1 === sourceRangeEnd) {
          if (sourceRangeEnd <= resumeOffset) {
            batchRows = [];
            continue;
          }
          if (sourceRangeStart < resumeOffset) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint falls inside a batch boundary');
          await renewLease();
          await runner.runBatchAsync({
            migrationId: request.migrationId,
            planId: plan.planId,
            sourceSnapshotId: snapshot.snapshotId,
            mappingRevision: plan.mappingRevision,
            sourceRange: { start: sourceRangeStart, endExclusive: sourceRangeEnd },
            targetIdentity: plan.targetRef,
            targetContractId: targetPreflight.targetContractId,
            rows: batchRows,
            fencingToken: lease.fencingToken
          });
          batchRows = [];
        }
      }
      if (lastSeenRow + 1 !== sourceRows) fail('SOURCE_ROW_COUNT_CHANGED', 'Durable snapshot row count changed between preparation and execution');
      if (batchRows.length !== 0) fail('INTERNAL_BATCH_STATE', 'Streaming execution ended with an uncommitted batch');

      const summary = accumulator.summary();
      const ledgerEntries = await targetExecution.ledgerEntries();
      const verification = verifyMigration({
        sourceRows,
        writtenRows: summary.validRows,
        rejectedRows: summary.invalidRows,
        filteredRows: 0,
        expectedBatchIdentities,
        ledgerEntries
      });
      const completedAt = new Date().toISOString();
      const receipt = createMigrationReceipt({
        release: this.release,
        migrationId: request.migrationId,
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
      try { this.runs.clearCheckpoint(request.migrationId); } catch { /* terminal truth is already durable */ }
      try { await this.#cleanupSnapshots(request.migrationId); } catch { /* terminal truth is already durable */ }
      return Object.freeze({ status: 'COMPLETE', verification, receipt, replay: false });
    } catch (error) {
      if (ownsRunState) {
        const existing = this.runs.get(request.migrationId);
        if (existing?.status !== 'COMPLETE') this.runs.fail({ migrationId: request.migrationId, errorCode: error?.code ?? 'MIGRATION_FAILED' });
      }
      throw error;
    } finally {
      await targetExecution.close();
    }
  }

  status(migrationId) { this.#open(); return this.runs.get(migrationId); }
  verification(migrationId) { const run = this.status(migrationId); if (!run?.verification) fail('VERIFICATION_NOT_AVAILABLE', 'Verification is not available'); return run.verification; }
  receipt(migrationId) { const run = this.status(migrationId); if (!run?.receipt) fail('RECEIPT_NOT_AVAILABLE', 'Receipt is not available'); return run.receipt; }
  close() { if (!this.closed) { this.runs.close(); this.closed = true; } }
}
