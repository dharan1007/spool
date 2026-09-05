import { canonicalJson, sha256Json } from './canonical-json.js';
import { validateConnectorRef } from './contracts.js';
import { validateTargetSchema } from '../core/schema.js';
import { compileMapping } from '../core/transforms.js';
import { fail } from '../core/errors.js';

export const PLAN_IDENTITY_VERSION = 'spool-plan-v1';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateWriteStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) {
    fail('INVALID_WRITE_STRATEGY', 'writeStrategy must be an object');
  }
  if (typeof strategy.mode !== 'string' || !strategy.mode) {
    fail('INVALID_WRITE_STRATEGY', 'writeStrategy.mode is required');
  }
  if (strategy.batchSize !== undefined && (!Number.isInteger(strategy.batchSize) || strategy.batchSize < 1 || strategy.batchSize > 100_000)) {
    fail('INVALID_WRITE_STRATEGY', 'writeStrategy.batchSize must be an integer between 1 and 100000');
  }
}

function validateRisk(risk) {
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) fail('INVALID_RISK', 'risk must be an object');
  if (!['low', 'medium', 'high'].includes(risk.level)) fail('INVALID_RISK', 'risk.level must be low, medium, or high');
  if (!Array.isArray(risk.approvals)) fail('INVALID_RISK', 'risk.approvals must be an array');
}

export function validateMigrationPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('INVALID_PLAN', 'Migration plan must be an object');
  if (plan.identityVersion !== undefined && plan.identityVersion !== PLAN_IDENTITY_VERSION) {
    fail('UNSUPPORTED_PLAN_IDENTITY_VERSION', `Unsupported plan identity version ${plan.identityVersion}`);
  }
  validateConnectorRef(plan.sourceRef);
  validateConnectorRef(plan.targetRef);
  validateTargetSchema(plan.targetSchema);
  compileMapping(plan.mapping);
  if (!Number.isInteger(plan.planRevision) || plan.planRevision < 1) {
    fail('INVALID_PLAN_REVISION', 'planRevision must be >= 1');
  }
  validateWriteStrategy(plan.writeStrategy);
  if (!Array.isArray(plan.verification?.checks) || plan.verification.checks.length === 0) {
    fail('INVALID_VERIFICATION_POLICY', 'At least one verification check is required');
  }
  if (plan.verification.checks.some(check => typeof check !== 'string' || !check)) {
    fail('INVALID_VERIFICATION_POLICY', 'Verification checks must be non-empty strings');
  }
  validateRisk(plan.risk);
  return true;
}

export async function createMigrationPlan(input) {
  canonicalJson(input);
  const identity = structuredClone(input);
  delete identity.createdAt;
  delete identity.planId;
  identity.identityVersion = PLAN_IDENTITY_VERSION;
  validateMigrationPlan(identity);

  const planId = await sha256Json({
    domain: PLAN_IDENTITY_VERSION,
    plan: identity
  });

  return deepFreeze({
    ...identity,
    planId,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
