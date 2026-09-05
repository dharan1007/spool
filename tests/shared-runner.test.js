import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { createCapabilityBoundMigrationPlan } from '../src/platform/plan.js';

function planInput(targetConnector = 'sqlite') {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'customers.jsonl', identity: 'sha256:test-source' },
    targetRef: { connector: targetConnector, resource: 'customers' },
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

function registryWith(targetFactory = config => new SQLiteConnector(config), targetName = 'sqlite') {
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config));
  registry.register(targetName, targetFactory);
  return registry;
}

async function makePlan(targetManifest, targetConnector = 'sqlite') {
  return createCapabilityBoundMigrationPlan(planInput(targetConnector), {
    sourceManifest: new FilesystemConnector({ root: '/tmp' }).manifest(),
    targetManifest,
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
}

test('shared runner executes real JSONL -> SQLite with commit-before-checkpoint and verified receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-runner-'));
  const stateDir = join(root, 'state');
  const targetDb = join(root, 'target.sqlite3');
  try {
    await writeFile(join(root, 'customers.jsonl'), [
      JSON.stringify({ id: '1', name: ' Ada ' }),
      JSON.stringify({ id: '2', name: ' Grace ' }),
      JSON.stringify({ id: 'bad', name: ' rejected ' }),
      JSON.stringify({ id: '3', name: ' Linus ' })
    ].join('\n') + '\n');

    const registry = registryWith();
    const store = new SQLiteJobStore({ stateDir });
    const plan = await makePlan(new SQLiteConnector({ database: targetDb }).manifest());
    const runner = new SharedMigrationRunner({ registry, store, ownerId: 'test-runner', leaseMs: 60_000 });

    const result = await runner.run({
      plan,
      sourceConfig: { root },
      targetConfig: { database: targetDb }
    });

    assert.equal(result.job.state, 'COMPLETE');
    assert.equal(result.job.counts.processedRows, 4);
    assert.equal(result.job.counts.acceptedRows, 3);
    assert.equal(result.job.counts.rejectedRows, 1);
    assert.ok(result.job.checkpoint?.targetBoundary);
    assert.match(result.job.checkpoint?.batchIdentity ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.receipt.receiptId, result.job.receiptId);
    assert.equal(result.receipt.verification.ok, true);

    const db = new DatabaseSync(targetDb, { readOnly: true });
    const rows = db.prepare('SELECT id, name FROM customers ORDER BY id').all().map(row => ({ ...row }));
    db.close();
    assert.deepEqual(rows, [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
      { id: 3, name: 'Linus' }
    ]);

    const stateBytes = await readFile(join(stateDir, 'spool-state.sqlite3'));
    assert.ok(stateBytes.length > 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous target write fails closed into RECOVERY_REQUIRED without advancing checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-runner-ambiguous-'));
  try {
    await writeFile(join(root, 'customers.jsonl'), JSON.stringify({ id: '1', name: 'Ada' }) + '\n');

    class AmbiguousSQLiteConnector extends SQLiteConnector {
      manifest() {
        const manifest = super.manifest();
        return { ...manifest, name: 'sqlite_ambiguous' };
      }
      async write() {
        const error = new Error('native driver included secret=SHOULD_NOT_PERSIST');
        error.code = 'TARGET_COMMIT_UNKNOWN';
        throw error;
      }
    }

    const targetDb = join(root, 'target.sqlite3');
    const registry = registryWith(config => new AmbiguousSQLiteConnector(config), 'sqlite_ambiguous');
    const store = new SQLiteJobStore({ stateDir: join(root, 'state') });
    const plan = await makePlan(new AmbiguousSQLiteConnector({ database: targetDb }).manifest(), 'sqlite_ambiguous');
    const runner = new SharedMigrationRunner({ registry, store, ownerId: 'ambiguous-runner' });

    await assert.rejects(
      () => runner.run({ plan, sourceConfig: { root }, targetConfig: { database: targetDb } }),
      /RECOVERY_REQUIRED|ambiguous|target/i
    );

    const [job] = await store.list();
    assert.equal(job.state, 'RECOVERY_REQUIRED');
    assert.equal(job.checkpoint, null);
    assert.deepEqual(job.counts, { processedRows: 0, acceptedRows: 0, rejectedRows: 0 });
    const events = await store.listRecoveryEvents(job.jobId);
    assert.equal(events.at(-1).kind, 'target_commit_ambiguous');
    assert.doesNotMatch(JSON.stringify(events), /SHOULD_NOT_PERSIST/);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connector version drift is rejected before target mutation or execution acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-runner-drift-'));
  try {
    await writeFile(join(root, 'customers.jsonl'), JSON.stringify({ id: '1', name: 'Ada' }) + '\n');
    const targetDb = join(root, 'target.sqlite3');

    class DriftedSQLiteConnector extends SQLiteConnector {
      manifest() {
        const manifest = super.manifest();
        return { ...manifest, version: '1.0.1' };
      }
    }

    const plan = await makePlan(new SQLiteConnector({ database: targetDb }).manifest());
    const registry = registryWith(config => new DriftedSQLiteConnector(config));
    const store = new SQLiteJobStore({ stateDir: join(root, 'state') });
    const runner = new SharedMigrationRunner({ registry, store, ownerId: 'drift-runner' });

    await assert.rejects(
      () => runner.run({ plan, sourceConfig: { root }, targetConfig: { database: targetDb } }),
      /drift|version|capabilit/i
    );
    assert.deepEqual(await store.list(), []);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
