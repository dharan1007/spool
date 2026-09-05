import { fail } from '../core/errors.js';

export const CONNECTOR_CAPABILITIES = Object.freeze([
  'source', 'target', 'discover', 'streaming', 'transactions', 'bulkWrite',
  'upsert', 'ddl', 'rollback', 'checksum', 'pagination', 'rateLimitAware'
]);

export const CONNECTOR_CAPABILITY_PROFILE_VERSION = 'spool-connector-capabilities-v1';

const SOURCE_SNAPSHOT_MODES = Object.freeze(['none', 'fingerprint_checked', 'transactional_snapshot']);
const SOURCE_ORDERING_MODES = Object.freeze(['none', 'stable_key', 'stable_total_order']);
const SOURCE_RESUME_MODES = Object.freeze(['unsupported', 'restart_only', 'cursor_checked', 'snapshot_cursor']);
const CURSOR_KINDS = Object.freeze(['offset', 'keyset', 'opaque']);
const TARGET_ATOMICITY_MODES = Object.freeze(['none', 'resource_replace', 'transaction']);
const TARGET_COMMIT_EVIDENCE_MODES = Object.freeze(['none', 'postcondition', 'content_identity', 'native_commit_id']);
const TARGET_IDEMPOTENCY_MODES = Object.freeze(['none', 'batch_key', 'upsert_key', 'resource_replace']);
const VERIFICATION_STRENGTHS = Object.freeze(['BASIC', 'STANDARD', 'STRONG']);

const REQUIRED_METHODS = Object.freeze([
  'manifest', 'validateConfig', 'testConnection', 'discover', 'read',
  'planWrite', 'write', 'verify', 'close'
]);

function ensurePlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
}

function rejectUnknownKeys(value, allowed, code, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(code, `Unknown ${label} fields: ${unknown.join(', ')}`);
}

function cloneAndFreeze(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return current;
    for (const child of Object.values(current)) freeze(child);
    return Object.freeze(current);
  };
  return freeze(clone);
}

