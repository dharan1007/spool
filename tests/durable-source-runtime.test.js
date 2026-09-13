import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModule() {
  try {
    return await import('../src/daemon/durable-source.js');
  } catch (error) {
    assert.fail(`durable source coordinator must load: ${error?.code ?? error?.message}`);
  }
}

test('durable source coordinator exposes filesystem and PostgreSQL preparation boundary', async () => {
  const module = await loadModule();
  assert.equal(typeof module.createDurableSourceCoordinator, 'function');
});
