import { randomUUID } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { createPathPolicy } from '../../platform/path-policy.js';
import { LeaseStore } from '../../execution/lease-store.js';
import { validateConnectorDescriptor } from '../contract.js';
import { inspectSqliteTarget } from './preflight.js';
import { SqliteTarget } from './target.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export const SQLITE_TARGET_DESCRIPTOR = validateConnectorDescriptor({
  name: 'sqlite',
  role: 'target',
  version: 1,
  assurance: { level: 'C4' },
  capabilities: {
    transactions: true,
    atomicBatchLedger: true,
    reconcileAfterCrash: true,
    idempotentReplay: true,
    fencing: true,
    targetContractBinding: true,
    exactCommitEvidence: true
  }
});

function requireLeaseTtlMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_SQLITE_RUNTIME_CONFIG', 'leaseTtlMs must be a positive safe integer');
  return value;
}

function requireMigrationId(value) {
  if (!MIGRATION_ID.test(value ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  return value;
}

function requireSqliteTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'SQLite targetRef is required');
  if (targetRef.connector !== 'sqlite') fail('UNSUPPORTED_TARGET_CONNECTOR', 'SQLite target runtime requires connector sqlite');
  if (targetRef.secretRef) fail('UNSUPPORTED_LOCAL_CONNECTOR_SECRET', 'SQLite Gate B target does not accept credentials');
  if (typeof targetRef.path !== 'string' || !targetRef.path) fail('INVALID_TARGET_REF', 'SQLite targetRef.path is required');
  if (typeof targetRef.table !== 'string' || !targetRef.table) fail('INVALID_TARGET_REF', 'SQLite targetRef.table is required');
  return targetRef;
}

function requirePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_MIGRATION_PLAN', 'Plan input must be an object');
  return input;
}

function approvalEffects(plan) {
  const approvals = Array.isArray(plan?.risk?.approvals) ? plan.risk.approvals : [];
  return Object.freeze(['sqlite:insert_rows', 'sqlite:write_batch_ledger', ...approvals.map(value => `approval:${value}`)].sort());
}

class SqliteTargetExecution {
  constructor({ migrationId, targetRef, leaseTtlMs }) {
    this.migrationId = requireMigrationId(migrationId);
    this.targetRef = Object.freeze({ ...requireSqliteTargetRef(targetRef) });
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
    this.leaseResource = `sqlite:${this.targetRef.path}:${this.targetRef.table}`;
    this.leaseOwner = `migration:${this.migrationId}:${randomUUID()}`;
    this.leaseStore = new LeaseStore({ path: this.targetRef.path });
    this.lease = null;
    this.target = null;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('SQLITE_EXECUTION_CLOSED', 'SQLite target execution is closed');
  }

  renewLease({ nowMs = Date.now() } = {}) {
    this.#assertOpen();
    this.lease = this.leaseStore.acquire({ resource: this.leaseResource, owner: this.leaseOwner, ttlMs: this.leaseTtlMs, nowMs });
    return this.lease;
  }

  openTarget() {
    this.#assertOpen();
    if (!this.lease) fail('EXECUTION_LEASE_REQUIRED', 'SQLite target execution requires a durable lease before opening the target');
    if (!this.target) this.target = new SqliteTarget({ path: this.targetRef.path, table: this.targetRef.table, requireFencing: true, fenceResource: this.leaseResource });
    return this.target;
  }

  ledgerEntries() {
    this.#assertOpen();
    if (!this.target) fail('SQLITE_TARGET_NOT_OPEN', 'SQLite target must be opened before reading ledger evidence');
    return Object.freeze(this.target.ledgerEntries().filter(entry => entry.migrationId === this.migrationId && entry.targetTable === this.targetRef.table));
  }

  close() {
    if (this.closed) return;
    let firstError = null;
    try { if (this.target) this.target.close(); } catch (error) { firstError = error; }
    try {
      if (this.lease) this.leaseStore.release({ resource: this.lease.resource, owner: this.lease.owner, fencingToken: this.lease.fencingToken });
    } catch (error) { firstError ??= error; }
    try { this.leaseStore.close(); } catch (error) { firstError ??= error; }
    this.closed = true;
    this.target = null;
    this.lease = null;
    if (firstError) throw firstError;
  }
}

class SqliteTargetRuntime {
  constructor({ targetPolicy, leaseTtlMs }) {
    this.descriptor = SQLITE_TARGET_DESCRIPTOR;
    this.targetPolicy = targetPolicy;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
  }

  async normalizePlanInput(input = {}) {
    requirePlanInput(input);
    const normalized = structuredClone(input);
    requireSqliteTargetRef(normalized.targetRef);
    if (normalized.writeStrategy?.mode !== 'insert') fail('UNSUPPORTED_WRITE_STRATEGY', 'Gate B SQLite currently supports insert mode only');
    const batchSize = normalized.writeStrategy?.batchSize;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_WRITE_STRATEGY', 'SQLite batchSize must be between 1 and 10000');
    normalized.targetRef.path = await this.targetPolicy.resolve(normalized.targetRef.path, { mustExist: true });
    return normalized;
  }

  preflight(plan) {
    requirePlanInput(plan);
    requireSqliteTargetRef(plan.targetRef);
    return inspectSqliteTarget({ path: plan.targetRef.path, table: plan.targetRef.table, targetSchema: plan.targetSchema });
  }

  approvalEffects(plan) {
    requirePlanInput(plan);
    return approvalEffects(plan);
  }

  createExecution({ migrationId, targetRef } = {}) {
    return new SqliteTargetExecution({ migrationId, targetRef, leaseTtlMs: this.leaseTtlMs });
  }
}

export async function createSqliteTargetRuntime({ targetRoot, leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (typeof targetRoot !== 'string' || !targetRoot) fail('INVALID_SQLITE_RUNTIME_CONFIG', 'targetRoot is required');
  const targetPolicy = await createPathPolicy(targetRoot);
  return new SqliteTargetRuntime({ targetPolicy, leaseTtlMs: requireLeaseTtlMs(leaseTtlMs) });
}
