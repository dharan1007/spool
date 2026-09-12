import { randomUUID } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { validateConnectorDescriptor } from '../contract.js';
import { parsePostgresEndpoint } from './connection.js';
import { inspectPostgresTarget } from './preflight.js';
import { PostgresTarget, acquirePostgresLease, releasePostgresLease } from './target.js';

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export const POSTGRES_TARGET_DESCRIPTOR = validateConnectorDescriptor({
  name: 'postgres',
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
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_RUNTIME_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_RUNTIME_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function requireLeaseTtlMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_POSTGRES_RUNTIME_CONFIG', 'leaseTtlMs must be a positive safe integer');
  return value;
}

function requireMigrationId(value) {
  if (!MIGRATION_ID.test(value ?? '')) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  return value;
}

function requirePostgresTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'PostgreSQL targetRef is required');
  if (targetRef.connector !== 'postgres') fail('UNSUPPORTED_TARGET_CONNECTOR', 'PostgreSQL target runtime requires connector postgres');
  if (targetRef.path != null) fail('INVALID_TARGET_REF', 'PostgreSQL targetRef must not contain a filesystem path');
  parsePostgresEndpoint(targetRef.endpoint);
  requireText(targetRef.database, 'targetRef.database');
  requireText(targetRef.schema, 'targetRef.schema');
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
    'postgres:insert_rows',
    'postgres:write_batch_ledger',
    'postgres:manage_internal_metadata',
    ...approvals.map(value => `approval:${value}`)
  ].sort());
}

class PostgresTargetExecution {
  constructor({ migrationId, targetRef, credentialBroker, leaseTtlMs }) {
    this.migrationId = requireMigrationId(migrationId);
    this.targetRef = Object.freeze(structuredClone(requirePostgresTargetRef(targetRef)));
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
    this.leaseResource = `postgres:${this.targetRef.endpoint}:${this.targetRef.database}:${this.targetRef.schema}.${this.targetRef.table}`;
    this.leaseOwner = `migration:${this.migrationId}:${randomUUID()}`;
    this.lease = null;
    this.target = null;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) fail('POSTGRES_EXECUTION_CLOSED', 'PostgreSQL target execution is closed');
  }

  async renewLease() {
    this.#assertOpen();
    this.lease = await acquirePostgresLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.leaseResource, owner: this.leaseOwner, ttlMs: this.leaseTtlMs });
    return this.lease;
  }

  openTarget() {
    this.#assertOpen();
    if (!this.lease) fail('EXECUTION_LEASE_REQUIRED', 'PostgreSQL target execution requires a durable lease before opening the target');
    if (!this.target) {
      this.target = new PostgresTarget({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, requireFencing: true, fenceResource: this.leaseResource, fenceOwner: this.leaseOwner });
    }
    return this.target;
  }

  async ledgerEntries() {
    this.#assertOpen();
    if (!this.target) fail('POSTGRES_TARGET_NOT_OPEN', 'PostgreSQL target must be opened before reading ledger evidence');
    return Object.freeze(await this.target.ledgerEntries({ migrationId: this.migrationId }));
  }

  async close() {
    if (this.closed) return;
    try {
      if (this.target) this.target.close();
    } finally {
      if (this.lease) {
        try {
          await releasePostgresLease({ targetRef: this.targetRef, credentialBroker: this.credentialBroker, resource: this.lease.resource, owner: this.lease.owner, fencingToken: this.lease.fencingToken });
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

class PostgresTargetRuntime {
  constructor({ credentialBroker, leaseTtlMs }) {
    if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_RUNTIME_CONFIG', 'credentialBroker.withSecret() is required');
    this.descriptor = POSTGRES_TARGET_DESCRIPTOR;
    this.credentialBroker = credentialBroker;
    this.leaseTtlMs = requireLeaseTtlMs(leaseTtlMs);
  }

  async normalizePlanInput(input = {}) {
    requirePlanInput(input);
    const normalized = structuredClone(input);
    const targetRef = requirePostgresTargetRef(normalized.targetRef);
    if (normalized.writeStrategy?.mode !== 'insert') fail('UNSUPPORTED_WRITE_STRATEGY', 'Gate C PostgreSQL currently supports insert mode only');
    const batchSize = normalized.writeStrategy?.batchSize;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_WRITE_STRATEGY', 'PostgreSQL batchSize must be between 1 and 10000');

    const endpoint = parsePostgresEndpoint(targetRef.endpoint);
    normalized.targetRef.endpoint = endpoint.endpoint;
    normalized.targetRef.database = requireText(targetRef.database, 'targetRef.database');
    normalized.targetRef.schema = requireText(targetRef.schema, 'targetRef.schema');
    normalized.targetRef.table = requireText(targetRef.table, 'targetRef.table');
    normalized.targetRef.identity = { ...targetRef.identity, user: requireText(targetRef.identity?.user, 'targetRef.identity.user') };
    normalized.targetRef.secretRef = validateSecretRef(targetRef.secretRef);
    normalized.targetRef.resource = `${normalized.targetRef.schema}.${normalized.targetRef.table}`;
    return normalized;
  }

  preflight(plan) {
    requirePlanInput(plan);
    requirePostgresTargetRef(plan.targetRef);
    return inspectPostgresTarget({ targetRef: plan.targetRef, targetSchema: plan.targetSchema, credentialBroker: this.credentialBroker });
  }

  approvalEffects(plan) {
    requirePlanInput(plan);
    return approvalEffects(plan);
  }

  createExecution({ migrationId, targetRef } = {}) {
    return new PostgresTargetExecution({ migrationId, targetRef, credentialBroker: this.credentialBroker, leaseTtlMs: this.leaseTtlMs });
  }
}

export function createPostgresTargetRuntime({ credentialBroker, leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  return new PostgresTargetRuntime({ credentialBroker, leaseTtlMs: requireLeaseTtlMs(leaseTtlMs) });
}
