import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MATERIALIZED_SNAPSHOT_ALGORITHM,
  loadMaterializedSnapshot,
  materializeSnapshotBatches,
  streamMaterializedRows
} from '../src/connectors/materialized-snapshot.js';

const SOURCE_STATE_ID = `sha256:${'1'.repeat(64)}`;
const CONTRACT_ID = `sha256:${'2'.repeat(64)}`;
const OTHER_SOURCE_STATE_ID = `sha256:${'3'.repeat(64)}`;
const sourceState = Object.freeze({ connector: 'postgres', sourceStateId: SOURCE_STATE_ID, marker: 'snapshot-a' });
const contract = Object.freeze({ schemaVersion: 1, columns: [{ name: 'id' }, { name: 'name' }], primaryKey: ['id'] });
const rows = Object.freeze([
  Object.freeze({ id: 1, name: 'alpha' }),
  Object.freeze({ id: 2, name: 'beta' }),
  Object.freeze({ id: 3, name: 'gamma' }),
  Object.freeze({ id: 4, name: 'delta' }),
  Object.freeze({ id: 5, name: 'epsilon' })
]);

async function* batches(stateId = SOURCE_STATE_ID, inputRows = rows) {
  yield Object.freeze({
    sourceStateId: stateId,
    sourceRange: Object.freeze({ start: 0, endExclusive: Math.min(2, inputRows.length) }),
    rows: Object.freeze(inputRows.slice(0, 2))
  });
  if (inputRows.length > 2) {
    yield Object.freeze({
      sourceStateId: stateId,
      sourceRange: Object.freeze({ start: 2, endExclusive: inputRows.length }),
      rows: Object.freeze(inputRows.slice(2))
    });
  }
}

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'spool-materialized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function collect(materialized) {
  const output = [];
  for await (const item of streamMaterializedRows(materialized)) output.push(item);
  return output;
}

test('materialized snapshot deterministically binds chunks, accounting, SourceState and exact replay', async t => {
  const root = await makeRoot(t);
  const first = await materializeSnapshotBatches({
    snapshotDir: root,
    sourceState,
    contract,
    contractId: CONTRACT_ID,
    sourceIdentity: { connector: 'postgres', resource: 'orders' },
    batches: batches(),
    chunkRows: 2
  });

  assert.equal(first.snapshot.snapshotAlgorithm, MATERIALIZED_SNAPSHOT_ALGORITHM);
  assert.match(first.snapshot.snapshotId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.snapshot.sourceStateId, SOURCE_STATE_ID);
  assert.equal(first.snapshot.contractId, CONTRACT_ID);
  assert.equal(first.snapshot.rowCount, 5);
  assert.equal(first.snapshot.chunks.length, 3);
  assert.deepEqual(first.snapshot.chunks.map(chunk => chunk.sourceRange), [
    { start: 0, endExclusive: 2 },
    { start: 2, endExclusive: 4 },
    { start: 4, endExclusive: 5 }
  ]);

  const replayed = await collect(first);
  assert.deepEqual(replayed.map(item => item.rowIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(replayed.map(item => item.row), rows);

  const manifestText = await readFile(join(first.snapshotPath, 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(manifestText).snapshotId, first.snapshot.snapshotId);
  assert.doesNotMatch(manifestText, /password|token|secretRef/i);

  const second = await materializeSnapshotBatches({
    snapshotDir: root,
    sourceState,
    contract,
    contractId: CONTRACT_ID,
    sourceIdentity: { connector: 'postgres', resource: 'orders' },
    batches: batches(),
    chunkRows: 2
  });
  assert.equal(second.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal(second.snapshotPath, first.snapshotPath);
  assert.equal(second.reused, true);
});

test('loading a finalized materialized snapshot independently detects chunk corruption', async t => {
  const root = await makeRoot(t);
  const created = await materializeSnapshotBatches({
    snapshotDir: root,
    sourceState,
    contract,
    contractId: CONTRACT_ID,
    batches: batches(),
    chunkRows: 2
  });
  const firstChunk = join(created.snapshotPath, 'chunks', created.snapshot.chunks[0].file);
  await writeFile(firstChunk, '{"id":999,"name":"tampered"}\n', 'utf8');

  await assert.rejects(
    () => loadMaterializedSnapshot({ snapshotDir: root, snapshotId: created.snapshot.snapshotId }),
    error => error?.code === 'SOURCE_SNAPSHOT_CORRUPT'
  );
});

test('materialization fails closed when a batch belongs to another SourceState', async t => {
  const root = await makeRoot(t);
  await assert.rejects(
    () => materializeSnapshotBatches({
      snapshotDir: root,
      sourceState,
      contract,
      contractId: CONTRACT_ID,
      batches: batches(OTHER_SOURCE_STATE_ID)
    }),
    error => error?.code === 'SOURCE_DRIFT'
  );
});

test('interrupted materialization removes untrusted partial state and publishes no finalized snapshot', async t => {
  const root = await makeRoot(t);
  async function* interrupted() {
    yield Object.freeze({
      sourceStateId: SOURCE_STATE_ID,
      sourceRange: Object.freeze({ start: 0, endExclusive: 2 }),
      rows: Object.freeze(rows.slice(0, 2))
    });
    throw Object.assign(new Error('injected acquisition failure'), { code: 'INJECTED_SOURCE_FAILURE' });
  }

  await assert.rejects(
    () => materializeSnapshotBatches({
      snapshotDir: root,
      sourceState,
      contract,
      contractId: CONTRACT_ID,
      batches: interrupted(),
      chunkRows: 1
    }),
    error => error?.code === 'INJECTED_SOURCE_FAILURE'
  );
  assert.deepEqual(await readdir(root), []);
});
