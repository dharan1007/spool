import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LeaseStore } from '../src/execution/lease-store.js';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-lease-'));
  const path = join(dir, 'leases.db');
  const store = new LeaseStore({ path });
  try { await fn(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

test('lease fencing tokens are monotonic and stale runners cannot mutate after takeover', async () => {
  await withStore(async store => {
    const first = store.acquire({ resource: 'sqlite:customers', owner: 'runner-a', ttlMs: 100, nowMs: 1000 });
    assert.equal(first.fencingToken, 1);
    assert.equal(store.assertFence({ resource: first.resource, fencingToken: first.fencingToken, nowMs: 1050 }), true);
    assert.throws(
      () => store.acquire({ resource: first.resource, owner: 'runner-b', ttlMs: 100, nowMs: 1050 }),
      /LEASE_HELD/
    );

    const second = store.acquire({ resource: first.resource, owner: 'runner-b', ttlMs: 100, nowMs: 1101 });
    assert.equal(second.fencingToken, 2);
    assert.throws(
      () => store.assertFence({ resource: first.resource, fencingToken: first.fencingToken, nowMs: 1102 }),
      /STALE_FENCE/
    );
    assert.equal(store.assertFence({ resource: second.resource, fencingToken: second.fencingToken, nowMs: 1102 }), true);
  });
});

test('same owner may renew without changing its fencing token', async () => {
  await withStore(async store => {
    const first = store.acquire({ resource: 'sqlite:orders', owner: 'runner-a', ttlMs: 100, nowMs: 1000 });
    const renewed = store.acquire({ resource: first.resource, owner: 'runner-a', ttlMs: 500, nowMs: 1050 });
    assert.equal(renewed.fencingToken, first.fencingToken);
    assert.ok(renewed.expiresAtMs > first.expiresAtMs);
  });
});
