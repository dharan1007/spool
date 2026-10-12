import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDbWorkspaceStore, markWorkspaceStorageFailure } from '../src/storage/indexeddb.js';
import { CommandKernel } from '../src/core/command-kernel.js';
import { createJob, transition, PHASES } from '../src/core/state-machine.js';
import { fail } from '../src/core/errors.js';

test('a newer source selection supersedes cooperative parsing before any old source publishes', async () => {
  let durable = null;
  const store = { load: async () => null, preflight: async () => ({ supported: true }), save: async workspace => { durable = structuredClone(workspace); } };
  const kernel = new CommandKernel({ store, runtime: { start: async () => {}, abort: async () => {} } });
  await kernel.initialize();
  const older = kernel.loadSourceText('id,name\n' + '1,Earlier\n'.repeat(10000), 'earlier.csv');
  const newer = kernel.loadSourceText('id,name\n2,Latest\n', 'latest.csv');
  const results = await Promise.allSettled([older, newer]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'SOURCE_LOAD_SUPERSEDED');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(kernel.snapshot().source.fileName, 'latest.csv');
  assert.equal(durable.source.fileName, 'latest.csv');
  assert.equal(durable.source.rows[0].name, 'Latest');
});

test('public checkpoint and output remain at committed state while progress persistence is pending', async () => {
  let hold = false;
  let release;
  const store = { load: async () => null, preflight: async () => ({ supported: true }), save: async () => {
    if (hold) await new Promise(resolve => { release = resolve; });
  } };
  const kernel = new CommandKernel({ store, runtime: { start: async () => {}, abort: async () => {} } });
  await kernel.initialize();
  await kernel.loadSourceText('id\n1\n');
  await kernel.invoke('define_target_schema', { fields: [{ name: 'id', type: 'integer', nullable: false }] });
  await kernel.invoke('set_mapping', { mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }] });
  await kernel.invoke('validate_mapping');
  assert.equal((await kernel.invoke('start_migration')).ok, true);
  hold = true;
  const pending = kernel.applyProgress({ processedRows: 1, validRows: 1, invalidRows: 0, outputChunk: [{ id: 1 }], violations: [] }, kernel.runEpoch);
  assert.equal(kernel.viewSnapshot().job.checkpoint, 0);
  assert.equal(kernel.snapshot().output.length, 0);
  assert.equal((await kernel.invoke('export_csv')).error.code, 'WORKSPACE_WRITE_PENDING');
  release();
  await pending;
  assert.equal(kernel.viewSnapshot().job.checkpoint, 1);
  assert.equal(kernel.snapshot().output.length, 1);
  const completing = kernel.applyComplete({}, kernel.runEpoch);
  assert.equal(kernel.snapshot().job.phase, PHASES.RUNNING);
  const refused = await kernel.invoke('export_csv');
  assert.equal(refused.ok, false);
  assert.equal(refused.state.phase, PHASES.RUNNING);
  assert.deepEqual(refused.nextValidActions, []);
  release();
  await completing;
  assert.equal(kernel.snapshot().job.phase, PHASES.COMPLETE);
});

test('failed source persistence restores the previous durable workspace and never announces the rejected source', async () => {
  let refuse = false;
  let durable = null;
  const emitted = [];
  const store = { load: async () => durable, save: async workspace => {
    if (refuse) fail('STORAGE_WRITE_FAILED', 'quota write failed');
    durable = structuredClone(workspace);
  } };
  const kernel = new CommandKernel({ store, runtime: { abort: async () => {} }, onStateChange: state => emitted.push(state) });
  await kernel.initialize();
  refuse = true;
  await assert.rejects(kernel.loadSourceText('id,name\n1,Rejected\n', 'rejected.csv'), { code: 'STORAGE_WRITE_FAILED' });
  assert.equal(kernel.snapshot().job.phase, PHASES.EMPTY);
  assert.equal(kernel.snapshot().source, null);
  refuse = false;
  await kernel.loadSourceText('id,name\n1,Ada\n', 'approved.csv');
  const prior = kernel.snapshot();
  refuse = true;
  await assert.rejects(kernel.loadSourceText('id,name\n2,Rejected\n', 'replacement.csv'), { code: 'STORAGE_WRITE_FAILED' });
  assert.deepEqual(kernel.snapshot(), prior);
  assert.equal(durable.source.fileName, 'approved.csv');
  assert.equal(emitted.some(state => state.source?.fileName === 'replacement.csv' || state.source?.fileName === 'rejected.csv'), false);
});

test('browser storage preflight fails before execution when quota headroom is insufficient', async () => {
  const store = new IndexedDbWorkspaceStore({
    storageManager: { estimate: async () => ({ usage: 90, quota: 100 }) },
    writeLock: { acquire: async () => ({ acquired: true }), release: async () => {} }
  });
  await assert.rejects(() => store.preflight(20), /STORAGE_CAPACITY_INSUFFICIENT/);
  const ok = await store.preflight(5);
  assert.equal(ok.availableBytes, 10);
});

test('completion is not left COMPLETE when durable workspace save fails', async () => {
  const store = {
    load: async () => null,
    preflight: async () => ({ supported: true, availableBytes: 1_000_000 }),
    save: async workspace => {
      if (workspace.job.phase === PHASES.COMPLETE) {
        markWorkspaceStorageFailure(workspace);
        fail('STORAGE_WRITE_FAILED', 'quota write failed');
      }
    }
  };
  const runtime = { start: async () => {}, abort: async () => {}, pause: async () => {} };
  const kernel = new CommandKernel({ store, runtime });
  let job = createJob();
  job = transition(job, PHASES.SOURCE_READY, { sourceFingerprint: 'x', totalRows: 1 });
  job = transition(job, PHASES.TARGET_READY, { targetSchemaRevision: 1 });
  job = transition(job, PHASES.MAPPING_DRAFT);
  job = transition(job, PHASES.MAPPING_VALID, { mappingRevision: 1 });
  job = transition(job, PHASES.RUNNING, { processedRows: 1, validRows: 1, invalidRows: 0, checkpoint: 1, mappingRevision: 1 });
  kernel.workspace.job = job;
  kernel.workspace.mappingRevision = 1;
  kernel.workspace.outputRevision = 1;

  await assert.rejects(() => kernel.applyComplete({}, kernel.runEpoch), /STORAGE_WRITE_FAILED/);
  assert.notEqual(kernel.workspace.job.phase, PHASES.COMPLETE);
  assert.equal(kernel.workspace.job.phase, PHASES.FAILED);
  assert.equal(kernel.workspace.lastError.code, 'STORAGE_WRITE_FAILED');
});
