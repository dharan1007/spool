import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const parent = await readFile(new URL('../scripts/qualify/postgres/crash-recovery.js', import.meta.url), 'utf8');
const child = await readFile(new URL('../scripts/qualify/postgres/crash-child.js', import.meta.url), 'utf8');

test('hard-kill qualification cannot administratively release the dead lease', () => {
  assert.ok(!parent.includes('DELETE FROM spool_internal.execution_leases'));
  assert.ok(!parent.includes('crash_lease_released_after_kill'));
  for (const required of [
    'expires_at > clock_timestamp() AS active',
    'dead_owner_lease_refused_before_expiry',
    'dead_owner_lease_expired_naturally',
    'lease_takeover_after_db_expiry'
  ]) assert.ok(parent.includes(required), 'missing proof: ' + required);
});

test('SIGKILL proof requires observed kill, a new fence and a rejected stale write', () => {
  for (const required of [
    "killChild.kill('SIGKILL')",
    "exitInfo.signal !== 'SIGKILL'",
    "error?.code !== 'LEASE_HELD'",
    'BigInt(lease2.fencingToken) <= BigInt(childLease.fencingToken)',
    'staleTarget.commitBatch(',
    'old_fence_mutation_refused'
  ]) assert.ok(parent.includes(required), 'missing required check: ' + required);
  assert.ok(!parent.includes("killChild.kill('SIGTERM')"));
});

test('crash child communicates its real bounded lease and protects its credential file', () => {
  assert.ok(child.includes('leaseTtlMs: cfg.leaseTtlMs'));
  assert.ok(child.includes('CRASH_CHILD_READY ${JSON.stringify(lease)}'));
  assert.ok(parent.includes('mode: 0o600'));
});
