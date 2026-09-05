import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { ConfigStore } from '../src/daemon/config-store.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function registryWithP1Connectors() {
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config));
  registry.register('sqlite', config => new SQLiteConnector(config));
  return registry;
}

function migrationInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:command-service-source' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
    ],
    writeStrategy: { mode: 'create_insert', batchSize: 2 },
    verification: { checks: ['target_count', 'schema'] },
    risk: { level: 'low', approvals: [] }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spool-command-service-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  await writeFile(join(root, 'customers.jsonl'), [
    JSON.stringify({ id: '1', name: ' Ada ' }),
    JSON.stringify({ id: '2', name: ' Grace ' })
  ].join('\n') + '\n');

  const registry = registryWithP1Connectors();
  const configStore = new ConfigStore({ stateDir });
  const jobStore = new SQLiteJobStore({ stateDir });
  const runner = new SharedMigrationRunner({ registry, store: jobStore, ownerId: 'command-service-test' });
  const service = new SpoolCommandService({ configStore, registry, jobStore, runner });

  await service.putConnection({ name: 'source', type: 'filesystem', config: { root }, secretRefs: {} });
  await service.putConnection({ name: 'target', type: 'sqlite', config: { database: targetDb }, secretRefs: {} });
  return { root, stateDir, targetDb, registry, configStore, jobStore, runner, service };
}

async function cleanup(value) {
  value.jobStore.close();
  await rm(value.root, { recursive: true, force: true });
}

test('command service exposes connector and connection metadata without runtime secrets', async () => {
  const value = await fixture();
  try {
    const connectors = await value.service.listConnectors();
    assert.deepEqual(connectors.map(item => item.name), ['filesystem', 'sqlite']);

    await value.service.putConnection({
      name: 'secreted',
      type: 'sqlite',
      config: { database: value.targetDb },
      secretRefs: { password: { provider: 'env', key: 'SPOOL_TEST_PASSWORD' } }
    });
    const connections = await value.service.listConnections();
    const projected = connections.find(item => item.name === 'secreted');
    assert.deepEqual(projected.secretRefNames, ['password']);
    assert.equal(projected.secretRefs, undefined);
    assert.doesNotMatch(JSON.stringify(connections), /SPOOL_TEST_PASSWORD/);
  } finally {
    await cleanup(value);
  }
});

test('command service rejects an unregistered connector before persisting a connection descriptor', async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      () => value.service.putConnection({ name: 'invalid', type: 'missing_connector', config: {}, secretRefs: {} }),
      /CONNECTOR_NOT_FOUND|registered|connector/i
    );
    assert.equal(await value.configStore.getConnection('invalid'), null);
  } finally {
    await cleanup(value);
  }
});

test('command service tests a named real connector and returns bounded health', async () => {
  const value = await fixture();
  try {
    const result = await value.service.testConnection({ name: 'source' });
    assert.equal(result.name, 'source');
    assert.equal(result.type, 'filesystem');
    assert.equal(result.ok, true);
    assert.equal(typeof result.health, 'object');
    assert.equal(result.health.root, value.root);
  } finally {
    await cleanup(value);
  }
});

test('command service creates a capability-bound plan and runs real filesystem to SQLite through the shared runner', async () => {
  const value = await fixture();
  try {
    const plan = await value.service.createPlan({
      planInput: migrationInput(),
      sourceConnection: 'source',
      targetConnection: 'target',
      requirements: { restartResume: false, verificationStrength: 'STANDARD' }
    });
    assert.equal(plan.connectorBinding.source.name, 'filesystem');
    assert.equal(plan.connectorBinding.target.name, 'sqlite');

    const result = await value.service.runMigration({
      plan,
      sourceConnection: 'source',
      targetConnection: 'target'
    });
    assert.equal(result.job.state, 'COMPLETE');
    assert.equal(result.job.counts.processedRows, 2);
    assert.equal(result.job.counts.acceptedRows, 2);
    assert.equal(result.receipt.receiptId, result.job.receiptId);
    assert.equal(result.receipt.verification.ok, true);
    assert.equal(result.job.executionOwner, undefined);

    const inspected = await value.service.inspectJob({ jobId: result.job.jobId });
    assert.deepEqual(inspected, result.job);
    const receipt = await value.service.getReceipt({ jobId: result.job.jobId });
    assert.deepEqual(receipt, result.receipt);
  } finally {
    await cleanup(value);
  }
});

test('command service rejects connection/plan connector mismatch before runner execution', async () => {
  const value = await fixture();
  try {
    const plan = await value.service.createPlan({
      planInput: migrationInput(),
      sourceConnection: 'source',
      targetConnection: 'target',
      requirements: { restartResume: false, verificationStrength: 'STANDARD' }
    });
    await assert.rejects(
      () => value.service.runMigration({ plan, sourceConnection: 'target', targetConnection: 'target' }),
      /CONNECTION_TYPE_MISMATCH|connector|connection/i
    );
    assert.deepEqual(await value.jobStore.list(), []);
  } finally {
    await cleanup(value);
  }
});
