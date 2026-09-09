import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDbWorkspaceStore } from '../src/storage/indexeddb.js';
import { CommandKernel } from '../src/core/command-kernel.js';
import { createJob, transition, PHASES } from '../src/core/state-machine.js';

test('browser storage preflight fails before execution when quota headroom is insufficient', async () => {
  const store = new IndexedDbWorkspaceStore({
    storageManager: { estimate: async () => ({ usage: 90, quota: 100 }) },
    writeLock: { acquire: async () => ({ acquired: true }), release: async () => {} }
  });
  await assert.rejects(() => store.preflight(20), /STORAGE_CAPACITY_INSUFFICIENT/);
  const ok = await store.preflight(5);
  assert.equal(ok.availableBytes, 10);
});

test('completion is not published when durable workspace save fails', async () => {
  const store = {
    load: async () => null,
    preflight: async () => ({ supported: true, availableBytes: 1_000_000 }),
    save: async workspace => {
      if (workspace.job.phase === PHASES.COMPLETE) throw new Error('quota write failed');
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

  await kernel.applyComplete({}, kernel.runEpoch);
  assert.notEqual(kernel.workspace.job.phase, PHASES.COMPLETE);
  assert.equal(kernel.workspace.job.phase, PHASES.FAILED);
  assert.equal(kernel.workspace.lastError.code, 'STORAGE_WRITE_FAILED');
});
