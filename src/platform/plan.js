import { canonicalJson, sha256Json } from './canonical-json.js';
import { validateConnectorRef } from './contracts.js';
import { validateTargetSchema } from '../core/schema.js';
import { compileMapping } from '../core/transforms.js';
import { fail } from '../core/errors.js';
import { normalizeCapabilityProfile } from '../connectors/contract.js';

export const PLAN_IDENTITY_VERSION = 'spool-plan-v1';
export const PLAN_CONNECTOR_BINDING_VERSION = 'spool-plan-connector-binding-v1';

const VERIFICATION_STRENGTHS = Object.freeze(['BASIC', 'STANDARD', 'STRONG']);
const VERIFICATION_STRENGTH_RANK = Object.freeze({ BASIC: 0, STANDARD: 1, STRONG: 2 });
const RESUMABLE_SOURCE_MODES = Object.freeze(['cursor_checked', 'snapshot_cursor']);

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

function validateConnectorManifestIdentity(manifest, role) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_CONNECTOR_MANIFEST', `${role} connector manifest must be an object`);
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(manifest.name ?? '')) {
    fail('INVALID_CONNECTOR_MANIFEST', `${role} connector manifest name is invalid`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail('INVALID_CONNECTOR_MANIFEST', `${role} connector manifest version must be semver-like`);
  }
  if (!manifest.capabilities || manifest.capabilities[role] !== true) {
    fail('CONNECTOR_ROLE_UNSUPPORTED', `${manifest.name} does not advertise ${role} capability`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    capabilityProfile: normalizeCapabilityProfile(manifest)
  };
}

function normalizeRequirements(requirements = {}) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    fail('INVALID_PLAN_REQUIREMENTS', 'Plan connector requirements must be an object');
  }
  const unknown = Object.keys(requirements).filter(key => !['restartResume', 'verificationStrength'].includes(key));
  if (unknown.length) fail('INVALID_PLAN_REQUIREMENTS', `Unknown plan connector requirements: ${unknown.join(', ')}`);

  const restartResume = requirements.restartResume ?? false;
  const verificationStrength = requirements.verificationStrength ?? 'BASIC';
  if (typeof restartResume !== 'boolean') fail('INVALID_PLAN_REQUIREMENTS', 'restartResume requirement must be boolean');
  if (!VERIFICATION_STRENGTHS.includes(verificationStrength)) {
    fail('INVALID_PLAN_REQUIREMENTS', 'verificationStrength must be BASIC, STANDARD, or STRONG');
  }
  return { restartResume, verificationStrength };
}

function assertVerificationStrength(role, profile, requiredStrength) {
  if (VERIFICATION_STRENGTH_RANK[profile.verification.maxStrength] < VERIFICATION_STRENGTH_RANK[requiredStrength]) {
    fail(
      'CONNECTOR_VERIFICATION_CAPABILITY_INSUFFICIENT',
      `${role} connector verification capability ${profile.verification.maxStrength} cannot satisfy ${requiredStrength}`
    );
  }
}

function assertRestartResumeCapabilities(sourceProfile, targetProfile) {
  if (!RESUMABLE_SOURCE_MODES.includes(sourceProfile.source.resume) || sourceProfile.source.snapshot === 'none') {
    fail('CONNECTOR_RESUME_CAPABILITY_INSUFFICIENT', 'Restart-resume requires a snapshot-checked cursor source capability');
  }
  if (!targetProfile.target.reconcileAfterCrash || targetProfile.target.commitEvidence === 'none' || targetProfile.target.idempotency === 'none') {
    fail('CONNECTOR_RECONCILIATION_CAPABILITY_INSUFFICIENT', 'Restart-resume requires target crash reconciliation, commit evidence, and replay-safe idempotency');
  }
}

function buildConnectorBinding(sourceManifest, targetManifest, requirements = {}) {
  const source = validateConnectorManifestIdentity(sourceManifest, 'source');
  const target = validateConnectorManifestIdentity(targetManifest, 'target');
  const normalizedRequirements = normalizeRequirements(requirements);

  assertVerificationStrength('source', source.capabilityProfile, normalizedRequirements.verificationStrength);
  assertVerificationStrength('target', target.capabilityProfile, normalizedRequirements.verificationStrength);
  if (normalizedRequirements.restartResume) {
    assertRestartResumeCapabilities(source.capabilityProfile, target.capabilityProfile);
  }

  return deepFreeze({
    version: PLAN_CONNECTOR_BINDING_VERSION,
    source,
    target,
    requirements: normalizedRequirements
  });
}

function validateConnectorBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    fail('INVALID_PLAN_CONNECTOR_BINDING', 'connectorBinding must be an object');
  }
  if (binding.version !== PLAN_CONNECTOR_BINDING_VERSION) {
    fail('UNSUPPORTED_PLAN_CONNECTOR_BINDING', `Unsupported connector binding version ${binding.version}`);
  }
  const expected = buildConnectorBinding(
    {
      name: binding.source?.name,
      version: binding.source?.version,
      capabilities: { source: true },
      capabilityProfile: binding.source?.capabilityProfile
    },
    {
      name: binding.target?.name,
      version: binding.target?.version,
      capabilities: { target: true },
      capabilityProfile: binding.target?.capabilityProfile
    },
    binding.requirements
  );
  if (canonicalJson(expected) !== canonicalJson(binding)) {
    fail('INVALID_PLAN_CONNECTOR_BINDING', 'connectorBinding is not in canonical validated form');
  }
  return true;
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
  if (plan.connectorBinding !== undefined) {
    validateConnectorBinding(plan.connectorBinding);
    if (plan.sourceRef.connector !== plan.connectorBinding.source.name) {
      fail('PLAN_CONNECTOR_MISMATCH', 'sourceRef connector does not match bound source connector');
    }
    if (plan.targetRef.connector !== plan.connectorBinding.target.name) {
      fail('PLAN_CONNECTOR_MISMATCH', 'targetRef connector does not match bound target connector');
    }
  }
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

export async function createCapabilityBoundMigrationPlan(input, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('INVALID_PLAN_CONNECTOR_OPTIONS', 'Capability-bound plan options must be an object');
  }
  const { sourceManifest, targetManifest, requirements = {} } = options;
  const connectorBinding = buildConnectorBinding(sourceManifest, targetManifest, requirements);

  if (input?.sourceRef?.connector !== connectorBinding.source.name) {
    fail('PLAN_CONNECTOR_MISMATCH', 'sourceRef connector does not match selected source connector');
  }
  if (input?.targetRef?.connector !== connectorBinding.target.name) {
    fail('PLAN_CONNECTOR_MISMATCH', 'targetRef connector does not match selected target connector');
  }

  return createMigrationPlan({
    ...input,
    connectorBinding
  });
}

export function assertPlanConnectorCompatibility(plan, options = {}) {
  if (!plan?.connectorBinding) {
    fail('PLAN_CONNECTOR_BINDING_REQUIRED', 'Plan does not contain a connector capability binding');
  }
  validateMigrationPlan(plan);
  const current = buildConnectorBinding(
    options.sourceManifest,
    options.targetManifest,
    plan.connectorBinding.requirements
  );
  if (canonicalJson(current.source) !== canonicalJson(plan.connectorBinding.source)) {
    fail('SOURCE_CONNECTOR_CAPABILITY_DRIFT', 'Source connector version or capability profile drifted from the approved plan');
  }
  if (canonicalJson(current.target) !== canonicalJson(plan.connectorBinding.target)) {
    fail('TARGET_CONNECTOR_CAPABILITY_DRIFT', 'Target connector version or capability profile drifted from the approved plan');
  }
  return true;
}
