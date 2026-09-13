import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModule() {
  try {
    return await import('../src/connectors/materialized-snapshot.js');
  } catch (error) {
    assert.fail(`materialized snapshot module must load: ${error?.code ?? error?.message}`);
  }
}

test('materialized snapshot module exposes create/load/replay operations', async () => {
  const module = await loadModule();
  assert.equal(typeof module.materializeSnapshotBatches, 'function');
  assert.equal(typeof module.loadMaterializedSnapshot, 'function');
  assert.equal(typeof module.streamMaterializedRows, 'function');
});
