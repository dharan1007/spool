import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandKernel } from '../src/core/command-kernel.js';
import { MemoryWorkspaceStore } from '../src/storage/memory.js';
import { PHASES } from '../src/core/state-machine.js';

class ControlledRuntime {
  constructor() { this.startCalls = []; this.pauseCalls = 0; this.abortCalls = 0; }
  async start(payload, handlers) { this.startCalls.push({ payload, handlers }); }
  async pause() { this.pauseCalls++; }
  async abort() { this.abortCalls++; }
}

const target = [{ name: 'id', type: 'string' }, { name: 'fee_cents', type: 'number' }];
const mapping1 = [
  { target: 'id', expr: { op: 'trim', value: { op: 'field', name: 'id' } } },
  { target: 'fee_cents', expr: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'fee' } }, right: { op: 'literal', value: 100 } } }
];
const mapping2 = [
  { target: 'id', expr: { op: 'uppercase', value: { op: 'field', name: 'id' } } },
  { target: 'fee_cents', expr: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'fee' } }, right: { op: 'literal', value: 100 } } }
];

async function readyKernel() {
  const store = new MemoryWorkspaceStore();
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store, runtime });
  await kernel.initialize();
  await kernel.loadSourceText('id,fee\n a ,2.50\nb,3.00', 'input.csv');
  await kernel.invoke('define_target_schema', { fields: target });
  await kernel.invoke('set_mapping', { mapping: mapping1 });
  await kernel.invoke('validate_mapping', {});
  return { kernel, store, runtime };
}

test('UI source load and WebMCP commands share one durable workspace', async () => {
  const { kernel, store } = await readyKernel();
  assert.equal(kernel.snapshot().job.phase, PHASES.MAPPING_VALID);
  const persisted = await store.load();
  assert.equal(persisted.job.phase, PHASES.MAPPING_VALID);
  assert.equal(persisted.source.rows.length, 2);
  assert.equal(persisted.mappingRevision, 1);
});

test('kernel returns typed envelope and valid next actions on invalid phase', async () => {
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime: new ControlledRuntime() });
  await kernel.initialize();
  const response = await kernel.invoke('start_migration', {});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_PHASE');
  assert.deepEqual(response.nextValidActions, ['describe_supported_formats', 'inspect_workspace']);
});

test('start, pause, revise and resume forces replay from row zero at newest revision', async () => {
  const { kernel, runtime } = await readyKernel();
  const started = await kernel.invoke('start_migration', {});
  assert.equal(started.state.phase, PHASES.RUNNING);
  assert.equal(runtime.startCalls[0].payload.startIndex, 0);

  runtime.startCalls[0].handlers.onProgress({ processedRows: 1, validRows: 1, invalidRows: 0, outputChunk: [{ id: 'a', fee_cents: 250 }], violations: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  await kernel.invoke('pause_run', {});
  assert.equal(kernel.snapshot().job.phase, PHASES.PAUSED);

  const revised = await kernel.invoke('revise_mapping', { mapping: mapping2 });
  assert.equal(revised.ok, true);
  assert.equal(kernel.snapshot().mappingRevision, 2);
  assert.equal(kernel.snapshot().needsReplay, true);

  await kernel.invoke('resume_run', {});
  assert.equal(runtime.startCalls.length, 2);
  assert.equal(runtime.startCalls[1].payload.startIndex, 0);
  assert.equal(runtime.startCalls[1].payload.revision, 2);
  assert.equal(kernel.snapshot().job.phase, PHASES.REPLAYING);
});

test('refresh recovery converts orphan RUNNING job to PAUSED_RECOVERED', async () => {
  const { kernel, store } = await readyKernel();
  await kernel.invoke('start_migration', {});
  const recovered = new CommandKernel({ store, runtime: new ControlledRuntime() });
  await recovered.initialize();
  assert.equal(recovered.snapshot().job.phase, PHASES.PAUSED_RECOVERED);
});

test('runtime progress and completion are serialized even when callbacks arrive back-to-back', async () => {
  const { kernel, runtime } = await readyKernel();
  await kernel.invoke('start_migration', {});
  const { handlers } = runtime.startCalls[0];
  handlers.onProgress({ processedRows: 1, validRows: 1, invalidRows: 0, outputChunk: [{ id: 'a', fee_cents: 250 }], violations: [] });
  handlers.onProgress({ processedRows: 1, validRows: 1, invalidRows: 0, outputChunk: [{ id: 'b', fee_cents: 300 }], violations: [] });
  handlers.onComplete({ processedThrough: 2, totalRows: 2 });
  await kernel.whenRuntimeIdle();
  assert.equal(kernel.snapshot().job.phase, PHASES.COMPLETE);
  assert.equal(kernel.snapshot().job.processedRows, 2);
  assert.deepEqual(kernel.snapshot().output.map(r => r.id), ['a', 'b']);
});

test('inspect_workspace returns workflow metadata without dumping source or output rows', async () => {
  const { kernel } = await readyKernel();
  const response = await kernel.invoke('inspect_workspace', {});
  assert.equal(response.ok, true);
  assert.equal(response.result.source.rows, 2);
  assert.equal(response.result.source.fileName, 'input.csv');
  assert.equal(Object.hasOwn(response.result.source, 'sample'), false);
  assert.equal(Object.hasOwn(response.result, 'output'), false);
});

test('loading a replacement source aborts the active runtime before resetting workspace', async () => {
  const { kernel, runtime } = await readyKernel();
  await kernel.invoke('start_migration', {});
  const before = runtime.abortCalls;

  await kernel.loadSourceText('id,fee\nnew,9.99', 'replacement.csv');

  assert.equal(runtime.abortCalls, before + 1);
  assert.equal(kernel.snapshot().job.phase, PHASES.SOURCE_READY);
  assert.equal(kernel.snapshot().source.fileName, 'replacement.csv');
});

test('invalid replacement source does not abort or corrupt the active migration', async () => {
  const { kernel, runtime } = await readyKernel();
  await kernel.invoke('start_migration', {});
  const before = runtime.abortCalls;
  const jobId = kernel.snapshot().job.jobId;

  await assert.rejects(() => kernel.loadSourceText('id,id\n1,2', 'broken.csv'));

  assert.equal(runtime.abortCalls, before);
  assert.equal(kernel.snapshot().job.phase, PHASES.RUNNING);
  assert.equal(kernel.snapshot().job.jobId, jobId);
  assert.equal(kernel.snapshot().source.fileName, 'input.csv');
});

test('header-only replacement is rejected before aborting an active migration', async () => {
  const { kernel, runtime } = await readyKernel();
  await kernel.invoke('start_migration', {});
  const beforeAbortCalls = runtime.abortCalls;
  const before = kernel.snapshot();

  await assert.rejects(
    () => kernel.loadSourceText('id,fee\n', 'empty.csv'),
    error => error?.code === 'EMPTY_SOURCE_ROWS'
  );

  const after = kernel.snapshot();
  assert.equal(runtime.abortCalls, beforeAbortCalls);
  assert.equal(after.job.phase, PHASES.RUNNING);
  assert.equal(after.job.jobId, before.job.jobId);
  assert.equal(after.source.fileName, before.source.fileName);
});
