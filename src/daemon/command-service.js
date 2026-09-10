import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fail } from '../core/errors.js';
import { parseCsv } from '../core/csv.js';
import { inferSchema } from '../core/schema.js';
import { MigrationEngine } from '../core/migration.js';
import { readFileSnapshot } from '../connectors/source-snapshot.js';
import { SqliteTarget } from '../connectors/sqlite/target.js';
import { inspectSqliteTarget } from '../connectors/sqlite/preflight.js';
import { createPathPolicy } from '../platform/path-policy.js';
import { connectorIdentity } from '../platform/contracts.js';
import { createMigrationPlan } from '../platform/plan.js';
import { createBoundApproval, assertBoundApproval } from '../platform/approval.js';
import { createBatchIdentity } from '../execution/batch-identity.js';
import { MigrationRunner } from '../execution/migration-runner.js';
import { LeaseStore } from '../execution/lease-store.js';
import { verifyMigration } from '../execution/verify.js';
import { createMigrationReceipt } from '../execution/receipt.js';
import { RunStore } from './run-store.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

function requireRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_MIGRATION_REQUEST', 'Migration request must be an object');
  if (!MIGRATION_ID.test(request.migrationId ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  if (typeof request.principal !== 'string' || !request.principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
  if (!request.planInput || typeof request.planInput !== 'object' || Array.isArray(request.planInput)) fail('INVALID_MIGRATION_REQUEST', 'planInput is required');
}

function approvalEffects(plan) {
  return [
    'sqlite:insert_rows',
    'sqlite:write_batch_ledger',
    ...plan.risk.approvals.map(value => `approval:${value}`)
  ].sort();
}

function approvalBinding(request, plan, snapshot, targetContractId, expiresAt, nonce) {
  return {
    migrationId: request.migrationId,
    planId: plan.planId,
    planRevision: plan.planRevision,
    sourceSnapshotId: snapshot.snapshotId,
    targetIdentity: plan.targetRef,
    targetContractId,
    effects: approvalEffects(plan),
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
    const sourcePolicy = await createPathPolicy(options.sourceRoot);
    const targetPolicy = await createPathPolicy(options.targetRoot);
    return new SpoolCommandService({
      sourcePolicy,
      targetPolicy,
      statePath: options.statePath,
      approvalSigningKey: options.approvalSigningKey,
      maxSourceBytes,
      release: releaseIdentity(options.release ?? {
        version: process.env.SPOOL_RELEASE_VERSION ?? '1.0.0',
        commitSha: process.env.SPOOL_COMMIT_SHA
      })
    });
  }

  constructor({ sourcePolicy, targetPolicy, statePath, approvalSigningKey, maxSourceBytes, release }) {
    this.sourcePolicy = sourcePolicy;
    this.targetPolicy = targetPolicy;
    this.approvalSigningKey = approvalSigningKey;
    this.maxSourceBytes = maxSourceBytes;
    this.release = release;
    this.runs = new RunStore({ path: statePath });
    this.closed = false;
  }

  #open() { if (this.closed) fail('COMMAND_SERVICE_CLOSED', 'Command service is closed'); }

  async #prepare(request) {
    this.#open(); requireRequest(request);
    const input = structuredClone(request.planInput);
    if (input.sourceRef?.connector !== 'filesystem') fail('UNSUPPORTED_SOURCE_CONNECTOR', 'Gate B supports filesystem CSV sources only');
    if (input.targetRef?.connector !== 'sqlite') fail('UNSUPPORTED_TARGET_CONNECTOR', 'Gate B supports SQLite targets only');
    if (input.sourceRef.secretRef || input.targetRef.secretRef) fail('UNSUPPORTED_LOCAL_CONNECTOR_SECRET', 'Filesystem/SQLite Gate B connectors do not accept credentials');
    if (input.writeStrategy?.mode !== 'insert') fail('UNSUPPORTED_WRITE_STRATEGY', 'Gate B SQLite currently supports insert mode only');
    if (!Number.isInteger(input.writeStrategy?.batchSize) || input.writeStrategy.batchSize < 1 || input.writeStrategy.batchSize > 10000) {
      fail('INVALID_WRITE_STRATEGY', 'SQLite batchSize must be between 1 and 10000');
    }
    if (typeof input.targetRef.table !== 'string' || !input.targetRef.table) fail('INVALID_TARGET_REF', 'SQLite targetRef.table is required');

    const sourcePath = await this.sourcePolicy.resolve(input.sourceRef.path ?? input.sourceRef.resource);
    const targetPath = await this.targetPolicy.resolve(input.targetRef.path, { mustExist: true });
    input.sourceRef.path = sourcePath;
    input.targetRef.path = targetPath;

    const { snapshot, bytes } = await readFileSnapshot(sourcePath);
    if (bytes.length > this.maxSourceBytes) fail('SOURCE_TOO_LARGE', `Local runner source exceeds ${this.maxSourceBytes} byte limit`, { bytes: bytes.length, limit: this.maxSourceBytes });
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('INVALID_SOURCE_ENCODING', 'Gate B CSV source must be valid UTF-8'); }
    const parsed = parseCsv(text, { maxInputBytes: this.maxSourceBytes });
    if (parsed.rows.length === 0) fail('EMPTY_SOURCE', 'CSV source must contain at least one data row');
    const plan = await createMigrationPlan(input);
    if (!plan.risk.approvals.includes('target_write')) {
      fail('TARGET_WRITE_APPROVAL_REQUIRED', 'Gate B SQLite mutations require target_write in plan.risk.approvals');
    }
    const targetPreflight = inspectSqliteTarget({ path: targetPath, table: plan.targetRef.table, targetSchema: plan.targetSchema });
    return { request, plan, snapshot, parsed, sourcePath, targetPath, targetPreflight };
  }

  async inspect(request) {
    const prepared = await this.#prepare(request);
    return Object.freeze({
      migrationId: request.migrationId,
      sourceRows: prepared.parsed.rows.length,
      sourceBytes: prepared.snapshot.size,
      sourceSnapshotId: prepared.snapshot.snapshotId,
      sourceSchema: Object.freeze(inferSchema(prepared.parsed.rows).map(field => Object.freeze({ ...field }))),
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

  async plan(request) { return (await this.#prepare(request)).plan; }

  async dryRun(request) {
    const prepared = await this.#prepare(request);
    const result = new MigrationEngine().run(prepared.parsed.rows, prepared.plan.mapping, prepared.plan.mappingRevision, prepared.plan.targetSchema);
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
    return createBoundApproval(
      approvalBinding(request, prepared.plan, prepared.snapshot, prepared.targetPreflight.targetContractId, expiresAt, nonce),
      { signingKey: this.approvalSigningKey }
    );
  }

  runSyncGuard() { fail('ASYNC_COMMAND_ONLY', 'Production command execution is asynchronous'); }

  async run(request, { approval = null } = {}) {
    const prepared = await this.#prepare(request);
    const { plan, snapshot, parsed, targetPath, targetPreflight } = prepared;
    const current = this.runs.get(request.migrationId);
    const targetIdentity = connectorIdentity(plan.targetRef);
    if (current?.status === 'COMPLETE') {
      const priorContractId = current.receipt?.record?.targetContractId ?? null;
      if (current.planId !== plan.planId || current.sourceSnapshotId !== snapshot.snapshotId || JSON.stringify(current.targetIdentity) !== JSON.stringify(targetIdentity) || priorContractId !== targetPreflight.targetContractId) {
        fail('MIGRATION_ID_REUSE_CONFLICT', 'Completed migrationId cannot be reused for changed semantics or target contract');
      }
      return Object.freeze({ status: 'COMPLETE', verification: current.verification, receipt: current.receipt, replay: true });
    }

    if (!approval) fail('APPROVAL_REQUIRED', 'This migration plan requires bound approval evidence');
    assertBoundApproval(
      approval,
      approvalBinding(request, plan, snapshot, targetPreflight.targetContractId, approval.record?.expiresAt, approval.record?.nonce),
      { signingKey: this.approvalSigningKey }
    );

    const startedAt = current?.startedAt ?? new Date().toISOString();
    const leaseResource = `sqlite:${targetPath}:${plan.targetRef.table}`;
    const leaseOwner = `migration:${request.migrationId}:${randomUUID()}`;
    const leaseStore = new LeaseStore({ path: targetPath });
    let target;
    let lease;
    let ownsRunState = false;
    try {
      lease = leaseStore.acquire({ resource: leaseResource, owner: leaseOwner, ttlMs: 5 * 60 * 1000 });
      this.runs.start({ migrationId: request.migrationId, planId: plan.planId, sourceSnapshotId: snapshot.snapshotId, targetIdentity, startedAt });
      ownsRunState = true;
      target = new SqliteTarget({ path: targetPath, table: plan.targetRef.table, requireFencing: true, fenceResource: leaseResource });
      const checkpointStore = this.runs.checkpointStore(request.migrationId);
      const runner = new MigrationRunner({ target, checkpointStore });
      const engine = new MigrationEngine();
      const batchSize = plan.writeStrategy.batchSize;
      const allRanges = [];
      for (let start = 0; start < parsed.rows.length; start += batchSize) allRanges.push({ start, endExclusive: Math.min(parsed.rows.length, start + batchSize) });
      const expectedBatchIdentities = allRanges.map(sourceRange => createBatchIdentity({
        migrationId: request.migrationId,
        planId: plan.planId,
        sourceSnapshotId: snapshot.snapshotId,
        mappingRevision: plan.mappingRevision,
        sourceRange,
        targetIdentity: plan.targetRef
      }));

      const checkpoint = checkpointStore.load();
      const resumeOffset = checkpoint?.nextOffset ?? 0;
      if (resumeOffset > parsed.rows.length) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint exceeds source row count');
      for (const sourceRange of allRanges) {
        if (sourceRange.endExclusive <= resumeOffset) continue;
        if (sourceRange.start < resumeOffset) fail('CHECKPOINT_OFFSET_MISMATCH', 'Checkpoint falls inside a batch boundary');
        const chunk = parsed.rows.slice(sourceRange.start, sourceRange.endExclusive);
        const transformed = engine.run(chunk, plan.mapping, plan.mappingRevision, plan.targetSchema);
        runner.runBatch({
          migrationId: request.migrationId,
          planId: plan.planId,
          sourceSnapshotId: snapshot.snapshotId,
          mappingRevision: plan.mappingRevision,
          sourceRange,
          targetIdentity: plan.targetRef,
          targetContractId: targetPreflight.targetContractId,
          rows: transformed.output,
          fencingToken: lease.fencingToken
        });
      }

      const dry = engine.run(parsed.rows, plan.mapping, plan.mappingRevision, plan.targetSchema);
      const ledgerEntries = target.ledgerEntries().filter(entry => entry.migrationId === request.migrationId && entry.targetTable === plan.targetRef.table);
      const verification = verifyMigration({
        sourceRows: parsed.rows.length,
        writtenRows: dry.validRows,
        rejectedRows: dry.invalidRows,
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
        counts: { sourceRows: parsed.rows.length, writtenRows: dry.validRows, rejectedRows: dry.invalidRows, filteredRows: 0 },
        violationsSummary: canonicalViolationSummary(dry.violations).map(({ code, count }) => ({ code, count })),
        verification,
        startedAt,
        completedAt
      });
      this.runs.complete({ migrationId: request.migrationId, verification, receipt, completedAt });
      try {
        this.runs.clearCheckpoint(request.migrationId);
      } catch {
        // Completion and receipt are already durable. An obsolete checkpoint is ignored
        // by the COMPLETE replay path and must never rewrite verified terminal truth.
      }
      return Object.freeze({ status: 'COMPLETE', verification, receipt, replay: false });
    } catch (error) {
      if (ownsRunState) {
        const existing = this.runs.get(request.migrationId);
        if (existing?.status !== 'COMPLETE') this.runs.fail({ migrationId: request.migrationId, errorCode: error?.code ?? 'MIGRATION_FAILED' });
      }
      throw error;
    } finally {
      if (target) target.close();
      if (lease) leaseStore.release({ resource: lease.resource, owner: lease.owner, fencingToken: lease.fencingToken });
      leaseStore.close();
    }
  }

  status(migrationId) { this.#open(); return this.runs.get(migrationId); }
  verification(migrationId) { const run = this.status(migrationId); if (!run?.verification) fail('VERIFICATION_NOT_AVAILABLE', 'Verification is not available'); return run.verification; }
  receipt(migrationId) { const run = this.status(migrationId); if (!run?.receipt) fail('RECEIPT_NOT_AVAILABLE', 'Receipt is not available'); return run.receipt; }
  close() { if (!this.closed) { this.runs.close(); this.closed = true; } }
}
