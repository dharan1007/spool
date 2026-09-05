import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { CONNECTOR_CAPABILITY_PROFILE_VERSION, validateConnector } from '../src/connectors/contract.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { SharedMigrationRunner } from '../src/daemon/shared-runner.js';
import { createCapabilityBoundMigrationPlan } from '../src/platform/plan.js';

const BATCH_ID = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function createPeopleTable(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.close();
}

const SOURCE_CAPABILITIES = Object.freeze({
  source: true,
  target: false,
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

function sourceManifest() {
  return {
    name: 'ledger_source',
    version: '1.0.0',
    capabilities: { ...SOURCE_CAPABILITIES },
    capabilityProfile: {
      version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
      source: {
        snapshot: 'fingerprint_checked',
        ordering: 'stable_total_order',
        resume: 'snapshot_cursor',
        cursorKind: 'offset'
      },
      target: {
        atomicity: 'none',
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
    }
  };
}

class LedgerSourceConnector {
  constructor() { this.connection = {}; }
  manifest() { return sourceManifest(); }
  async validateConfig() { return {}; }
  async testConnection() { return { ok: true }; }
  async discover() { return { identity: 'sha256:ledger-source-snapshot' }; }
  async *read(_ctx, request = {}) {
    const rows = [{ id: '1', name: ' Ada ' }, { id: '2', name: ' Grace ' }];
    const start = request.cursor?.offset ?? 0;
    if (start < rows.length) yield { rows: rows.slice(start), cursor: { offset: rows.length } };
  }
  async planWrite() { return { strategy: 'none' }; }
  async write() { throw new Error('source connector cannot write'); }
  async verify() { return { ok: true }; }
  async close() {}
}

function planInput() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'ledger_source', resource: 'people', identity: 'sha256:ledger-source-snapshot' },
    targetRef: { connector: 'sqlite', resource: 'people' },
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ],
    mapping: [
      { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
    ],
    writeStrategy: { mode: 'insert', batchSize: 2 },
    verification: { checks: ['target_count', 'schema'] },
    risk: { level: 'low', approvals: [] }
  };
}

async function expireLease(store, jobId) {
  const job = await store.load(jobId);
  await store.update(
    jobId,
    current => ({ ...current, executionLeaseExpiresAt: '2000-01-01T00:00:00.000Z' }),
    { expectedStateVersion: job.stateVersion, expectedExecutionEpoch: job.executionEpoch }
  );
}

test('SQLite advertises truthful ledger-backed crash reconciliation capability', () => {
  const manifest = validateConnector(new SQLiteConnector({ database: ':memory:' }));
  assert.equal(manifest.capabilityProfile.target.atomicity, 'transaction');
  assert.equal(manifest.capabilityProfile.target.commitEvidence, 'native_commit_id');
  assert.equal(manifest.capabilityProfile.target.reconcileAfterCrash, true);
  assert.equal(manifest.capabilityProfile.target.idempotency, 'batch_key');
  assert.equal(typeof SQLiteConnector.prototype.reconcileTargetCommit, 'function');
});

test('SQLite writes target rows and batch ledger in one transaction and replay is idempotent', async () => withTempDir('spool-sqlite-ledger-', async root => {
  const dbPath = join(root, 'target.db');
  createPeopleTable(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const request = {
    resource: 'people',
    mode: 'insert',
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ]
  };
  const ctx = { connection, planId: 'sha256:plan', jobId: 'job_1', executionEpoch: 1, batchIdentity: BATCH_ID };
  const batches = [{ rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] }];

  const first = await connector.write(ctx, request, batches);
  const second = await connector.write(ctx, request, batches);
  assert.equal(first.commitId, second.commitId);
  assert.equal(first.committedRows, 2);
  assert.equal(second.committedRows, 2);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM people').get().count), 2);
  const ledger = db.prepare('SELECT batch_identity, resource, plan_id, job_id, committed_rows, target_rows FROM __spool_batch_ledger_v1 WHERE batch_identity=?').get(BATCH_ID);
  assert.deepEqual({ ...ledger }, {
    batch_identity: BATCH_ID,
    resource: 'people',
    plan_id: 'sha256:plan',
    job_id: 'job_1',
    committed_rows: 2,
    target_rows: 2
  });
  db.close();

  const reconciled = await connector.reconcileTargetCommit(ctx, {
    resource: 'people',
    pendingBatch: { batchIdentity: BATCH_ID }
  });
  assert.equal(reconciled.status, 'COMMITTED');
  assert.equal(reconciled.ack.commitId, first.commitId);
  assert.equal(reconciled.ack.targetRows, 2);
  await connector.close();
}));

