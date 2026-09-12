import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAssuranceLevel,
  deriveMutationAssurance,
  validateConnectorDescriptor
} from '../src/connectors/contract.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { POSTGRES_TARGET_DESCRIPTOR } from '../src/connectors/postgres/runtime.js';
import { SQLITE_TARGET_DESCRIPTOR } from '../src/connectors/sqlite/runtime.js';

function c4Target(name = 'verified-target') {
  return {
    name,
    role: 'target',
    version: 1,
    assurance: { level: 'C4' },
    capabilities: {
      targetContractBinding: true,
      idempotentReplay: true,
      reconcileAfterCrash: true,
      transactions: true,
      atomicBatchLedger: true,
      fencing: true,
      exactCommitEvidence: true
    }
  };
}

const snapshotSource = {
  name: 'filesystem',
  role: 'source',
  version: 1,
  assurance: { level: 'C1' },
  capabilities: { snapshotBinding: true, readOnlySnapshot: true, streaming: true }
};

test('built-in SQLite and PostgreSQL targets truthfully advertise C4 rather than full verified mutation', () => {
  assert.equal(SQLITE_TARGET_DESCRIPTOR.assurance.level, 'C4');
  assert.equal(POSTGRES_TARGET_DESCRIPTOR.assurance.level, 'C4');
  assert.equal(SQLITE_TARGET_DESCRIPTOR.capabilities.exactCommitEvidence, true);
  assert.equal(POSTGRES_TARGET_DESCRIPTOR.capabilities.targetContractBinding, true);
});

test('validated connector descriptors are idempotently revalidatable and canonical semantics cannot be spoofed', () => {
  const once = validateConnectorDescriptor(c4Target('canonical-target'));
  const twice = validateConnectorDescriptor(once);
  assert.deepEqual(twice, once);

  assert.throws(
    () => validateConnectorDescriptor({
      ...c4Target('spoofed-semantics'),
      assurance: { level: 'C4', semantics: 'marketing claim instead of protocol semantics' }
    }),
    error => error?.code === 'INVALID_CONNECTOR_ASSURANCE'
  );
});

test('connector descriptors fail closed when an assurance level overclaims capabilities', () => {
  assert.throws(
    () => validateConnectorDescriptor({
      ...c4Target('overclaim'),
      assurance: { level: 'C5' }
    }),
    error => error?.code === 'CONNECTOR_ASSURANCE_OVERCLAIM' && error?.details?.capability === 'readAfterWriteVerification'
  );

  assert.throws(
    () => validateConnectorDescriptor({
      name: 'weak-source', role: 'source', version: 1, assurance: { level: 'C1' }, capabilities: { snapshotBinding: true }
    }),
    error => error?.code === 'CONNECTOR_ASSURANCE_OVERCLAIM'
  );
});

test('assurance checks reject attempts to use a C4 connector where C5 is required', () => {
  const descriptor = validateConnectorDescriptor(c4Target());
  assert.equal(assertAssuranceLevel(descriptor, 'C4'), true);
  assert.throws(
    () => assertAssuranceLevel(descriptor, 'C5'),
    error => error?.code === 'CONNECTOR_ASSURANCE_REQUIRED' && error?.details?.provided === 'C4'
  );
});

test('registry enforces assurance and capability requirements before invoking a connector factory', async () => {
  const registry = new ConnectorRegistry();
  let opened = 0;
  registry.register(c4Target('postgres-safe'), async () => {
    opened += 1;
    return { ok: true };
  });

  await assert.rejects(
    registry.open('postgres-safe', 'target', {}, {}, { minimumAssurance: 'C5' }),
    error => error?.code === 'CONNECTOR_ASSURANCE_REQUIRED'
  );
  assert.equal(opened, 0, 'factory must not execute when guarantee requirements are unsatisfied');

  const runtime = await registry.open(
    'postgres-safe', 'target', {}, {},
    { minimumAssurance: 'C4', capabilities: ['exactCommitEvidence', 'fencing'] }
  );
  assert.equal(runtime.ok, true);
  assert.equal(opened, 1);
});

test('end-to-end assurance becomes C5 only when deterministic source, C4 target, and SVMP verification are all present', () => {
  const source = validateConnectorDescriptor(snapshotSource);
  const target = validateConnectorDescriptor(c4Target());

  assert.equal(deriveMutationAssurance({ source, target, protocolVerified: false }), 'C4');
  assert.equal(deriveMutationAssurance({ source, target, protocolVerified: true }), 'C5');
});

test('source assurance levels cannot masquerade as target mutation guarantees', () => {
  assert.throws(
    () => validateConnectorDescriptor({
      ...snapshotSource,
      assurance: { level: 'C4' },
      capabilities: {
        ...snapshotSource.capabilities,
        targetContractBinding: true,
        idempotentReplay: true,
        reconcileAfterCrash: true,
        transactions: true,
        atomicBatchLedger: true,
        fencing: true,
        exactCommitEvidence: true
      }
    }),
    error => error?.code === 'CONNECTOR_ASSURANCE_ROLE_MISMATCH'
  );
});
