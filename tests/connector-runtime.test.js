import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConnectorDescriptor } from '../src/connectors/contract.js';
import { createFileSnapshot, assertSnapshotBinding } from '../src/connectors/source-snapshot.js';
import { createBatchIdentity } from '../src/execution/batch-identity.js';
import { createCheckpoint, assertCheckpointBinding } from '../src/execution/checkpoint.js';

const descriptor = () => ({
  name: 'sqlite',
  role: 'target',
  version: 1,
  capabilities: {
    transactions: true,
    atomicBatchLedger: true,
    reconcileAfterCrash: true,
    idempotentReplay: true,
    snapshotBinding: true,
    fencing: true
  }
});

test('connector descriptors expose a strict frozen production capability contract', () => {
  const validated = validateConnectorDescriptor(descriptor());
  assert.equal(validated.name, 'sqlite');
  assert.equal(validated.capabilities.reconcileAfterCrash, true);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.capabilities), true);
  assert.throws(() => validateConnectorDescriptor({ ...descriptor(), capabilities: { ...descriptor().capabilities, magic: true } }), /INVALID_CONNECTOR_CAPABILITY/);
  assert.throws(() => validateConnectorDescriptor({ ...descriptor(), role: 'other' }), /INVALID_CONNECTOR_ROLE/);
});

test('file source snapshots are content-bound and detect changed input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-snapshot-'));
  try {
    const file = join(dir, 'source.csv');
    await writeFile(file, 'id,name\n1,Ada\n', 'utf8');
    const first = await createFileSnapshot(file);
    const again = await createFileSnapshot(file);
    assert.equal(first.snapshotId, again.snapshotId);
    assert.doesNotThrow(() => assertSnapshotBinding(first, again));

    await writeFile(file, 'id,name\n1,Ada\n2,Lin\n', 'utf8');
    const changed = await createFileSnapshot(file);
    assert.notEqual(first.snapshotId, changed.snapshotId);
    assert.throws(() => assertSnapshotBinding(first, changed), /SOURCE_CHANGED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('batch identity is deterministic and binds every semantic replay dimension', () => {
  const base = {
    migrationId: 'mig_001',
    planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    mappingRevision: 3,
    sourceRange: { start: 0, endExclusive: 500 },
    targetIdentity: { connector: 'sqlite', connectionId: 'prod', resource: 'customers' }
  };
  const a = createBatchIdentity(base);
  assert.equal(a, createBatchIdentity(structuredClone(base)));
  for (const mutate of [
    x => { x.migrationId = 'mig_002'; },
    x => { x.mappingRevision = 4; },
    x => { x.sourceRange.endExclusive = 501; },
    x => { x.targetIdentity.resource = 'other'; },
    x => { x.sourceSnapshotId = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'; }
  ]) {
    const next = structuredClone(base); mutate(next);
    assert.notEqual(createBatchIdentity(next), a);
  }
});

test('checkpoint binding fails closed when plan, snapshot, revision or target changes', () => {
  const binding = {
    migrationId: 'mig_001',
    planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    mappingRevision: 3,
    targetIdentity: { connector: 'sqlite', connectionId: 'prod', resource: 'customers' }
  };
  const checkpoint = createCheckpoint({ ...binding, nextOffset: 500, lastBatchIdentity: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' });
  assert.doesNotThrow(() => assertCheckpointBinding(checkpoint, binding));
  assert.throws(() => assertCheckpointBinding(checkpoint, { ...binding, sourceSnapshotId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }), /SOURCE_CHANGED/);
  assert.throws(() => assertCheckpointBinding(checkpoint, { ...binding, mappingRevision: 4 }), /CHECKPOINT_BINDING_MISMATCH/);
});
