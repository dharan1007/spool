import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationScheduler } from '../src/daemon/scheduler.js';

test('MigrationScheduler schedules and cancels tasks', async () => {
  let executedCount = 0;
  const mockService = {
    createMigration: async () => ({ migrationId: 'mig_sched_test' }),
    plan: async () => ({}),
    dryRun: async () => ({}),
    approve: async () => ({}),
    execute: async () => {
      executedCount++;
      return { status: 'COMPLETE' };
    }
  };

  const scheduler = new MigrationScheduler({ service: mockService });
  const id = scheduler.scheduleInterval({
    intervalMs: 20,
    migrationFactory: async () => ({ name: 'scheduled' })
  });

  assert.ok(id);
  await new Promise(r => setTimeout(r, 65));
  scheduler.cancel(id);

  assert.ok(executedCount >= 2);
  const afterCancel = executedCount;
  await new Promise(r => setTimeout(r, 40));
  assert.equal(executedCount, afterCancel);
});
