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
    [{ ...identities[0], principal: 'admin;drop' }],
    [{ ...identities[0], commands: ['not-a-command'] }],
    [{ ...identities[0], commands: ['run', 'run'] }],
    [identities[0], { ...identities[1], principal: identities[0].principal }],
    [identities[0], { ...identities[1], token: identities[0].token }]
  ]) assert.throws(() => compileLocalAuthorities(bad, commands), TypeError);
});
