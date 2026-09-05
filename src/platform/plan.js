import { canonicalJson, sha256Canonical } from './canonical-json.js';
import { connectorIdentity, validateConnectorRef } from './contracts.js';
import { validateTargetSchema } from '../core/schema.js';
import { compileMapping } from '../core/transforms.js';
import { fail } from '../core/errors.js';

export const PLAN_IDENTITY_ALGORITHM = 'spool-plan-v1';

function requirePlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, message);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

export function validateMigrationPlanInput(input) {
  requirePlainObject(input, 'INVALID_PLAN', 'Migration plan must be a plain object');
  if (!Number.isInteger(input.planRevision) || input.planRevision < 1) fail('INVALID_PLAN_REVISION', 'planRevision must be >= 1');
  validateConnectorRef(input.sourceRef);
  validateConnectorRef(input.targetRef);
  validateTargetSchema(input.targetSchema);
  compileMapping(input.mapping);
  if (!Number.isInteger(input.mappingRevision) || input.mappingRevision < 1) fail('INVALID_MAPPING_REVISION', 'mappingRevision must be >= 1');
  requirePlainObject(input.writeStrategy, 'INVALID_WRITE_STRATEGY', 'writeStrategy must be a plain object');
  requirePlainObject(input.verification, 'INVALID_VERIFICATION_POLICY', 'verification must be a plain object');
  if (!Array.isArray(input.verification.checks) || input.verification.checks.length === 0 || input.verification.checks.some(check => typeof check !== 'string' || !check)) {
    fail('INVALID_VERIFICATION_POLICY', 'verification.checks must contain at least one named check');
  }
  requirePlainObject(input.risk, 'INVALID_RISK_POLICY', 'risk must be a plain object');
  if (!Array.isArray(input.risk.approvals)) fail('INVALID_RISK_POLICY', 'risk.approvals must be an array');
  requirePlainObject(input.capabilityAssumptions, 'INVALID_CAPABILITY_ASSUMPTIONS', 'capabilityAssumptions must be a plain object');
  if (input.createdAt !== undefined && (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt)))) fail('INVALID_CREATED_AT', 'createdAt must be a date-time string');
  if (input.updatedAt !== undefined && (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt)))) fail('INVALID_UPDATED_AT', 'updatedAt must be a date-time string');
  return true;
}

export function buildPlanIdentityRecord(input) {
  validateMigrationPlanInput(input);
  const record = {
    identityAlgorithm: PLAN_IDENTITY_ALGORITHM,
    planRevision: input.planRevision,
    sourceRef: connectorIdentity(input.sourceRef),
    targetRef: connectorIdentity(input.targetRef),
    targetSchema: input.targetSchema,
    mapping: input.mapping,
    mappingRevision: input.mappingRevision,
    writeStrategy: input.writeStrategy,
    verification: input.verification,
    risk: input.risk,
    capabilityAssumptions: input.capabilityAssumptions
  };
  canonicalJson(record);
  return canonicalClone(record);
}

export async function createMigrationPlan(input) {
  const identity = buildPlanIdentityRecord(input);
  const planId = sha256Canonical(PLAN_IDENTITY_ALGORITHM, identity);
  const plan = canonicalClone({
    identityAlgorithm: PLAN_IDENTITY_ALGORITHM,
    planId,
    planRevision: input.planRevision,
    sourceRef: validateConnectorRef(input.sourceRef),
    targetRef: validateConnectorRef(input.targetRef),
    targetSchema: input.targetSchema,
    mapping: input.mapping,
    mappingRevision: input.mappingRevision,
    writeStrategy: input.writeStrategy,
    verification: input.verification,
    risk: input.risk,
    capabilityAssumptions: input.capabilityAssumptions,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
  return deepFreeze(plan);
}

export function validateMigrationPlan(plan) {
  validateMigrationPlanInput(plan);
  if (plan.identityAlgorithm !== PLAN_IDENTITY_ALGORITHM) fail('INVALID_PLAN_IDENTITY_ALGORITHM', `Expected ${PLAN_IDENTITY_ALGORITHM}`);
  if (typeof plan.planId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(plan.planId)) fail('INVALID_PLAN_ID', 'Invalid planId');
  const expected = sha256Canonical(PLAN_IDENTITY_ALGORITHM, buildPlanIdentityRecord(plan));
  if (expected !== plan.planId) fail('PLAN_ID_MISMATCH', 'Plan identity does not match semantic plan contents');
  return true;
}
