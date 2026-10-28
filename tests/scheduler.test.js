import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationScheduler } from '../src/daemon/scheduler.js';

function tick() { return new Promise(r => setTimeout(r, 25)); }

test('scheduler stages migrations without ever approving or executing', async () => {
  const calls = { create: 0, plan: 0, approve: 0, execute: 0, run: 0, dryRun: 0 };
  const mockService = {
    createMigration: async () => { calls.create += 1; return { migrationId: `mig_${calls.create}` }; },
    plan: async () => { calls.plan += 1; return {}; },
    dryRun: async () => { calls.dryRun += 1; return {}; },
    approve: async () => { calls.approve += 1; return {}; },
    execute: async () => { calls.execute += 1; return {}; },
    run: async () => { calls.run += 1; return {}; }
  };
  const audited = [];
  const scheduler = new MigrationScheduler({
    service: mockService,
    auditLog: { record: event => audited.push(event) }
  });
  const id = scheduler.scheduleWithLease({
    intervalMs: 10,
    migrationFactory: async () => ({ name: 'scheduled' })
  });
  assert.ok(id.startsWith('sched_'));
  await tick();
  scheduler.cancel(id);
  assert.ok(calls.create >= 1);
  // The critical safety property: no automatic destroy-or-mutate step happened.
  assert.equal(calls.plan, 0);
  assert.equal(calls.dryRun, 0);
  assert.equal(calls.approve, 0);
  assert.equal(calls.execute, 0);
  assert.equal(calls.run, 0);
  const actions = audited.map(event => event.action);
  assert.ok(actions.includes('scheduled.migration.staged'));
  assert.ok(!actions.includes('scheduled.migration.complete'));
});

test('scheduler skips staging while another worker holds the lease', async () => {
  let created = 0;
  const mockService = { createMigration: async () => { created += 1; return { migrationId: `m${created}` }; } };
  const scheduler = new MigrationScheduler({
    service: mockService,
    leaseStore: { getActiveLease: () => ({ resource: 'migration:m1', owner: 'worker-1' }) }
  });
  const id = scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => ({}) });
  await tick();
  scheduler.cancel(id);
  assert.equal(created, 0);
});

test('scheduler fails closed when requiredRole is demanded without an authorizer', () => {
  const mockService = { createMigration: async () => ({ migrationId: 'm' }) };
  assert.throws(
    () => new MigrationScheduler({ service: mockService }).scheduleWithLease({
      intervalMs: 10,
      migrationFactory: async () => ({}),
      requiredRole: 'operator'
    }),
    /SCHEDULER_CONFIG_INVALID/
  );
});

test('scheduler consults authorizeRole for requiredRole and rejects unauthorized staging', async () => {
  let created = 0;
  const mockService = {
    createMigration: async () => { created += 1; return { migrationId: `m${created}` }; },
    authorizeRole: role => role === 'operator'
  };
  const audited = [];
  const scheduler = new MigrationScheduler({ service: mockService, auditLog: { record: e => audited.push(e) } });
  const denied = scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => ({}), requiredRole: 'viewer' });
  await tick();
  scheduler.cancel(denied);
  assert.equal(created, 0);
  assert.ok(audited.some(event => event.action === 'scheduled.migration.rejected' && event.outcome === 'NO_AUTHORIZATION'));
  const allowed = scheduler.scheduleWithLease({ id: 'sched_allow', intervalMs: 10, migrationFactory: async () => ({}), requiredRole: 'operator' });
  await tick();
  scheduler.cancel(allowed);
  assert.equal(created, 1);
});

test('scheduler cancels and stops without further ticks', async () => {
  let created = 0;
  const mockService = { createMigration: async () => { created += 1; return { migrationId: `m${created}` }; } };
  const scheduler = new MigrationScheduler({ service: mockService });
  const idA = scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => ({}) });
  const idB = scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => ({}) });
  await tick();
  const stableAfterFirst = created;
  scheduler.cancel(idA);
  scheduler.cancel(idA);
  assert.equal(scheduler.cancel(idA), false);
  scheduler.stopAll();
  await new Promise(r => setTimeout(r, 40));
  assert.ok(created <= stableAfterFirst + 1); // idB might have ticked once before stopAll
  assert.equal(scheduler.scheduleWithLease.bind(scheduler, { intervalMs: 10, migrationFactory: async () => ({}) }).name !== '', true);
  assert.throws(
    () => scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => ({}) }),
    /SCHEDULER_STOPPED/
  );
});

test('scheduler stages through migration failures and keeps ticking', async () => {
  const events = [];
  let created = 0;
  const mockService = {
    createMigration: async input => {
      if (input.name === 'boom') throw new Error('factory rejected');
      created += 1;
      return { migrationId: `m${created}` };
    }
  };
  const scheduler = new MigrationScheduler({ service: mockService, auditLog: { record: e => events.push(e) } });
  let flip = false;
  const id = scheduler.scheduleWithLease({ intervalMs: 10, migrationFactory: async () => { flip = !flip; return { name: flip ? 'boom' : 'ok' }; } });
  await tick();
  await tick();
  scheduler.cancel(id);
  assert.ok(events.some(event => event.action === 'scheduled.migration.failed' && event.outcome === 'FAILED'));
  assert.ok(events.some(event => event.action === 'scheduled.migration.staged'));
  assert.ok(created >= 1);
});
