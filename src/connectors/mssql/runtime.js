import { randomUUID } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { validateConnectorDescriptor } from '../contract.js';
import { parseMssqlEndpoint } from './connection.js';
import { inspectMssqlTarget } from './preflight.js';
import { MssqlTarget, acquireMssqlLease, releaseMssqlLease } from './target.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export const MSSQL_TARGET_DESCRIPTOR = validateConnectorDescriptor({
  name: 'mssql',
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
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MSSQL_RUNTIME_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MSSQL_RUNTIME_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function requireLeaseTtlMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_MSSQL_RUNTIME_CONFIG', 'leaseTtlMs must be a positive safe integer');
  return value;
}

function requireMigrationId(value) {
  if (!MIGRATION_ID.test(value ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  return value;
}

function requireMssqlTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'SQL Server targetRef is required');
  if (targetRef.connector !== 'mssql') fail('UNSUPPORTED_TARGET_CONNECTOR', 'SQL Server target runtime requires connector mssql');
  if (targetRef.path != null) fail('INVALID_TARGET_REF', 'SQL Server targetRef must not contain a filesystem path');
  parseMssqlEndpoint(targetRef.endpoint);
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
    'mssql:insert_rows',
    'mssql:write_batch_ledger',
    'mssql:manage_internal_metadata',
    ...approvals.map(value => `approval:${value}`)
  ].sort());
}

class MssqlTargetExecution {
  constructor({ migrationId, targetRef, credentialBroker, leaseTtlMs }) {
    this.migrationId = requireMigrationId(migrationId);
    this.targetRef = Object.freeze(structuredClone(requireMssqlTargetRef(targetRef)));
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
    this.leaseResource = `mssql:${this.targetRef.endpoint}:${this.targetRef.database}:${this.targetRef.table}`;
    this.leaseOwner = `migration:${this.migrationId}:${randomUUID()}`;
    this.lease = null;
    this.target = null;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('MSSQL_EXECUTION_CLOSED', 'SQL Server target execution is closed');
  }

  async renewLease() {
    this.#assertOpen();
    this.lease = await acquireMssqlLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.leaseResource, owner: this.leaseOwner, ttlMs: this.leaseTtlMs });
    return this.lease;
  }

  openTarget() {
    this.#assertOpen();
    if (!this.lease) fail('EXECUTION_LEASE_REQUIRED', 'SQL Server target execution requires a durable lease before opening the target');
    if (!this.target) {
      this.target = new MssqlTarget({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, requireFencing: true, fenceResource: this.leaseResource, fenceOwner: this.leaseOwner });
    }
    return this.target;
  }

  async ledgerEntries() {
    this.#assertOpen();
    if (!this.target) fail('MSSQL_TARGET_NOT_OPEN', 'SQL Server target must be opened before reading ledger evidence');
    return Object.freeze(await this.target.ledgerEntries({ migrationId: this.migrationId }));
  }

  async close() {
    if (this.closed) return;
    try {
      if (this.target) this.target.close();
    } finally {
      if (this.lease) {
        try {
          await releaseMssqlLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.lease.resource, owner: this.lease.owner, fencingToken: this.lease.fencingToken });
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

class MssqlTargetRuntime {
  constructor({ credentialBroker, leaseTtlMs }) {
    if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MSSQL_RUNTIME_CONFIG', 'credentialBroker.withSecret() is required');
    this.descriptor = MSSQL_TARGET_DESCRIPTOR;
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
  }

  async normalizePlanInput(input = {}) {
    requirePlanInput(input);
    const normalized = structuredClone(input);
    const targetRef = requireMssqlTargetRef(normalized.targetRef);
    if (normalized.writeStrategy?.mode !== 'insert') fail('UNSUPPORTED_WRITE_STRATEGY', 'SQL Server currently supports insert mode only');
    const batchSize = normalized.writeStrategy?.batchSize;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_WRITE_STRATEGY', 'SQL Server batchSize must be between 1 and 10000');
    const endpoint = parseMssqlEndpoint(targetRef.endpoint);
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
    requireMssqlTargetRef(plan.targetRef);
    return inspectMssqlTarget({ targetRef: plan.targetRef, targetSchema: plan.targetSchema, credentialBroker: this.credentialBroker });
  }

  approvalEffects(plan) {
    requirePlanInput(plan);
    return approvalEffects(plan);
  }

  createExecution({ migrationId, targetRef } = {}) {
    return new MssqlTargetExecution({ migrationId, targetRef, credentialBroker: this.credentialBroker, leaseTtlMs: this.leaseTtlMs });
  }

  async close() {
    // No persistent connections at runtime level; executions manage their own connections
  }
}

export function createMssqlTargetRuntime({ credentialBroker, leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  return new MssqlTargetRuntime({ credentialBroker, leaseTtlMs: requireLeaseTtlMs(leaseTtlMs) });
}
