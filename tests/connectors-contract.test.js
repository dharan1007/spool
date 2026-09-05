import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnector } from '../src/connectors/contract.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';

const CAPABILITIES = Object.freeze({
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

function validFixtureConnector() {
  return {
    manifest() {
      return { name: 'fixture', version: '1.0.0', capabilities: { ...CAPABILITIES } };
    },
    async validateConfig(config) { return { ...config, validated: true }; },
    async testConnection() { return { ok: true }; },
    async discover() { return { resources: [] }; },
    async *read() { yield { rows: [{ id: 1 }], cursor: { offset: 1 }, bytesRead: 8 }; },
    async planWrite() { return { strategy: 'insert' }; },
    async write() { return { committedRows: 1, checkpointToken: '1' }; },
    async verify() { return { ok: true, targetRows: 1 }; },
    async close() {}
  };
}

test('connector validation accepts a complete capability-declared connector', () => {
  const connector = validFixtureConnector();
  const manifest = validateConnector(connector);
  assert.equal(manifest.name, 'fixture');
  assert.deepEqual(manifest.capabilities, CAPABILITIES);
});

test('connector registry rejects missing methods or incomplete capability declarations', () => {
  const registry = new ConnectorRegistry();
  assert.throws(
    () => registry.register('bad', () => ({ manifest() { return { name: 'bad', version: '1.0.0', capabilities: { source: true } }; } })),
    /connector|capabilit|method/i
  );
});

test('connector registry refuses duplicate connector names', () => {
  const registry = new ConnectorRegistry();
  registry.register('fixture', () => validFixtureConnector());
  assert.throws(() => registry.register('fixture', () => validFixtureConnector()), /already registered/i);
});

test('registry opens a validated connector and validates its config', async () => {
  const registry = new ConnectorRegistry();
  registry.register('fixture', () => validFixtureConnector());
  const opened = await registry.open('fixture', { root: '/tmp/data' }, { purpose: 'test' });
  assert.equal(opened.manifest().name, 'fixture');
  assert.deepEqual(opened.connection, { root: '/tmp/data', validated: true });
  await opened.close();
});

test('read streams must be async iterable', async () => {
  const connector = validFixtureConnector();
  const stream = connector.read({}, { resource: 'customers' });
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  const batches = [];
  for await (const batch of stream) batches.push(batch);
  assert.deepEqual(batches, [{ rows: [{ id: 1 }], cursor: { offset: 1 }, bytesRead: 8 }]);
});
