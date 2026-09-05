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
import { sha256Json } from '../src/platform/canonical-json.js';

function registryWithP1Connectors() {
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config));
  registry.register('sqlite', config => new SQLiteConnector(config));
  return registry;
}

function migrationInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:lifecycle-source' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
    ],
    writeStrategy: { mode: 'create_insert', batchSize: 1 },
    verification: { checks: ['target_count', 'schema'] },
    risk: { level: 'low', approvals: [] }
  };
}

async function fingerprint(descriptor) {
  return sha256Json({
    domain: 'spool-connection-binding-v1',
    name: descriptor.name,
    type: descriptor.type,
    config: descriptor.config ?? {},
    secretRefs: descriptor.secretRefs ?? {}
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spool-lifecycle-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  await writeFile(join(root, 'customers.jsonl'), [
    JSON.stringify({ id: '1', name: ' Ada ' }),
    JSON.stringify({ id: '2', name: ' Grace ' })
  ].join('\n') + '\n');

  const registry = registryWithP1Connectors();
  const configStore = new ConfigStore({ stateDir });
  const jobStore = new SQLiteJobStore({ stateDir });
  const runner = new SharedMigrationRunner({ registry, store: jobStore, ownerId: 'lifecycle-test' });
  const service = new SpoolCommandService({ configStore, registry, jobStore, runner });
  await service.putConnection({ name: 'source', type: 'filesystem', config: { root }, secretRefs: {} });
  await service.putConnection({ name: 'target', type: 'sqlite', config: { database: targetDb }, secretRefs: {} });
  const plan = await service.createPlan({
    planInput: migrationInput(),
    sourceConnection: 'source',
    targetConnection: 'target',
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
  return { root, stateDir, targetDb, registry, configStore, jobStore, runner, service, plan };
}

async function cleanup(value) {
  value.jobStore.close();
  await rm(value.root, { recursive: true, force: true });
}

test('SQLiteJobStore durably persists a secret-free managed execution context without exposing it publicly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-lifecycle-store-'));
  const store = new SQLiteJobStore({ stateDir: root });
  try {
    const plan = { planId: 'sha256:managed-plan', planRevision: 1 };
    const executionContext = {
      schemaVersion: 1,
      plan,
      sourceConnection: { name: 'source', fingerprint: 'sha256:source-binding' },
      targetConnection: { name: 'target', fingerprint: 'sha256:target-binding' }
    };
    const created = await store.create(plan, { executionContext });
    const loaded = await store.load(created.jobId);
    assert.deepEqual(loaded.executionContext, executionContext);
    assert.doesNotMatch(JSON.stringify(loaded), /resolvedSecret|secretValue/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resume rejects named connection drift before opening a target connector', async () => {
  const value = await fixture();
  try {
    const source = await value.configStore.getConnection('source');
    const target = await value.configStore.getConnection('target');
    const job = await value.jobStore.create(value.plan, {
      executionContext: {
        schemaVersion: 1,
        plan: value.plan,
        sourceConnection: { name: 'source', fingerprint: await fingerprint(source) },
        targetConnection: { name: 'target', fingerprint: await fingerprint(target) }
      }
    });
    await value.service.putConnection({
      name: 'target',
      type: 'sqlite',
      config: { database: join(value.root, 'different.sqlite3') },
      secretRefs: {}
    });
    await assert.rejects(
      () => value.service.resumeJob({ jobId: job.jobId }),
      /drift|connection|fingerprint/i
    );
  } finally {
    await cleanup(value);
  }
});
