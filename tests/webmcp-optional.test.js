import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeOptionalWebMcp } from '../src/webmcp/optional.js';
import { PHASES } from '../src/core/state-machine.js';

test('optional WebMCP absence does not block the application', async () => {
  const result = await initializeOptionalWebMcp({
    modelContext: null,
    kernel: { snapshot: () => ({ job: { phase: PHASES.EMPTY } }), invoke: async () => ({ ok: true }) }
  });
  assert.equal(result.registry, null);
  assert.match(result.status, /not exposed/i);
});

test('optional WebMCP registration failure is contained instead of failing app boot', async () => {
  const modelContext = {
    async registerTool() { throw new TypeError('experimental API rejected registration'); }
  };
  const result = await initializeOptionalWebMcp({
    modelContext,
    kernel: { snapshot: () => ({ job: { phase: PHASES.EMPTY } }), invoke: async () => ({ ok: true }) }
  });
  assert.equal(result.registry, null);
  assert.match(result.status, /unavailable/i);
  assert.match(result.error, /experimental API rejected registration/);
});
