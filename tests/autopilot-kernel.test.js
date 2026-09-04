import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandKernel } from '../src/core/command-kernel.js';
import { MemoryWorkspaceStore } from '../src/storage/memory.js';
import { processChunk } from '../src/runtime/worker-protocol.js';
import { PHASES } from '../src/core/state-machine.js';

class ControlledRuntime {
  constructor() { this.startCalls = []; this.abortCalls = 0; }
  async start(payload, handlers) { this.startCalls.push({ payload, handlers }); }
  async pause() {}
  async abort() { this.abortCalls += 1; }
}

class InlineRuntime {
  constructor() { this.aborted = false; }
  async start(payload, handlers) {
    this.aborted = false;
    queueMicrotask(async () => {
      for (let i = payload.startIndex; i < payload.rows.length && !this.aborted; i += payload.chunkSize) {
        handlers.onProgress(processChunk({
          rows: payload.rows.slice(i, i + payload.chunkSize),
          mapping: payload.mapping,
          targetSchema: payload.targetSchema,
          revision: payload.revision,
          startIndex: i
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!this.aborted) handlers.onComplete({ totalRows: payload.rows.length });
    });
  }
  async pause() { this.aborted = true; }
  async abort() { this.aborted = true; }
}

async function waitFor(fn, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

test('run_autopilot plans, dry-runs and starts migration without manual schema or mapping commands', async () => {
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime });
  await kernel.initialize();
  const rows = Array.from({ length: 100 }, (_, i) => `${i + 1},${i === 42 ? 'bad' : `${19 + i}.50`},2026-01-${String((i % 27) + 1).padStart(2, '0')},${i % 2 === 0}`);
  await kernel.loadSourceText(`Customer ID,monthly_fee,joined,is_active\n${rows.join('\n')}`, 'customers.csv');

  const result = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });

  assert.equal(result.ok, true);
  assert.equal(result.state.phase, PHASES.RUNNING);
  assert.equal(runtime.startCalls.length, 1);
  const state = kernel.snapshot();
  assert.equal(state.targetSchemaRevision, 1);
  assert.equal(state.mappingRevision, 1);
  assert.equal(state.mission.status, 'RUNNING');
  assert.equal(state.mission.outcome, 'database_ready');
  assert.ok(state.mission.evidence.length >= 4);
  assert.ok(state.mission.dryRun.processedRows > 0);
  assert.equal(state.mission.interventions, 0);
});

test('run_autopilot fails closed on destructive ambiguity and exposes one bounded mission decision', async () => {
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime });
  await kernel.initialize();
  await kernel.loadSourceText('Customer ID,customer-id\na,b\nc,d', 'collision.csv');

  const result = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });

  assert.equal(result.ok, true);
  assert.equal(result.state.phase, PHASES.SOURCE_READY);
  assert.equal(runtime.startCalls.length, 0);
  assert.equal(kernel.snapshot().mission.status, 'NEEDS_ATTENTION');
  assert.equal(kernel.snapshot().mission.ambiguities.length, 1);
  assert.equal(kernel.snapshot().mission.interventions, 1);
  const inspected = await kernel.invoke('inspect_mission', {});
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.status, 'NEEDS_ATTENTION');
  assert.equal(Object.hasOwn(inspected.result, 'sourceRows'), false);
});

test('autopilot terminal mission becomes COMPLETE after worker execution with dirty rows grouped as quality violations', async () => {
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime: new InlineRuntime() });
  await kernel.initialize();
  const rows = Array.from({ length: 500 }, (_, i) => `${i + 1},${i === 100 ? 'not-a-number' : `${10 + i}.25`},${i === 200 ? 'bad-date' : `2026-04-${String((i % 27) + 1).padStart(2, '0')}`}`);
  await kernel.loadSourceText(`id,amount,joined\n${rows.join('\n')}`, 'dirty.csv');
  const start = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(start.ok, true);
  await waitFor(() => kernel.snapshot().job.phase === PHASES.COMPLETE);
  await kernel.whenRuntimeIdle();
  const state = kernel.snapshot();
  assert.equal(state.mission.status, 'COMPLETE');
  assert.equal(state.job.processedRows, 500);
  assert.ok(state.job.validRows >= 498);
  assert.ok(state.job.invalidRows >= 1);
  assert.ok(state.violations.length >= 1);
});

test('autopilot refresh recovery resumes from the durable checkpoint automatically', async () => {
  const store = new MemoryWorkspaceStore();
  const firstRuntime = new ControlledRuntime();
  const first = new CommandKernel({ store, runtime: firstRuntime });
  await first.initialize();
  const rows = Array.from({ length: 100 }, (_, i) => `${i + 1},${10 + i}.25,2026-05-${String((i % 27) + 1).padStart(2, '0')}`);
  await first.loadSourceText(`id,amount,joined\n${rows.join('\n')}`, 'recover.csv');
  const started = await first.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(started.state.phase, PHASES.RUNNING);

  firstRuntime.startCalls[0].handlers.onProgress({
    processedRows: 20,
    validRows: 20,
    invalidRows: 0,
    outputChunk: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), amount: 10.25 + i, joined: `2026-05-${String((i % 27) + 1).padStart(2, '0')}` })),
    violations: []
  });
  await first.whenRuntimeIdle();
  assert.equal(first.snapshot().job.checkpoint, 20);

  const recoveryRuntime = new ControlledRuntime();
  const recovered = new CommandKernel({ store, runtime: recoveryRuntime });
  await recovered.initialize();

  assert.equal(recovered.snapshot().job.phase, PHASES.RUNNING);
  assert.equal(recovered.snapshot().mission.status, 'RUNNING');
  assert.equal(recoveryRuntime.startCalls.length, 1);
  assert.equal(recoveryRuntime.startCalls[0].payload.startIndex, 20);
});
