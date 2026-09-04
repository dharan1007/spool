import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceWriteLock } from '../src/storage/workspace-lock.js';

class SharedMockLockManager {
  constructor() {
    this.held = new Set();
  }

  async request(name, options, callback) {
    assert.equal(options.mode, 'exclusive');
    assert.equal(options.ifAvailable, true);
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
}

test('only one tab can hold the durable workspace writer lock at a time', async () => {
  const manager = new SharedMockLockManager();
  const first = new WorkspaceWriteLock({ lockManager: manager });
  const second = new WorkspaceWriteLock({ lockManager: manager });

  const firstResult = await first.acquire();
  const secondResult = await second.acquire();

  assert.deepEqual(firstResult, { acquired: true, supported: true });
  assert.deepEqual(secondResult, { acquired: false, supported: true });

  await first.release();
  assert.deepEqual(await second.acquire(), { acquired: true, supported: true });
  await second.release();
});

test('lock acquisition is idempotent within one tab', async () => {
  const manager = new SharedMockLockManager();
  const lock = new WorkspaceWriteLock({ lockManager: manager });

  assert.deepEqual(await lock.acquire(), { acquired: true, supported: true });
  assert.deepEqual(await lock.acquire(), { acquired: true, supported: true });
  await lock.release();
});

test('unsupported Web Locks preserves existing single-tab behavior without inventing a network dependency', async () => {
  const lock = new WorkspaceWriteLock({ lockManager: null });
  assert.deepEqual(await lock.acquire(), { acquired: true, supported: false });
  await lock.release();
});
