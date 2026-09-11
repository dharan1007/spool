import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import { fail } from '../src/core/errors.js';

const ref = { provider: 'env', key: 'SPOOL_TEST_SECRET' };

test('credential broker resolves only inside callback and rejects returned secret material', () => {
  const broker = new CredentialBroker({ getEnv: key => key === 'SPOOL_TEST_SECRET' ? 'super-secret-token' : undefined });
  const safe = broker.withSecret(ref, secret => ({ ok: true, secretLength: secret.length }));
  assert.deepEqual(safe, { ok: true, secretLength: 18 });
  assert.doesNotMatch(JSON.stringify(safe), /super-secret-token/);

  assert.throws(
    () => broker.withSecret(ref, secret => ({ authorization: `Bearer ${secret}` })),
    /SECRET_LEAK_DETECTED/
  );
});

test('credential broker redacts secret material from callback failures', () => {
  const broker = new CredentialBroker({ getEnv: () => 'super-secret-token' });
  try {
    broker.withSecret(ref, secret => { throw new Error(`upstream rejected ${secret}`); });
    assert.fail('expected broker failure');
  } catch (error) {
    assert.equal(error.code, 'CREDENTIAL_CALLBACK_FAILED');
    assert.doesNotMatch(error.message, /super-secret-token/);
    assert.match(error.message, /\[REDACTED\]/);
  }
});

test('credential broker preserves safe typed SPOOL errors without exposing secrets', async () => {
  const broker = new CredentialBroker({ getEnv: () => 'super-secret-token' });
  await assert.rejects(
    () => broker.withSecret(ref, async () => fail('TARGET_SCHEMA_INCOMPATIBLE', 'target contract is incompatible', { table: 'customers' })),
    error => error?.code === 'TARGET_SCHEMA_INCOMPATIBLE' && error?.details?.table === 'customers'
  );

  await assert.rejects(
    () => broker.withSecret(ref, async secret => fail('TARGET_SCHEMA_INCOMPATIBLE', `target rejected ${secret}`, { diagnostic: secret })),
    error => error?.code === 'CREDENTIAL_CALLBACK_FAILED'
      && !String(error?.message).includes('super-secret-token')
      && String(error?.message).includes('[REDACTED]')
  );
});
