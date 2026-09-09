import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialBroker } from '../src/daemon/credential-broker.js';

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
