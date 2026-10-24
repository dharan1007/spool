import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/daemon/audit-log.js';

test('AuditLog records, queries, and prunes events', () => {
  const audit = new AuditLog({ path: ':memory:' });
  try {
    const { eventId, timestamp } = audit.record({
      principal: 'user_1',
      action: 'migration.create',
      resource: 'mig_123',
      outcome: 'SUCCESS',
      detail: { rows: 50 },
      ip: '127.0.0.1'
    });
    assert.ok(eventId.startsWith('audit_'));
    assert.ok(timestamp);

    audit.record({
      principal: 'user_2',
      action: 'migration.approve',
      resource: 'mig_123',
      outcome: 'SUCCESS',
      detail: {}
    });

    // Query all
    const all = audit.query();
    assert.equal(all.length, 2);

    // Query by principal
    const user1Events = audit.query({ principal: 'user_1' });
    assert.equal(user1Events.length, 1);
    assert.equal(user1Events[0].action, 'migration.create');
    assert.equal(user1Events[0].detail.rows, 50);

    // Query by resource
    const migEvents = audit.query({ resource: 'mig_123' });
    assert.equal(migEvents.length, 2);

    // Pruning
    const futureDate = new Date(Date.now() + 10000).toISOString();
    const pruned = audit.prune(futureDate);
    assert.equal(pruned, 2);
    assert.equal(audit.query().length, 0);
  } finally {
    audit.close();
  }
});
