import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/daemon/run-store.js';
import { verificationSemanticId, verificationStatus, assertVerificationIdentity } from '../src/protocol/verification-coordinator.js';

const hash = char => `sha256:${Number(String(char).charCodeAt(0)).toString(16).padStart(64, '0')}`;

function baseRecord() {
  return {
    schemaVersion: 1,
    migrationId: 'mig-identity',
    mode: 'FINAL_PRE_CUTOVER',
    planId: hash('p'),
    mappingRevision: 1,
    sourceStateId: hash('s'),
    targetContractId: hash('t'),
    cutoverAttemptId: hash('a'),
    sourceBoundary: { snapshotId: hash('s') },
    targetBoundary: { contractId: hash('t') },
    cdc: null,
    counts: { sourceRows: 10, validRows: 10, invalidRows: 0 },
    contentRoot: hash('r'),
    levels: { required: ['ROW_COUNT'], completed: ['ROW_COUNT'] },
    invariants: null,
    release: { version: '9.9.9-test', commitSha: '1'.repeat(40) }
  };
}

function storedRecord(overrides = {}) {
  const semantic = { ...baseRecord(), ...overrides };
  const verificationId = verificationSemanticId(semantic);
  return {
    ...semantic,
    verificationId,
    fenceToken: 7,
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: '2026-09-13T01:00:00.000Z',
    contentProof: null,
    status: 'VERIFIED'
  };
}

test('same semantic evidence always yields the same verification identity', () => {
  const first = verificationSemanticId(baseRecord());
  const second = verificationSemanticId(structuredClone(baseRecord()));
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test('single-bit semantic change yields a different identity', () => {
  const base = verificationSemanticId(baseRecord());
  // Changed count
  assert.notEqual(verificationSemanticId({ ...baseRecord(), counts: { sourceRows: 10, validRows: 9, invalidRows: 1 } }), base);
  // Changed content root
  assert.notEqual(verificationSemanticId({ ...baseRecord(), contentRoot: hash('q') }), base);
  // Changed CDC position
  assert.notEqual(verificationSemanticId({ ...baseRecord(), cdc: { snapshotCdcBoundaryId: hash('b'), expectedPosition: '0/200', observedPosition: '0/200' } }), base);
  // Changed mode
  assert.notEqual(verificationSemanticId({ ...baseRecord(), mode: 'POST_CUTOVER' }), base);
  // Changed attempt
  assert.notEqual(verificationSemanticId({ ...baseRecord(), cutoverAttemptId: hash('z') }), base);
  // Added invariant
  assert.notEqual(verificationSemanticId({ ...baseRecord(), invariants: [{ code: 'X', message: 'y' }] }), base);
});

test('field reordering preserves identity where semantically identical', () => {
  const reordered = {
    release: { commitSha: '1'.repeat(40), version: '9.9.9-test' },
    invariants: null,
    levels: { completed: ['ROW_COUNT'], required: ['ROW_COUNT'] },
    contentRoot: hash('r'),
    counts: { invalidRows: 0, validRows: 10, sourceRows: 10 },
    cdc: null,
    targetBoundary: { contractId: hash('t') },
    sourceBoundary: { snapshotId: hash('s') },
    cutoverAttemptId: hash('a'),
    targetContractId: hash('t'),
    sourceStateId: hash('s'),
    mappingRevision: 1,
    planId: hash('p'),
    mode: 'FINAL_PRE_CUTOVER',
    migrationId: 'mig-identity',
    schemaVersion: 1
  };
  assert.equal(verificationSemanticId(reordered), verificationSemanticId(baseRecord()));
});

test('removed field changes identity', () => {
  const withoutRoot = structuredClone(baseRecord());
  delete withoutRoot.contentRoot;
  assert.notEqual(verificationSemanticId(withoutRoot), verificationSemanticId(baseRecord()));
});

test('different migration or CDC position changes identity', () => {
  assert.notEqual(verificationSemanticId({ ...baseRecord(), migrationId: 'other-mig' }), verificationSemanticId(baseRecord()));
  assert.notEqual(
    verificationSemanticId({ ...baseRecord(), cdc: { snapshotCdcBoundaryId: hash('b'), expectedPosition: '0/300', observedPosition: '0/300' } }),
    verificationSemanticId({ ...baseRecord(), cdc: { snapshotCdcBoundaryId: hash('b'), expectedPosition: '0/200', observedPosition: '0/200' } })
  );
});

test('execution metadata does not enter the identity', () => {
  const a = storedRecord();
  const b = { ...a, fenceToken: 999, startedAt: '2027-01-01T00:00:00.000Z', completedAt: '2027-01-01T01:00:00.000Z' };
  assert.doesNotThrow(() => assertVerificationIdentity(a));
  assert.doesNotThrow(() => assertVerificationIdentity(b));
});

test('mutated persisted evidence is detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-verify-ident-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const record = storedRecord();
    store.saveVerification('mig-identity', record);
    // Mutate counts in storage directly (simulates evidence tampering).
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(path);
    try {
      const row = raw.prepare('SELECT verification_json FROM spool_verifications WHERE migration_id = ?').get('mig-identity');
      const tampered = JSON.parse(row.verification_json);
      tampered.counts.validRows = 9;
      tampered.counts.invalidRows = 1;
      raw.prepare('UPDATE spool_verifications SET verification_json = ? WHERE migration_id = ?').run(JSON.stringify(tampered), 'mig-identity');
    } finally {
      raw.close();
    }
    const loaded = store.getVerificationById('mig-identity', record.verificationId);
    assert.throws(() => assertVerificationIdentity(loaded), /VERIFICATION_ID_MISMATCH/);
    // Status flip without payload change is derived, not trusted.
    const flipped = { ...record, status: 'VERIFIED', invariants: [{ code: 'X', message: 'y' }] };
    assert.equal(verificationStatus(flipped), 'FAILED');
    assert.equal(verificationStatus(record), 'VERIFIED');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('immutable store rejects conflicting payload under the same identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-verify-immut-'));
  const path = join(dir, 'state.db');
  const store = new RunStore({ path });
  try {
    const record = storedRecord();
    store.saveVerification('mig-identity', record);
    // Byte-identical re-save is idempotent.
    assert.doesNotThrow(() => store.saveVerification('mig-identity', record));
    // Same identity, different payload -> conflict.
    const conflict = { ...record, counts: { sourceRows: 10, validRows: 9, invalidRows: 1 } };
    assert.throws(() => store.saveVerification('mig-identity', conflict), /VERIFICATION_ID_MISMATCH/);
    // Forged identity never validates.
    const forged = { ...record, verificationId: hash('f') };
    assert.throws(() => store.saveVerification('mig-identity', forged), /VERIFICATION_ID_MISMATCH/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
