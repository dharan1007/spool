import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRegistry } from '../src/connectors/registry.js';

function descriptor(name, role, capabilities = {}) {
  return {
    name,
    role,
    version: 1,
    capabilities
  };
}

test('registry opens an async target factory through a validated role-qualified registration', async () => {
  const registry = new ConnectorRegistry();
  registry.register(
    descriptor('sqlite', 'target', { transactions: true, reconcileAfterCrash: true }),
    async ({ config, context }) => ({
      kind: 'sqlite-target-runtime',
      config,
      context
    })
  );

  const opened = await registry.open('sqlite', 'target', { path: '/tmp/app.db' }, { migrationId: 'mig_001' });

  assert.equal(opened.kind, 'sqlite-target-runtime');
  assert.deepEqual(opened.config, { path: '/tmp/app.db' });
  assert.deepEqual(opened.context, { migrationId: 'mig_001' });
  assert.equal(registry.descriptor('sqlite', 'target').capabilities.reconcileAfterCrash, true);
});

test('source and target registrations with the same connector name remain independent', async () => {
  const registry = new ConnectorRegistry();
  registry.register(descriptor('filesystem', 'source', { streaming: true }), async () => ({ role: 'source' }));
  registry.register(descriptor('filesystem', 'target', { streaming: true }), async () => ({ role: 'target' }));

  assert.equal((await registry.open('filesystem', 'source')).role, 'source');
  assert.equal((await registry.open('filesystem', 'target')).role, 'target');
});

test('registry rejects duplicate role-qualified registrations and unknown connectors', async () => {
  const registry = new ConnectorRegistry();
  registry.register(descriptor('sqlite', 'target'), async () => ({}));

  assert.throws(
    () => registry.register(descriptor('sqlite', 'target'), async () => ({})),
    error => error?.code === 'CONNECTOR_ALREADY_REGISTERED'
  );
  await assert.rejects(
    registry.open('postgresql', 'target'),
    error => error?.code === 'CONNECTOR_NOT_REGISTERED'
  );
});

test('registry validates descriptors and factories before accepting registrations', () => {
  const registry = new ConnectorRegistry();

  assert.throws(
    () => registry.register({ name: 'SQLite!', role: 'target', version: 1, capabilities: {} }, async () => ({})),
    error => error?.code === 'INVALID_CONNECTOR_NAME'
  );
  assert.throws(
    () => registry.register(descriptor('sqlite', 'target'), null),
    error => error?.code === 'INVALID_CONNECTOR_FACTORY'
  );
});

test('registry list is deterministic, filtered by role, and returns frozen descriptors', () => {
  const registry = new ConnectorRegistry();
  registry.register(descriptor('sqlite', 'target', { transactions: true }), async () => ({}));
  registry.register(descriptor('filesystem', 'source', { streaming: true }), async () => ({}));
  registry.register(descriptor('filesystem', 'target', { streaming: true }), async () => ({}));

  const all = registry.list();
  assert.deepEqual(all.map(item => `${item.role}:${item.name}`), [
    'source:filesystem',
    'target:filesystem',
    'target:sqlite'
  ]);
  assert.equal(Object.isFrozen(all), true);
  assert.equal(Object.isFrozen(all[0]), true);

  const targets = registry.list({ role: 'target' });
  assert.deepEqual(targets.map(item => item.name), ['filesystem', 'sqlite']);
});