export function validateCapabilityProfile(profile) {
  ensurePlainObject(profile, 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Connector capability profile must be an object');
  rejectUnknownKeys(profile, ['version', 'source', 'target', 'verification'], 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'capability profile');
  if (profile.version !== CONNECTOR_CAPABILITY_PROFILE_VERSION) {
    fail('UNSUPPORTED_CONNECTOR_CAPABILITY_PROFILE', `Unsupported connector capability profile ${profile.version}`);
  }

  ensurePlainObject(profile.source, 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Connector source capability profile must be an object');
  rejectUnknownKeys(profile.source, ['snapshot', 'ordering', 'resume', 'cursorKind'], 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'source capability');
  if (!SOURCE_SNAPSHOT_MODES.includes(profile.source.snapshot)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid source snapshot capability');
  if (!SOURCE_ORDERING_MODES.includes(profile.source.ordering)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid source ordering capability');
  if (!SOURCE_RESUME_MODES.includes(profile.source.resume)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid source resume capability');
  if (profile.source.cursorKind !== null && !CURSOR_KINDS.includes(profile.source.cursorKind)) {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid source cursorKind capability');
  }
  if (profile.source.resume !== 'unsupported' && profile.source.ordering === 'none') {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Restart/resume capability requires deterministic source ordering');
  }
  if (['cursor_checked', 'snapshot_cursor'].includes(profile.source.resume) && profile.source.cursorKind === null) {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Cursor-based resume capability requires cursorKind');
  }
  if (profile.source.resume === 'snapshot_cursor' && profile.source.snapshot === 'none') {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'snapshot_cursor resume requires a source snapshot guarantee');
  }

  ensurePlainObject(profile.target, 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Connector target capability profile must be an object');
  rejectUnknownKeys(profile.target, ['atomicity', 'commitEvidence', 'reconcileAfterCrash', 'idempotency'], 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'target capability');
  if (!TARGET_ATOMICITY_MODES.includes(profile.target.atomicity)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid target atomicity capability');
  if (!TARGET_COMMIT_EVIDENCE_MODES.includes(profile.target.commitEvidence)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid target commitEvidence capability');
  if (typeof profile.target.reconcileAfterCrash !== 'boolean') fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Target reconcileAfterCrash capability must be boolean');
  if (!TARGET_IDEMPOTENCY_MODES.includes(profile.target.idempotency)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid target idempotency capability');
  if (profile.target.reconcileAfterCrash && profile.target.commitEvidence === 'none') {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Crash reconciliation requires target commit evidence');
  }
  if (profile.target.reconcileAfterCrash && profile.target.idempotency === 'none') {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Crash reconciliation requires a replay-safe target idempotency contract');
  }

  ensurePlainObject(profile.verification, 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Connector verification capability profile must be an object');
  rejectUnknownKeys(profile.verification, ['logicalCount', 'schema', 'keyCoverage', 'sampleHash', 'logicalDatasetHash', 'physicalArtifactHash', 'maxStrength'], 'INVALID_CONNECTOR_CAPABILITY_PROFILE', 'verification capability');
  for (const key of ['logicalCount', 'schema', 'keyCoverage', 'sampleHash', 'logicalDatasetHash', 'physicalArtifactHash']) {
    if (typeof profile.verification[key] !== 'boolean') fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', `Verification capability ${key} must be boolean`);
  }
  if (!VERIFICATION_STRENGTHS.includes(profile.verification.maxStrength)) fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'Invalid verification maxStrength capability');
  if (profile.verification.maxStrength === 'STRONG' && !profile.verification.logicalDatasetHash) {
    fail('INVALID_CONNECTOR_CAPABILITY_PROFILE', 'STRONG verification requires comparable logical dataset hashing');
  }

  return cloneAndFreeze(profile);
}

function conservativeLegacyProfile(capabilities) {
  return {
    version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
    source: {
      snapshot: 'none',
      ordering: 'none',
      resume: 'unsupported',
      cursorKind: null
    },
    target: {
      atomicity: capabilities?.transactions ? 'transaction' : 'none',
      commitEvidence: 'none',
      reconcileAfterCrash: false,
      idempotency: 'none'
    },
    verification: {
      logicalCount: false,
      schema: false,
      keyCoverage: false,
      sampleHash: false,
      logicalDatasetHash: false,
      physicalArtifactHash: false,
      maxStrength: 'BASIC'
    }
  };
}

export function normalizeCapabilityProfile(manifest) {
  ensurePlainObject(manifest, 'INVALID_CONNECTOR_MANIFEST', 'Connector manifest must be an object');
  const profile = manifest.capabilityProfile ?? conservativeLegacyProfile(manifest.capabilities);
  return validateCapabilityProfile(profile);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest must be an object');
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(manifest.name ?? '')) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest name is invalid');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest version must be semver-like');
  }
  if (!manifest.capabilities || typeof manifest.capabilities !== 'object' || Array.isArray(manifest.capabilities)) {
    fail('INVALID_CONNECTOR_CAPABILITIES', 'Connector capabilities must be an object');
  }
  for (const capability of CONNECTOR_CAPABILITIES) {
    if (typeof manifest.capabilities[capability] !== 'boolean') {
      fail('INVALID_CONNECTOR_CAPABILITIES', `Connector capability ${capability} must be declared as boolean`);
    }
  }
  const unknown = Object.keys(manifest.capabilities).filter(key => !CONNECTOR_CAPABILITIES.includes(key));
  if (unknown.length) fail('INVALID_CONNECTOR_CAPABILITIES', `Unknown connector capabilities: ${unknown.join(', ')}`);
  const normalized = structuredClone(manifest);
  normalized.capabilityProfile = normalizeCapabilityProfile(manifest);
  return normalized;
}

export function validateConnector(connector) {
  if (!connector || (typeof connector !== 'object' && typeof connector !== 'function')) {
    fail('INVALID_CONNECTOR', 'Connector must be an object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof connector[method] !== 'function') fail('INVALID_CONNECTOR', `Connector method ${method} is required`);
  }
  const manifest = validateManifest(connector.manifest());
  if (manifest.capabilities.rollback && typeof connector.rollback !== 'function') {
    fail('INVALID_CONNECTOR', 'Connector advertises rollback but does not implement rollback()');
  }
  return manifest;
}

export function assertAsyncIterable(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    fail('INVALID_CONNECTOR_STREAM', 'Connector read() must return an AsyncIterable');
  }
  return stream;
}
