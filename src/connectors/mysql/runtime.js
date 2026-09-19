import { randomUUID } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { validateConnectorDescriptor } from '../contract.js';
import { parseMysqlEndpoint } from './connection.js';
import { inspectMysqlTarget } from './preflight.js';
import { MysqlTarget, acquireMysqlLease, releaseMysqlLease } from './target.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export const MYSQL_TARGET_DESCRIPTOR = validateConnectorDescriptor({
  name: 'mysql',
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

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MYSQL_RUNTIME_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MYSQL_RUNTIME_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function requireLeaseTtlMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_MYSQL_RUNTIME_CONFIG', 'leaseTtlMs must be a positive safe integer');
  return value;
}

function requireMigrationId(value) {
  if (!MIGRATION_ID.test(value ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  return value;
}

function requireMysqlTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'MySQL targetRef is required');
  if (targetRef.connector !== 'mysql') fail('UNSUPPORTED_TARGET_CONNECTOR', 'MySQL target runtime requires connector mysql');
  if (targetRef.path != null) fail('INVALID_TARGET_REF', 'MySQL targetRef must not contain a filesystem path');
  parseMysqlEndpoint(targetRef.endpoint);
  requireText(targetRef.database, 'targetRef.database');
  requireText(targetRef.table, 'targetRef.table');
  requireText(targetRef.identity?.user, 'targetRef.identity.user');
  validateSecretRef(targetRef.secretRef);
  return targetRef;
}

function requirePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_MIGRATION_PLAN', 'Plan input must be an object');
  return input;
}

function approvalEffects(plan) {
  const approvals = Array.isArray(plan?.risk?.approvals) ? plan.risk.approvals : [];
  return Object.freeze([
    'mysql:insert_rows',
    'mysql:write_batch_ledger',
    'mysql:manage_internal_metadata',
    ...approvals.map(value => `approval:${value}`)
  ].sort());
}

class MysqlTargetExecution {
  constructor({ migrationId, targetRef, credentialBroker, leaseTtlMs }) {
    this.migrationId = requireMigrationId(migrationId);
    this.targetRef = Object.freeze(structuredClone(requireMysqlTargetRef(targetRef)));
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
    this.leaseResource = `mysql:${this.targetRef.endpoint}:${this.targetRef.database}:${this.targetRef.table}`;
    this.leaseOwner = `migration:${this.migrationId}:${randomUUID()}`;
    this.lease = null;
    this.target = null;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MYSQL_EXECUTION_CLOSED', 'MySQL target execution is closed');
  }

  async renewLease() {
    this.#assertOpen();
    this.lease = await acquireMysqlLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.leaseResource, owner: this.leaseOwner, ttlMs: this.leaseTtlMs });
    return this.lease;
  }

  openTarget() {
    this.#assertOpen();
    if (!this.lease) fail('EXECUTION_LEASE_REQUIRED', 'MySQL target execution requires a durable lease before opening the target');
    if (!this.target) {
      this.target = new MysqlTarget({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, requireFencing: true, fenceResource: this.leaseResource, fenceOwner: this.leaseOwner });
    }
    return this.target;
  }

  async ledgerEntries() {
    this.#assertOpen();
    if (!this.target) fail('MYSQL_TARGET_NOT_OPEN', 'MySQL target must be opened before reading ledger evidence');
    return Object.freeze(await this.target.ledgerEntries({ migrationId: this.migrationId }));
  }

  async close() {
    if (this.closed) return;
    try {
      if (this.target) this.target.close();
    } finally {
      if (this.lease) {
        try {
          await releaseMysqlLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.lease.resource, owner: this.lease.owner, fencingToken: this.lease.fencingToken });
        } catch {
          // Safe failure mode: the durable lease remains until its database-side expiry.
        }
      }
      this.closed = true;
      this.target = null;
      this.lease = null;
    }
  }
}

class MysqlTargetRuntime {
  constructor({ credentialBroker, leaseTtlMs }) {
    if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MYSQL_RUNTIME_CONFIG', 'credentialBroker.withSecret() is required');
    this.descriptor = MYSQL_TARGET_DESCRIPTOR;
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
  }

  async normalizePlanInput(input = {}) {
    requirePlanInput(input);
    const normalized = structuredClone(input);
    const targetRef = requireMysqlTargetRef(normalized.targetRef);
    if (normalized.writeStrategy?.mode !== 'insert') fail('UNSUPPORTED_WRITE_STRATEGY', 'MySQL currently supports insert mode only');
    const batchSize = normalized.writeStrategy?.batchSize;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_WRITE_STRATEGY', 'MySQL batchSize must be between 1 and 10000');

    const endpoint = parseMysqlEndpoint(targetRef.endpoint);
    normalized.targetRef.endpoint = endpoint.endpoint;
    normalized.targetRef.database = requireText(targetRef.database, 'targetRef.database');
    normalized.targetRef.table = requireText(targetRef.table, 'targetRef.table');
    normalized.targetRef.identity = { ...targetRef.identity, user: requireText(targetRef.identity?.user, 'targetRef.identity.user') };
    normalized.targetRef.secretRef = validateSecretRef(targetRef.secretRef);
    normalized.targetRef.resource = `${normalized.targetRef.database}.${normalized.targetRef.table}`;
    return normalized;
  }

  preflight(plan) {
    requirePlanInput(plan);
    requireMysqlTargetRef(plan.targetRef);
    return inspectMysqlTarget({ targetRef: plan.targetRef, targetSchema: plan.targetSchema, credentialBroker: this.credentialBroker });
  }

  approvalEffects(plan) {
    requirePlanInput(plan);
    return approvalEffects(plan);
  }

  createExecution({ migrationId, targetRef } = {}) {
    return new MysqlTargetExecution({ migrationId, targetRef, credentialBroker: this.credentialBroker, leaseTtlMs: this.leaseTtlMs });
  }

  async close() {
    // No persistent connections at runtime level; executions manage their own connections
  }
}

export function createMysqlTargetRuntime({ credentialBroker, leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  return new MysqlTargetRuntime({ credentialBroker, leaseTtlMs: requireLeaseTtlMs(leaseTtlMs) });
}
