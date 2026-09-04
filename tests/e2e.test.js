import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandKernel } from '../src/core/command-kernel.js';
import { MemoryWorkspaceStore } from '../src/storage/memory.js';
import { processChunk } from '../src/runtime/worker-protocol.js';
import { createDemoCsv, demoTargetSchema, demoMapping } from '../src/core/demo.js';
import { PHASES } from '../src/core/state-machine.js';

class InlineChunkRuntime {
  constructor() { this.aborted = false; }
  async start(payload, handlers) {
    this.aborted = false;
    queueMicrotask(async () => {
      try {
        for (let i = payload.startIndex; i < payload.rows.length && !this.aborted; i += payload.chunkSize) {
          const rows = payload.rows.slice(i, i + payload.chunkSize);
          handlers.onProgress(processChunk({ rows, mapping: payload.mapping, targetSchema: payload.targetSchema, revision: payload.revision, startIndex: i }));
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!this.aborted) handlers.onComplete({ totalRows: payload.rows.length });
      } catch (error) { handlers.onError(error); }
    });
  }
  async pause() { this.aborted = true; }
  async abort() { this.aborted = true; }
}

async function waitFor(fn, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timeout');
}

test('complete product command chain migrates real dirty demo rows to durable terminal state', async () => {
  const store = new MemoryWorkspaceStore();
  const kernel = new CommandKernel({ store, runtime: new InlineChunkRuntime() });
  await kernel.initialize();
  await kernel.loadSourceText(createDemoCsv(5000), 'demo.csv');
  assert.equal(kernel.snapshot().job.phase, PHASES.SOURCE_READY);
  assert.equal((await kernel.invoke('define_target_schema', { fields: demoTargetSchema() })).ok, true);
  assert.equal((await kernel.invoke('set_mapping', { mapping: demoMapping() })).ok, true);
  assert.equal((await kernel.invoke('validate_mapping', {})).ok, true);
  const preview = await kernel.invoke('preview_migration', { limit: 100 });
  assert.equal(preview.ok, true);
  assert.equal((await kernel.invoke('start_migration', {})).ok, true);
  await waitFor(() => kernel.snapshot().job.phase === PHASES.COMPLETE);
  await kernel.whenRuntimeIdle();
  const state = kernel.snapshot();
  assert.equal(state.job.processedRows, 5000);
  assert.ok(state.job.validRows > 4900);
  assert.ok(state.job.invalidRows > 0);
  assert.equal(state.outputRevision, state.mappingRevision);
  assert.equal(state.output.length, state.job.validRows);
  const csv = await kernel.invoke('export_csv', {});
  assert.equal(csv.ok, true);
  assert.match(csv.result.content, /^customer_id,/);
  const persisted = await store.load();
  assert.equal(persisted.job.phase, PHASES.COMPLETE);
  assert.equal(persisted.output.length, state.output.length);
});

test('Autopilot completes the 5k dirty demo end-to-end with no manual schema or mapping commands', async () => {
  const store = new MemoryWorkspaceStore();
  const kernel = new CommandKernel({ store, runtime: new InlineChunkRuntime() });
  await kernel.initialize();
  await kernel.loadSourceText(createDemoCsv(5000), 'autopilot-demo.csv');

  const started = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(started.ok, true);
  assert.equal(started.state.phase, PHASES.RUNNING);
  assert.equal(kernel.snapshot().mappingRevision, 1);
  assert.equal(kernel.snapshot().targetSchemaRevision, 1);
  assert.equal(kernel.snapshot().mission.interventions, 0);

  await waitFor(() => kernel.snapshot().job.phase === PHASES.COMPLETE);
  await kernel.whenRuntimeIdle();
  const state = kernel.snapshot();
  assert.equal(state.mission.status, 'COMPLETE');
  assert.equal(state.job.processedRows, 5000);
  assert.ok(state.job.validRows > 4900);
  assert.ok(state.job.invalidRows > 0);
  assert.equal(state.outputRevision, 1);
  assert.equal(state.output.length, state.job.validRows);

  const result = await kernel.invoke('export_json', {});
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.result.content).length, state.job.validRows);
});
