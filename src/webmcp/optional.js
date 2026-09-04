import { TemporalRegistry } from './registry.js';

export async function initializeOptionalWebMcp({ modelContext, kernel }) {
  if (!modelContext?.registerTool) {
    return { registry: null, status: 'WebMCP API not exposed by this browser', error: null };
  }

  const registry = new TemporalRegistry({ modelContext, kernel });
  try {
    await registry.sync(kernel.snapshot().job.phase);
    return { registry, status: 'Native WebMCP registry active', error: null };
  } catch (error) {
    registry.dispose();
    return {
      registry: null,
      status: 'WebMCP registration unavailable; Studio remains fully usable',
      error: error?.message || String(error)
    };
  }
}
