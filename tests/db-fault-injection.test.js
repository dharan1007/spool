import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { verifyContentProjection } from '../src/execution/content-verification.js';
import { LeaseStore } from '../src/execution/lease-store.js';

test('Database Fault Injection: Stale Fencing Token Rejection', () => {
  const dbPath = join(tmpdir(), `spool-lease-fault-${Date.now()}.db`);
  const leaseStore = new LeaseStore({ path: dbPath });
  try {
    const resource = 'mig_fault_test';
    const ownerA = 'worker_node_1';
    const ownerB = 'worker_node_2';

    // 1. Worker A acquires lease (fencing token = 1)
    const leaseA = leaseStore.acquire({ resource, owner: ownerA, ttlMs: 1000, nowMs: 1000 });
    assert.equal(leaseA.fencingToken, 1);

    // 2. Lease expires (nowMs = 2500 > 1000 + 1000)
    // 3. Worker B acquires lease (takeover, fencing token = 2)
    const leaseB = leaseStore.acquire({ resource, owner: ownerB, ttlMs: 1000, nowMs: 2500 });
    assert.equal(leaseB.fencingToken, 2);

    // 4. Worker A (stale) attempts to write with token 1 -> MUST BE REJECTED
    assert.throws(
      () => leaseStore.assertFence({ resource, fencingToken: 1, nowMs: 2600 }),
      /STALE_FENCE|LEASE_EXPIRED/
    );

    // 5. Worker B with token 2 -> VALID
    assert.doesNotThrow(
      () => leaseStore.assertFence({ resource, fencingToken: 2, nowMs: 2600 })
    );
  } finally {
    leaseStore.close();
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {}
  }
});

test('Database Fault Injection: Single-Row Corruption Detection & Repair', () => {
  const primaryKey = ['id'];
  const columns = ['id', 'val'];

  const expectedRows = [
    { id: 1, val: 'alpha' },
    { id: 2, val: 'beta' },
    { id: 3, val: 'gamma' }
  ];

  // 1. Exact match passes verification
  const exact = verifyContentProjection({
    primaryKey,
    columns,
    expectedRows,
    actualRows: structuredClone(expectedRows)
  });
  assert.equal(exact.status, 'VERIFIED');
  assert.equal(exact.diff.total, 0);

  // 2. Corrupt one row (simulated disk corruption or untracked mutation)
  const corruptedActual = [
    { id: 1, val: 'alpha' },
    { id: 2, val: 'CORRUPTED' },
    { id: 3, val: 'gamma' }
  ];

  const diff = verifyContentProjection({
    primaryKey,
    columns,
    expectedRows,
    actualRows: corruptedActual
  });
  assert.equal(diff.status, 'DIFF');
  assert.equal(diff.diff.total, 1);
  assert.equal(diff.diff.entries[0].kind, 'MISMATCH');

  // 3. Repair row 2 -> re-verify
  const repairedActual = corruptedActual.map(r => (r.id === 2 ? { id: 2, val: 'beta' } : r));
  const repaired = verifyContentProjection({
    primaryKey,
    columns,
    expectedRows,
    actualRows: repairedActual
  });
  assert.equal(repaired.status, 'VERIFIED');
  assert.equal(repaired.diff.total, 0);
});
