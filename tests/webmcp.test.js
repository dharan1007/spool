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

test('registered execute delegates to the shared command kernel', async () => {
  const calls = [];
  const modelContext = new FakeModelContext();
  const kernel = { invoke: async (name, args) => { calls.push([name, args]); return { ok: true }; } };
  const registry = new TemporalRegistry({ modelContext, kernel });
  await registry.sync(PHASES.EMPTY);
  await modelContext.active.get('inspect_workspace').execute({ verbose: true });
  assert.deepEqual(calls, [['inspect_workspace', { verbose: true }]]);
});
