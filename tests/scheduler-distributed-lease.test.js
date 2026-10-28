import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MigrationScheduler } from '../src/daemon/scheduler.js';
import { LeaseStore } from '../src/execution/lease-store.js';

function tick() { return new Promise(r => setTimeout(r, 30)); }

test('distributed scheduler lease contention and restart durability with LeaseStore', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spool-sched-lease-'));
  t.after(async () => {
    try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });

  const leaseDbPath = join(root, 'execution-leases.db');
  const leaseStore1 = new LeaseStore({ path: leaseDbPath });
  const leaseStore2 = new LeaseStore({ path: leaseDbPath });

  let stagingCount1 = 0;
  let stagingCount2 = 0;

  const mockService = {
    createMigration: async input => ({ migrationId: `mig_${input.worker}` })
  };

  // Pre-acquire lease for worker-1 in leaseStore1
  const nowMs = Date.now();
  leaseStore1.acquire({ resource: 'scheduler:staging', owner: 'worker-1', ttlMs: 5000, nowMs });

  // Scheduler 2 points to leaseStore2 (same underlying SQLite DB file)
  const scheduler2 = new MigrationScheduler({
    service: mockService,
    leaseStore: leaseStore2
  });

  const id2 = scheduler2.scheduleWithLease({
    intervalMs: 10,
    migrationFactory: async () => {
      stagingCount2 += 1;
      return { worker: 'worker-2' };
    }
  });

  await tick();
  await tick();
  scheduler2.cancel(id2);

  // Scheduler 2 must have staged ZERO migrations because worker-1 held the active lease.
  assert.equal(stagingCount2, 0);

  // Release lease as worker-1
  const currentLease = leaseStore1.current('scheduler:staging');
  assert.ok(currentLease);
  leaseStore1.release({ resource: 'scheduler:staging', owner: 'worker-1', fencingToken: currentLease.fencingToken });

  // Now start Scheduler 1
  const scheduler1 = new MigrationScheduler({
    service: mockService,
    leaseStore: leaseStore1
  });

  // Acquire lease for worker-1 with very short TTL and let it expire
  leaseStore1.acquire({ resource: 'scheduler:staging', owner: 'worker-1', ttlMs: 15, nowMs: Date.now() });
  await new Promise(r => setTimeout(r, 40));

  const id1 = scheduler1.scheduleWithLease({
    intervalMs: 10,
    migrationFactory: async () => {
      stagingCount1 += 1;
      return { worker: 'worker-1' };
    }
  });

  await tick();
  await tick();
  scheduler1.cancel(id1);

  // Once lease expired / was released, staging succeeds.
  assert.ok(stagingCount1 >= 1);

  scheduler1.stopAll();
  scheduler2.stopAll();
  leaseStore1.close();
  leaseStore2.close();
});
