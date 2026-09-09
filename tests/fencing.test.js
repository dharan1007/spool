import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LeaseStore } from '../src/execution/lease-store.js';
import { SqliteTarget } from '../src/connectors/sqlite/target.js';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-lease-'));
  const path = join(dir, 'leases.db');
  const store = new LeaseStore({ path });
  try { await fn(store, path); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
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

test('SQLite production mutation checks the durable fence inside its write transaction', async () => {
  await withStore(async (store, path) => {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
    db.close();
    const resource = 'sqlite:customers';
    const first = store.acquire({ resource, owner: 'runner-a', ttlMs: 100, nowMs: 1000 });
    const target = new SqliteTarget({ path, table: 'customers', requireFencing: true, fenceResource: resource });
    const base = {
      migrationId: 'mig_fence_001',
      planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      mappingRevision: 1
    };
    target.commitBatch({
      ...base,
      batchIdentity: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      fencingToken: first.fencingToken,
      nowMs: 1050,
      rows: [{ id: 1, name: 'Ada' }]
    });

    const second = store.acquire({ resource, owner: 'runner-b', ttlMs: 100, nowMs: 1101 });
    assert.throws(() => target.commitBatch({
      ...base,
      batchIdentity: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      fencingToken: first.fencingToken,
      nowMs: 1102,
      rows: [{ id: 2, name: 'stale' }]
    }), /STALE_FENCE/);

    target.commitBatch({
      ...base,
      batchIdentity: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      fencingToken: second.fencingToken,
      nowMs: 1102,
      rows: [{ id: 2, name: 'fresh' }]
    });
    target.close();
  });
});
