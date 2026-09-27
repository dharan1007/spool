import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLocalAuthorities, authenticateLocalBearer, assertLocalCommandAuthority } from '../src/daemon/local-authority.js';

const commands = new Set(['plan', 'approve', 'run', 'status', 'receipt']);
const identities = [
  { token: '0'.repeat(32), principal: 'operator:alice', commands: ['plan', 'run', 'status'] },
  { token: '1'.repeat(32), principal: 'operator:bob', commands: ['approve', 'receipt'] }
];
const policy = compileLocalAuthorities(identities, commands);
test('only the correct bound bearer resolves an authenticated identity', () => {
  assert.equal(authenticateLocalBearer(policy, 'Bearer ' + '0'.repeat(32))?.principal, 'operator:alice');
  assert.equal(authenticateLocalBearer(policy, 'Bearer ' + '1'.repeat(32))?.principal, 'operator:bob');
  for (const header of ['Bearer ' + '2'.repeat(32), 'Basic ' + '0'.repeat(32), null, 'Bearer ' + 'x'.repeat(5000)]) {
    assert.equal(authenticateLocalBearer(policy, header), null);
  }
  assert.equal(JSON.stringify(policy).includes('0'.repeat(32)), false, 'plaintext credential retained in policy');
  assert.throws(() => policy[0].commands.push('approve'), TypeError, 'command grants must not be externally mutable');
});
test('principal spoofing is refused rather than overwritten', () => {
  assert.throws(() => assertLocalCommandAuthority(policy[0], { command: 'run', request: { principal: 'operator:bob' } }), { code: 'PRINCIPAL_MISMATCH' });
  assert.throws(() => assertLocalCommandAuthority(policy[0], { command: 'run', request: {} }), { code: 'PRINCIPAL_MISMATCH' });
  assert.equal(assertLocalCommandAuthority(policy[0], { command: 'run', request: { principal: 'operator:alice' } }), 'operator:alice');
});
test('per-operator command scopes refuse privilege escalation', () => {
  assert.throws(() => assertLocalCommandAuthority(policy[0], { command: 'approve', request: { principal: 'operator:alice' } }), { code: 'COMMAND_FORBIDDEN' });
  assert.throws(() => assertLocalCommandAuthority(policy[1], { command: 'run', request: { principal: 'operator:bob' } }), { code: 'COMMAND_FORBIDDEN' });
  assert.equal(assertLocalCommandAuthority(policy[1], { command: 'receipt' }), 'operator:bob');
});
test('unsafe auth configuration fails at daemon startup', () => {
  for (const bad of [
    [],
    [{ ...identities[0], token: 'short' }],
    [{ ...identities[0], token: 'x'.repeat(4097) }],
    [{ ...identities[0], principal: 'admin;drop' }],
    [{ ...identities[0], commands: ['not-a-command'] }],
    [{ ...identities[0], commands: ['run', 'run'] }],
    [identities[0], { ...identities[1], principal: identities[0].principal }],
    [identities[0], { ...identities[1], token: identities[0].token }]
  ]) assert.throws(() => compileLocalAuthorities(bad, commands), TypeError);
});

test('explicit migration scopes reject cross-migration reads, writes, and cutover aborts', () => {
  const scoped = compileLocalAuthorities([{
    ...identities[0], commands: ['run','status','abort-cutover'], migrationIds: ['migration-A']
  }], new Set(['run','status','abort-cutover']), { requireMigrationScopes: true });
  const alice = scoped[0];
  assert.equal(assertLocalCommandAuthority(alice, {
    command:'run', request:{principal:'operator:alice',migrationId:'migration-A'}
  }), 'operator:alice');
  assert.equal(assertLocalCommandAuthority(alice, {
    command:'status', migrationId:'migration-A'
  }), 'operator:alice');
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'run', request:{principal:'operator:alice',migrationId:'migration-B'}
  }), { code:'MIGRATION_FORBIDDEN' });
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'status', migrationId:'migration-B'
  }), { code:'MIGRATION_FORBIDDEN' });
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'abort-cutover', migrationId:'migration-B'
  }), { code:'MIGRATION_FORBIDDEN' });
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'run', request:{principal:'operator:alice'}
  }), { code:'MIGRATION_FORBIDDEN' });
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'run', request:{principal:'operator:alice',migrationId:'migration-A'},
    migrationId:'migration-B'
  }), { code:'MIGRATION_SCOPE_MISMATCH' });
  assert.throws(() => alice.migrationIds.push('migration-B'), TypeError);
});

test('strict mode refuses omitted, duplicate, malformed and unbounded migration scopes', () => {
  const allowed = new Set(['plan','run','status']);
  for (const item of [
    { ...identities[0] }, { ...identities[0], migrationIds: [] },
    { ...identities[0], migrationIds: ['m1','m1'] },
    { ...identities[0], migrationIds: ['bad' + String.fromCharCode(0) + 'value'] },
    { ...identities[0], migrationIds: ['a'.repeat(257)] },
    { ...identities[0], migrationIds: ['m1', 3] }
  ]) assert.throws(() => compileLocalAuthorities([item], allowed, { requireMigrationScopes:true }), TypeError);
  assert.throws(() => compileLocalAuthorities([identities[0]], allowed, { requireMigrationScopes:'yes' }), TypeError);
});

test('unscoped local legacy identity remains compatible but cannot spoof a principal', () => {
  const alice = policy[0];
  assert.equal(alice.migrationIds, null);
  assert.equal(assertLocalCommandAuthority(alice, {
    command:'status', migrationId:'any-migration'
  }), 'operator:alice');
  assert.throws(() => assertLocalCommandAuthority(alice, {
    command:'run', request:{principal:'operator:bob',migrationId:'any-migration'}
  }), { code:'PRINCIPAL_MISMATCH' });
});
