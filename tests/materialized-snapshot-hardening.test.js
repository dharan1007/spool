import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MATERIALIZED_SNAPSHOT_ALGORITHM,
  loadMaterializedSnapshot,
  materializeSnapshotBatches
} from '../src/connectors/materialized-snapshot.js';
import { createPostgresSourceState } from '../src/protocol/state-descriptors.js';
import { canonicalJson, sha256Canonical } from '../src/platform/canonical-json.js';

const CONTRACT_ID = `sha256:${'2'.repeat(64)}`;
const OTHER_CONTRACT_ID = `sha256:${'9'.repeat(64)}`;
const contract = Object.freeze({
  schemaVersion: 1,
  columns: [Object.freeze({ name: 'id' }), Object.freeze({ name: 'name' })],
  primaryKey: ['id']
});
const rows = Object.freeze([
  Object.freeze({ id: 1, name: 'alpha' }),
  Object.freeze({ id: 2, name: 'beta' }),
  Object.freeze({ id: 3, name: 'gamma' }),
  Object.freeze({ id: 4, name: 'delta' })
]);

function postgresSourceState(contractId = CONTRACT_ID) {
  return createPostgresSourceState({
    systemIdentifier: '1234567890123456789',
    databaseOid: 16384,
    databaseName: 'spooltest',
    serverVersionNum: 170000,
    relation: { schema: 'public', table: 'orders', relid: 24576 },
    contractId,
    snapshot: {
      exportedSnapshotId: '00000001-00000001-1',
      xmin: '100',
      xmax: '200',
      xip: ['150']
    },
    walLsn: '0/16B6C50'
  });
}

async function* batches(sourceStateId) {
  yield Object.freeze({
    sourceStateId,
    sourceRange: Object.freeze({ start: 0, endExclusive: 2 }),
    rows: Object.freeze(rows.slice(0, 2))
  });
  yield Object.freeze({
    sourceStateId,
    sourceRange: Object.freeze({ start: 2, endExclusive: 4 }),
    rows: Object.freeze(rows.slice(2))
  });
}

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'spool-materialized-hardening-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function materialize(root, sourceState = postgresSourceState(), contractId = CONTRACT_ID) {
  return materializeSnapshotBatches({
    snapshotDir: root,
    sourceState,
    contract,
    contractId,
    sourceIdentity: { connector: 'postgres', resource: 'public.orders' },
    batches: batches(sourceState.sourceStateId),
    chunkRows: 1
  });
}

test('PostgreSQL materialization rejects a manifest contract that disagrees with SourceState', async t => {
  const root = await makeRoot(t);
  const sourceState = postgresSourceState(CONTRACT_ID);
  await assert.rejects(
    () => materialize(root, sourceState, OTHER_CONTRACT_ID),
    error => error?.code === 'SOURCE_SNAPSHOT_CONTRACT_MISMATCH'
  );
});

test('loader rejects a root-valid PostgreSQL manifest whose contract disagrees with SourceState', async t => {
  const root = await makeRoot(t);
  const created = await materialize(root);
  const original = JSON.parse(await readFile(join(created.snapshotPath, 'manifest.json'), 'utf8'));
  const { snapshotId: _oldSnapshotId, ...semanticBase } = original;
  const semantic = { ...semanticBase, contractId: OTHER_CONTRACT_ID };
  const snapshotId = sha256Canonical(MATERIALIZED_SNAPSHOT_ALGORITHM, semantic);
  const forgedPath = join(root, snapshotId.slice('sha256:'.length));
  await mkdir(join(forgedPath, 'chunks'), { recursive: true });
  for (const chunk of original.chunks) {
    await copyFile(join(created.snapshotPath, 'chunks', chunk.file), join(forgedPath, 'chunks', chunk.file));
  }
  await writeFile(join(forgedPath, 'manifest.json'), `${canonicalJson({ ...semantic, snapshotId })}\n`, 'utf8');

  await assert.rejects(
    () => loadMaterializedSnapshot({ snapshotDir: root, snapshotId }),
    error => error?.code === 'SOURCE_SNAPSHOT_CONTRACT_MISMATCH'
  );
});

test('concurrent identical materializations converge on one verified immutable snapshot', async t => {
  const root = await makeRoot(t);
  const sourceState = postgresSourceState();
  const results = await Promise.all(Array.from({ length: 16 }, () => materialize(root, sourceState)));
  const ids = new Set(results.map(result => result.snapshot.snapshotId));
  const paths = new Set(results.map(result => result.snapshotPath));
  assert.equal(ids.size, 1);
  assert.equal(paths.size, 1);
  assert.ok(results.every(result => result.snapshot.rowCount === rows.length));

  const entries = await readdir(root);
  assert.equal(entries.filter(name => name.startsWith('.materialize-')).length, 0);
  assert.equal(entries.filter(name => !name.startsWith('.')).length, 1);
  await loadMaterializedSnapshot({ snapshotDir: root, snapshotId: results[0].snapshot.snapshotId });
});