test('SQLite rolled-back target mutation has no ledger evidence and reconciles NOT_COMMITTED', async () => withTempDir('spool-sqlite-ledger-rollback-', async root => {
  const dbPath = join(root, 'target.db');
  createPeopleTable(dbPath);
  const connector = new SQLiteConnector({ database: dbPath });
  const connection = await connector.validateConfig({ database: dbPath });
  const ctx = { connection, planId: 'sha256:plan', jobId: 'job_2', executionEpoch: 1, batchIdentity: BATCH_ID };

  await assert.rejects(() => connector.write(ctx, {
    resource: 'people',
    mode: 'insert',
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false }
    ]
  }, [{ rows: [{ id: 1, name: null }] }]), /constraint|NOT NULL/i);

  const reconciled = await connector.reconcileTargetCommit(ctx, {
    resource: 'people',
    pendingBatch: { batchIdentity: BATCH_ID }
  });
  assert.equal(reconciled.status, 'NOT_COMMITTED');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM people').get().count), 0);
  const ledgerExists = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='__spool_batch_ledger_v1'").get();
  if (ledgerExists) assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger_v1').get().count), 0);
  db.close();
  await connector.close();
}));

test('shared runner recovers SQLite commit-before-checkpoint crash from native ledger without duplicate target write', async () => withTempDir('spool-sqlite-ledger-runner-', async root => {
  const targetDb = join(root, 'target.db');
  createPeopleTable(targetDb);
  const stateDir = join(root, 'state');
  const registry = new ConnectorRegistry();
  registry.register('ledger_source', () => new LedgerSourceConnector());
  registry.register('sqlite', config => new SQLiteConnector(config));

  const targetManifest = registry.manifest('sqlite');
  const plan = await createCapabilityBoundMigrationPlan(planInput(), {
    sourceManifest: sourceManifest(),
    targetManifest,
    requirements: { restartResume: true, verificationStrength: 'BASIC' }
  });
  const store = new SQLiteJobStore({ stateDir });
  const originalCommitCheckpoint = store.commitCheckpoint.bind(store);
  let injectCrash = true;
  store.commitCheckpoint = async (...args) => {
    if (injectCrash) {
      injectCrash = false;
      const error = new Error('injected crash after SQLite commit before metadata checkpoint');
      error.code = 'INJECTED_CRASH';
      throw error;
    }
    return originalCommitCheckpoint(...args);
  };

  const first = new SharedMigrationRunner({ registry, store, ownerId: 'sqlite-runner-a', leaseMs: 60_000 });
  await assert.rejects(() => first.run({ plan, targetConfig: { database: targetDb } }), /injected crash/i);

  const [orphan] = await store.list();
  assert.equal(orphan.state, 'RUNNING');
  assert.ok(orphan.pendingBatch?.batchIdentity);
  const dbAfterCrash = new DatabaseSync(targetDb, { readOnly: true });
  assert.equal(Number(dbAfterCrash.prepare('SELECT COUNT(*) AS count FROM people').get().count), 2);
  assert.equal(Number(dbAfterCrash.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger_v1').get().count), 1);
  dbAfterCrash.close();

  await expireLease(store, orphan.jobId);
  const second = new SharedMigrationRunner({ registry, store, ownerId: 'sqlite-runner-b', leaseMs: 60_000 });
  const result = await second.run({ plan, jobId: orphan.jobId, targetConfig: { database: targetDb } });
  assert.equal(result.job.state, 'COMPLETE');
  assert.equal(result.job.pendingBatch, null);
  assert.equal(result.job.counts.acceptedRows, 2);

  const dbAfterRecovery = new DatabaseSync(targetDb, { readOnly: true });
  assert.equal(Number(dbAfterRecovery.prepare('SELECT COUNT(*) AS count FROM people').get().count), 2);
  assert.equal(Number(dbAfterRecovery.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger_v1').get().count), 1);
  dbAfterRecovery.close();
  store.close();
}));
