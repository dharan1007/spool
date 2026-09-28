import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandKernel } from '../src/core/command-kernel.js';
import { MemoryWorkspaceStore } from '../src/storage/memory.js';
import { PHASES } from '../src/core/state-machine.js';
import { readFile } from 'node:fs/promises';

class ControlledRuntime {
  constructor() { this.startCalls = []; }
  async start(payload, handlers) { this.startCalls.push({ payload, handlers }); }
  async abort() {}
  async pause() {}
}

async function setup(text) {
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime, snapshotMode: 'ui' });
  await kernel.initialize();
  await kernel.loadSourceText(text, 'recovery.csv');
  return { kernel, runtime };
}

test('91/100 dry-run failure retains the source, shows bounded offending values and never starts a worker', async () => {
  const sourceIndexes = Array.from({ length: 100 }, (_, i) => Math.floor((i * 1999) / 99));
  const badRecords = sourceIndexes.filter(i => i >= 1000).slice(0, 9);
  const bad = new Set(badRecords);
  const rows = Array.from({ length: 2000 }, (_, i) =>
    [i + 1, bad.has(i) ? 'not-a-number' : `${i + 100}.25`, `Customer ${i + 1}`].join(',')
  );
  const { kernel, runtime } = await setup(`Customer ID,amount,Name\n${rows.join('\n')}`);
  const blocked = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  const state = kernel.snapshot();
  assert.equal(blocked.ok, true);
  assert.equal(blocked.result.status, 'NEEDS_ATTENTION');
  assert.equal(state.job.phase, PHASES.SOURCE_READY);
  assert.equal(state.mission.dryRun.validRows, 91);
  assert.equal(state.mission.dryRun.invalidRows, 9);
  assert.equal(state.mission.dryRun.assessment, 'BLOCK');
  assert.equal(state.output.length, 0);
  assert.equal(state.source.rows.length, 2000);
  assert.equal(runtime.startCalls.length, 0);
  const numericViolation = state.mission.dryRun.violationGroups.find(item => item.sourceFields.includes('amount'));
  assert.ok(numericViolation);
  assert.equal(numericViolation.count, 9);
  assert.equal(numericViolation.examples[0].record, badRecords[0] + 1);
  assert.deepEqual(numericViolation.examples[0].fields, [{ field: 'amount', value: 'not-a-number' }]);
  const inspected = await kernel.invoke('inspect_mission', {});
  assert.equal(inspected.result.dryRun.invalidRows, 9);
  assert.ok(!Object.hasOwn(inspected.result, 'sourceRows'));
  const compact = kernel.viewSnapshot();
  assert.equal(compact.source.rows.length, 2000);
  assert.equal(Array.isArray(compact.source.rows), false);
  assert.equal(compact.source.schema, undefined);
  assert.deepEqual(compact.output, []);
  const safe = await kernel.invoke('run_autopilot', { outcome: 'preserve_contract' });
  assert.equal(safe.ok, true);
  assert.equal(safe.state.phase, PHASES.RUNNING);
  assert.equal(runtime.startCalls.length, 1);
  assert.equal(kernel.snapshot().mission.dryRun.invalidRows, 0);
  assert.deepEqual(kernel.snapshot().targetSchema.map(item => item.name), ['Customer ID', 'amount', 'Name']);
});

test('normalized header collision is reversible by an explicit preserve-contract retry', async () => {
  const { kernel, runtime } = await setup('Customer ID,customer-id\na,b\nc,d');
  const first = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(first.ok, true);
  assert.equal(first.result.ambiguities[0].code, 'TARGET_NAME_COLLISION');
  assert.equal(runtime.startCalls.length, 0);
  const second = await kernel.invoke('run_autopilot', { outcome: 'preserve_contract' });
  assert.equal(second.ok, true);
  assert.equal(second.state.phase, PHASES.RUNNING);
  assert.equal(runtime.startCalls.length, 1);
  assert.deepEqual(kernel.snapshot().targetSchema.map(f => f.name), ['Customer ID', 'customer-id']);
});

test('blocked mission interface has recovery controls and preserved diagnostics, not an inert terminal card', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../src/storage/indexeddb.js', import.meta.url), 'utf8');
  for (const needle of ['recoveryPanel(mission, selectedOutcome)', 'data-action="retry-autopilot"', 'quality-diagnostics', 'Correct or replace CSV', 'data-route="/studio"', 'snapshotMode: \'ui\'', 'isBusy']) {
    assert.ok(app.includes(needle), `missing recovery contract: ${needle}`);
  }
  assert.ok(styles.includes('.recovery-outcomes'));
  assert.ok(styles.includes('.quality-examples'));
  assert.ok(!storage.includes('structuredClone(workspace);\n      if (compact.source) delete compact.source.rows'));
});

test('Worker startup failures terminate the mission instead of leaving an inert RUNNING screen', async () => {
  const { kernel, runtime } = await setup('id,amount\\n1,10.25\\n2,20.50');
  runtime.start = async () => { throw new Error('Worker unavailable'); };
  const result = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(result.ok, false);
  assert.equal(result.state.phase, PHASES.FAILED);
  assert.equal(kernel.snapshot().job.phase, PHASES.FAILED);
  assert.equal(kernel.snapshot().mission.status, 'FAILED');
  assert.match(kernel.snapshot().lastError.message, /Worker unavailable/);
  const reset = await kernel.invoke('start_new_migration', {});
  assert.equal(reset.ok, true);
  assert.equal(reset.state.phase, PHASES.EMPTY);
});

test('checkpoint write failure fails the run visibly instead of poisoning all subsequent Worker events', async () => {
  let saved = null;
  const store = {
    async load() { return saved ? structuredClone(saved) : null; },
    async save(workspace) {
      if (workspace.job.phase === PHASES.RUNNING && workspace.job.processedRows > 0) {
        throw new Error('simulated checkpoint failure');
      }
      saved = structuredClone(workspace);
    }
  };
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store, runtime });
  await kernel.initialize();
  await kernel.loadSourceText('id,amount\\n1,10.25\\n2,20.50', 'small.csv');
  const started = await kernel.invoke('run_autopilot', { outcome: 'database_ready' });
  assert.equal(started.ok, true);
  runtime.startCalls[0].handlers.onProgress({
    processedRows: 1, validRows: 1, invalidRows: 0,
    outputChunk: [{ id: 1, amount: 10.25 }], violations: []
  });
  await kernel.whenRuntimeIdle();
  assert.equal(kernel.snapshot().job.phase, PHASES.FAILED);
  assert.match(kernel.snapshot().lastError.message, /checkpoint failure/);
  assert.equal(kernel.snapshot().mission.status, 'FAILED');
  assert.equal(saved.job.phase, PHASES.FAILED);
  assert.equal((await kernel.invoke('start_new_migration', {})).ok, true);
});
