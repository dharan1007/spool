import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporalRegistry, toolNamesForPhase } from '../src/webmcp/registry.js';
import { PHASES } from '../src/core/state-machine.js';

class FakeModelContext {
  constructor() { this.active = new Map(); this.events = 0; }
  async registerTool(tool, options = {}) {
    this.active.set(tool.name, tool);
    options.signal?.addEventListener('abort', () => { this.active.delete(tool.name); this.events++; }, { once: true });
  }
}

class DelayedModelContext extends FakeModelContext {
  constructor(delayedToolName) {
    super();
    this.delayedToolName = delayedToolName;
    this.started = new Promise(resolve => { this.resolveStarted = resolve; });
    this.release = null;
    this.gate = new Promise(resolve => { this.release = resolve; });
  }

  async registerTool(tool, options = {}) {
    if (tool.name === this.delayedToolName) {
      this.resolveStarted();
      await this.gate;
    }
    return super.registerTool(tool, options);
  }
}

test('phase exposes only valid temporal tool surface', () => {
  assert.deepEqual(toolNamesForPhase(PHASES.EMPTY), ['describe_supported_formats', 'inspect_workspace']);
  assert.ok(toolNamesForPhase(PHASES.RUNNING).includes('pause_run'));
  assert.ok(!toolNamesForPhase(PHASES.RUNNING).includes('set_mapping'));
});

test('registry aborts stale tools when phase changes', async () => {
  const modelContext = new FakeModelContext();
  const kernel = { invoke: async (name, args) => ({ ok: true, name, args }) };
  const registry = new TemporalRegistry({ modelContext, kernel });
  await registry.sync(PHASES.EMPTY);
  assert.deepEqual([...modelContext.active.keys()].sort(), ['describe_supported_formats', 'inspect_workspace']);
  await registry.sync(PHASES.SOURCE_READY);
  assert.ok(!modelContext.active.has('describe_supported_formats'));
  assert.ok(modelContext.active.has('inspect_source_schema'));
  assert.equal(modelContext.events, 1);
});

test('newer phase wins when an older native registration resolves late', async () => {
  const modelContext = new DelayedModelContext('describe_supported_formats');
  const kernel = { invoke: async () => ({ ok: true }) };
  const changes = [];
  const registry = new TemporalRegistry({ modelContext, kernel, onChange: change => changes.push(change) });

  const staleSync = registry.sync(PHASES.EMPTY);
  await modelContext.started;
  const currentSync = registry.sync(PHASES.SOURCE_READY);
  modelContext.release();

  await Promise.all([staleSync, currentSync]);

  assert.equal(registry.phase, PHASES.SOURCE_READY);
  assert.ok(!modelContext.active.has('describe_supported_formats'));
  assert.deepEqual([...modelContext.active.keys()].sort(), toolNamesForPhase(PHASES.SOURCE_READY));
  assert.equal(changes.at(-1).phase, PHASES.SOURCE_READY);
});

test('registered execute delegates to the shared command kernel', async () => {
  const calls = [];
  const modelContext = new FakeModelContext();
  const kernel = { invoke: async (name, args) => { calls.push([name, args]); return { ok: true }; } };
  const registry = new TemporalRegistry({ modelContext, kernel });
  await registry.sync(PHASES.EMPTY);
  await modelContext.active.get('inspect_workspace').execute({ verbose: true });
  assert.deepEqual(calls, [['inspect_workspace', { verbose: true }]]);
});
