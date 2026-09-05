import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_CAPABILITY_PROFILE_VERSION,
  validateCapabilityProfile,
  normalizeCapabilityProfile,
  validateConnector
} from '../src/connectors/contract.js';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';

const LEGACY_CAPABILITIES = Object.freeze({
  source: true,
  target: true,
  discover: true,
  streaming: true,
  transactions: false,
  bulkWrite: false,
  upsert: false,
  ddl: false,
  rollback: false,
  checksum: true,
  pagination: true,
  rateLimitAware: false
});

function profile(overrides = {}) {
  return {
    version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
    source: {
      snapshot: 'none',
      ordering: 'none',
      resume: 'unsupported',
      cursorKind: null,
      ...overrides.source
    },
    target: {
      atomicity: 'none',
      commitEvidence: 'none',
      reconcileAfterCrash: false,
      idempotency: 'none',
      ...overrides.target
    },
    verification: {
      logicalCount: false,
      schema: false,
      keyCoverage: false,
      sampleHash: false,
      logicalDatasetHash: false,
      physicalArtifactHash: false,
      maxStrength: 'BASIC',
      ...overrides.verification
    }
  };
}

test('explicit capability profile is versioned, validated and detached from caller mutation', () => {
  const input = profile({
    source: { snapshot: 'fingerprint_checked', ordering: 'stable_total_order', resume: 'cursor_checked', cursorKind: 'offset' },
    verification: { logicalCount: true, physicalArtifactHash: true, maxStrength: 'STANDARD' }
  });
  const validated = validateCapabilityProfile(input);
  assert.equal(validated.version, 'spool-connector-capabilities-v1');
  input.source.snapshot = 'none';
  assert.equal(validated.source.snapshot, 'fingerprint_checked');
});

test('invalid capability combinations fail closed', () => {
  assert.throws(
    () => validateCapabilityProfile(profile({ source: { ordering: 'none', resume: 'cursor_checked', cursorKind: 'offset' } })),
    /resume|ordering/i
  );
  assert.throws(
    () => validateCapabilityProfile(profile({ target: { reconcileAfterCrash: true, commitEvidence: 'none' } })),
    /reconcile|commit/i
  );
  assert.throws(
    () => validateCapabilityProfile(profile({ verification: { maxStrength: 'STRONG', logicalDatasetHash: false } })),
    /strong|logical/i
  );
});

test('legacy boolean manifest maps to conservative non-resumable capability profile', () => {
  const normalized = normalizeCapabilityProfile({ capabilities: { ...LEGACY_CAPABILITIES } });
  assert.equal(normalized.version, CONNECTOR_CAPABILITY_PROFILE_VERSION);
  assert.equal(normalized.source.snapshot, 'none');
  assert.equal(normalized.source.resume, 'unsupported');
  assert.equal(normalized.target.reconcileAfterCrash, false);
  assert.equal(normalized.verification.maxStrength, 'BASIC');
});

test('connector validation returns the normalized profile alongside legacy booleans', () => {
  const connector = {
    manifest() { return { name: 'fixture', version: '1.0.0', capabilities: { ...LEGACY_CAPABILITIES }, capabilityProfile: profile() }; },
    async validateConfig(config) { return config; },
    async testConnection() { return { ok: true }; },
    async discover() { return {}; },
    async *read() {},
    async planWrite() { return {}; },
    async write() { return {}; },
    async verify() { return { ok: true }; },
    async close() {}
  };
  const manifest = validateConnector(connector);
  assert.equal(manifest.capabilityProfile.version, CONNECTOR_CAPABILITY_PROFILE_VERSION);
});

test('filesystem and sqlite advertise conservative truthful P1 profiles', () => {
  const filesystem = validateConnector(new FilesystemConnector({ root: '/tmp' })).capabilityProfile;
  assert.equal(filesystem.source.snapshot, 'none');
  assert.equal(filesystem.source.resume, 'unsupported');
  assert.equal(filesystem.target.atomicity, 'resource_replace');
  assert.equal(filesystem.target.reconcileAfterCrash, false);
  assert.equal(filesystem.verification.physicalArtifactHash, true);
  assert.notEqual(filesystem.verification.maxStrength, 'STRONG');

  const sqlite = validateConnector(new SQLiteConnector({ database: '/tmp/spool-capability-test.sqlite' })).capabilityProfile;
  assert.equal(sqlite.source.snapshot, 'none');
  assert.equal(sqlite.source.resume, 'unsupported');
  assert.equal(sqlite.target.atomicity, 'transaction');
  assert.equal(sqlite.target.reconcileAfterCrash, false);
  assert.notEqual(sqlite.verification.maxStrength, 'STRONG');
});
