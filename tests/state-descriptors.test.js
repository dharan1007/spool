import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_STATE_KINDS,
  TARGET_STATE_KINDS,
  createFilesystemSourceState,
  createPostgresSourceState,
  createSqliteTargetState,
  createPostgresTargetState,
  assertSourceStateBinding,
  assertTargetStateBinding
} from '../src/protocol/state-descriptors.js';

const HASH = value => `sha256:${value.repeat(64).slice(0, 64)}`;

test('filesystem SourceState is deterministic and changes when content identity changes', () => {
  const input = {
    path: '/srv/input/customers.csv',
    size: 128,
    contentSha256: 'a'.repeat(64),
    snapshotId: HASH('b')
  };

  const first = createFilesystemSourceState(input);
  const second = createFilesystemSourceState({ ...input });
  const changed = createFilesystemSourceState({ ...input, contentSha256: 'c'.repeat(64), snapshotId: HASH('d') });

  assert.equal(first.kind, SOURCE_STATE_KINDS.FILESYSTEM);
  assert.match(first.sourceStateId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.sourceStateId, second.sourceStateId);
  assert.notEqual(first.sourceStateId, changed.sourceStateId);
  assert.deepEqual(first.state, {
    path: '/srv/input/customers.csv',
    size: 128,
    contentSha256: 'a'.repeat(64),
    snapshotId: HASH('b')
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.state), true);
});

test('PostgreSQL SourceState binds server, database, MVCC snapshot, WAL position, relation and contract', () => {
  const base = {
    systemIdentifier: '7429931746381247331',
    databaseOid: 16384,
    databaseName: 'app',
    serverVersionNum: 170004,
    relation: { schema: 'public', table: 'customers', relid: 24591 },
    snapshot: {
      exportedSnapshotId: '00000003-0000001A-1',
      xmin: '912',
      xmax: '940',
      xip: ['919', '923', '934']
    },
    walLsn: '0/16B6C50',
    contractId: HASH('e')
  };

  const first = createPostgresSourceState(base);
  const reordered = createPostgresSourceState({
    ...base,
    snapshot: { ...base.snapshot, xip: ['934', '919', '923'] }
  });
  const changedLsn = createPostgresSourceState({ ...base, walLsn: '0/16B6D00' });
  const changedContract = createPostgresSourceState({ ...base, contractId: HASH('f') });

  assert.equal(first.kind, SOURCE_STATE_KINDS.POSTGRES);
  assert.equal(first.sourceStateId, reordered.sourceStateId, 'xip order is not semantically meaningful');
  assert.notEqual(first.sourceStateId, changedLsn.sourceStateId);
  assert.notEqual(first.sourceStateId, changedContract.sourceStateId);
  assert.deepEqual(first.state.snapshot.xip, ['919', '923', '934']);
});

test('PostgreSQL SourceState rejects incomplete or unsafe identity material', () => {
  assert.throws(
    () => createPostgresSourceState({
      systemIdentifier: '7429931746381247331',
      databaseOid: 16384,
      databaseName: 'app',
      serverVersionNum: 170004,
      relation: { schema: 'public', table: 'customers', relid: 24591 },
      snapshot: { exportedSnapshotId: '00000003-0000001A-1', xmin: '912', xmax: '940', xip: [] },
      walLsn: 'not-an-lsn',
      contractId: HASH('e')
    }),
    error => error?.code === 'INVALID_SOURCE_STATE'
  );

  const unsafe = {
    systemIdentifier: '7429931746381247331',
    databaseOid: 16384,
    databaseName: 'app',
    serverVersionNum: 170004,
    relation: { schema: 'public', table: 'customers', relid: 24591 },
    snapshot: { exportedSnapshotId: '00000003-0000001A-1', xmin: '912', xmax: '940', xip: [] },
    walLsn: '0/16B6C50',
    contractId: HASH('e'),
    secretRef: 'vault://prod/postgres'
  };
  assert.throws(() => createPostgresSourceState(unsafe), error => error?.code === 'UNKNOWN_SOURCE_STATE_FIELD');
});

test('target states bind connector-native database identity and target contract', () => {
  const sqlite = createSqliteTargetState({
    realPath: '/srv/targets/app.db',
    device: 2049,
    inode: 9912,
    table: 'customers',
    contractId: HASH('1')
  });
  const postgres = createPostgresTargetState({
    systemIdentifier: '7429931746381247331',
    databaseOid: 16384,
    databaseName: 'app',
    serverVersionNum: 170004,
    relation: { schema: 'public', table: 'customers', relid: 24591 },
    contractId: HASH('2')
  });

  assert.equal(sqlite.kind, TARGET_STATE_KINDS.SQLITE);
  assert.equal(postgres.kind, TARGET_STATE_KINDS.POSTGRES);
  assert.match(sqlite.targetStateId, /^sha256:[a-f0-9]{64}$/);
  assert.match(postgres.targetStateId, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(sqlite.targetStateId, postgres.targetStateId);
});

test('PostgreSQL TargetState reports target-scoped validation failures for unsafe relation material', () => {
  assert.throws(
    () => createPostgresTargetState({
      systemIdentifier: '7429931746381247331',
      databaseOid: 16384,
      databaseName: 'app',
      serverVersionNum: 170004,
      relation: { schema: 'public', table: 'customers', relid: 24591, secretRef: 'vault://prod/postgres' },
      contractId: HASH('2')
    }),
    error => error?.code === 'UNKNOWN_TARGET_STATE_FIELD'
  );
});

test('binding assertions fail closed on source or target drift', () => {
  const sourceA = createFilesystemSourceState({ path: '/srv/input/a.csv', size: 1, contentSha256: 'a'.repeat(64), snapshotId: HASH('a') });
  const sourceB = createFilesystemSourceState({ path: '/srv/input/a.csv', size: 1, contentSha256: 'b'.repeat(64), snapshotId: HASH('b') });
  assert.equal(assertSourceStateBinding(sourceA, sourceA), true);
  assert.throws(() => assertSourceStateBinding(sourceA, sourceB), error => error?.code === 'SOURCE_DRIFT');

  const targetA = createSqliteTargetState({ realPath: '/srv/targets/a.db', device: 1, inode: 2, table: 'customers', contractId: HASH('1') });
  const targetB = createSqliteTargetState({ realPath: '/srv/targets/a.db', device: 1, inode: 2, table: 'customers', contractId: HASH('2') });
  assert.equal(assertTargetStateBinding(targetA, targetA), true);
  assert.throws(() => assertTargetStateBinding(targetA, targetB), error => error?.code === 'TARGET_DRIFT');
});
