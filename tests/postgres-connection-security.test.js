import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePostgresEndpoint,
  postgresConnectionConfig,
  postgresPoolIdentity
} from '../src/connectors/postgres/connection.js';

function ref(sslmode) {
  return {
    endpoint: `postgresql://db.example.internal:5432/?sslmode=${sslmode}`,
    database: 'warehouse',
    identity: { user: 'spool' }
  };
}

test('PostgreSQL pool identity is cryptographically separated by TLS policy', () => {
  const password = 'same-secret-for-security-invariant';
  const disable = postgresConnectionConfig(ref('disable'), password);
  const requireTls = postgresConnectionConfig(ref('require'), password);
  const verifyFull = postgresConnectionConfig(ref('verify-full'), password);

  assert.equal(disable.ssl, false);
  assert.equal(requireTls.ssl.rejectUnauthorized, false);
  assert.equal(verifyFull.ssl.rejectUnauthorized, true);

  const disableId = postgresPoolIdentity(disable, password);
  const requireId = postgresPoolIdentity(requireTls, password);
  const verifyId = postgresPoolIdentity(verifyFull, password);

  assert.match(disableId, /^[a-f0-9]{64}$/);
  assert.notEqual(disableId, requireId);
  assert.notEqual(disableId, verifyId);
  assert.notEqual(requireId, verifyId);

  // Deterministic for the same complete security context.
  assert.equal(postgresPoolIdentity(verifyFull, password), verifyId);
  // Credential rotation must also move to a distinct pool.
  assert.notEqual(postgresPoolIdentity(verifyFull, 'rotated-secret'), verifyId);
});

test('PostgreSQL endpoint defaults to certificate-verifying TLS', () => {
  const parsed = parsePostgresEndpoint('postgresql://db.example.internal/');
  assert.equal(parsed.sslMode, 'verify-full');
  assert.match(parsed.endpoint, /sslmode=verify-full/);
});

test('PostgreSQL endpoint refuses embedded credentials and unknown TLS modes', () => {
  assert.throws(
    () => parsePostgresEndpoint('postgresql://user:password@db.example.internal/'),
    /RAW_SECRET_FORBIDDEN/
  );
  assert.throws(
    () => parsePostgresEndpoint('postgresql://db.example.internal/?sslmode=prefer'),
    /INVALID_POSTGRES_TLS_MODE/
  );
});
