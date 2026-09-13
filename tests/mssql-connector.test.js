import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMssqlEndpoint, mssqlConnectionConfig } from '../src/connectors/mssql/connection.js';
import { MSSQL_TARGET_DESCRIPTOR, createMssqlTargetRuntime } from '../src/connectors/mssql/runtime.js';
import { MSSQL_SOURCE_DESCRIPTOR, createMssqlSourceRuntime } from '../src/connectors/mssql/source.js';
import { CredentialBroker } from '../src/daemon/credential-broker.js';

test('SQL Server endpoint parsing enforces credential-free bounded endpoints', () => {
  const parsed = parseMssqlEndpoint('mssql://127.0.0.1:1433/?sslmode=disable');
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 1433);
  assert.equal(parsed.sslMode, 'disable');
  assert.equal(parseMssqlEndpoint('mssql://db.internal/?sslmode=require').port, 1433);
  assert.throws(() => parseMssqlEndpoint('mssql://user:secret@db/x'), /RAW_SECRET_FORBIDDEN/);
  assert.throws(() => parseMssqlEndpoint('mssql://db/x?sslmode=disable'), /INVALID_MSSQL_ENDPOINT/);
  assert.throws(() => parseMssqlEndpoint('mssql://db/?sslmode=bogus'), /INVALID_MSSQL_TLS_MODE/);
  assert.throws(() => parseMssqlEndpoint('mssql://db/?a=1'), /INVALID_MSSQL_ENDPOINT/);
  assert.throws(() => parseMssqlEndpoint('postgres://db/'), /INVALID_MSSQL_ENDPOINT/);
});

test('SQL Server connection config requires a resolved secret and maps TLS modes', () => {
  const base = { endpoint: 'mssql://127.0.0.1:1433/?sslmode=disable', database: 'spooltest', identity: { user: 'sa' } };
  assert.throws(() => mssqlConnectionConfig(base, ''), /SECRET_NOT_FOUND/);
  const plain = mssqlConnectionConfig(base, 'pw');
  assert.equal(plain.server, '127.0.0.1');
  assert.equal(plain.user, 'sa');
  assert.equal(plain.options.encrypt, false);
  const required = mssqlConnectionConfig({ ...base, endpoint: 'mssql://127.0.0.1:1433/?sslmode=require' }, 'pw');
  assert.equal(required.options.encrypt, true);
  assert.equal(required.options.trustServerCertificate, true);
  const verified = mssqlConnectionConfig({ ...base, endpoint: 'mssql://127.0.0.1:1433/?sslmode=verify-full' }, 'pw');
  assert.equal(verified.options.encrypt, true);
  assert.equal(verified.options.trustServerCertificate, false);
});

test('SQL Server descriptors claim honest C1 source and C4 target capabilities', () => {
  assert.equal(MSSQL_SOURCE_DESCRIPTOR.assurance.level, 'C1');
  assert.equal(MSSQL_SOURCE_DESCRIPTOR.capabilities.snapshotBinding, true);
  assert.equal(MSSQL_SOURCE_DESCRIPTOR.capabilities.readOnlySnapshot, true);
  assert.equal(MSSQL_TARGET_DESCRIPTOR.assurance.level, 'C4');
  assert.equal(MSSQL_TARGET_DESCRIPTOR.capabilities.fencing, true);
  assert.equal(MSSQL_TARGET_DESCRIPTOR.capabilities.exactCommitEvidence, true);
  assert.equal(MSSQL_TARGET_DESCRIPTOR.capabilities.readAfterWriteVerification, false);
  assert.equal(MSSQL_TARGET_DESCRIPTOR.capabilities.repairExecution, false);
  assert.equal(MSSQL_TARGET_DESCRIPTOR.capabilities.bulkWrite, false);
});

test('SQL Server runtimes validate plan input without connecting', async () => {
  const broker = new CredentialBroker();
  const targetRuntime = createMssqlTargetRuntime({ credentialBroker: broker });
  createMssqlSourceRuntime({ credentialBroker: broker });
  const targetRef = {
    connector: 'mssql', connectionId: 'dst', resource: 'spooltest.rows',
    endpoint: 'mssql://127.0.0.1:1433/?sslmode=disable', database: 'spooltest', table: 'rows',
    identity: { user: 'sa' }, secretRef: { provider: 'env', key: 'SPOOL_TEST_MSSQL_PASSWORD' }
  };
  const normalized = await targetRuntime.normalizePlanInput({
    targetRef,
    writeStrategy: { mode: 'insert', batchSize: 100 },
    verification: { checks: [] },
    risk: { approvals: [] }
  });
  assert.equal(normalized.targetRef.resource, 'spooltest.rows');
  await assert.rejects(
    targetRuntime.normalizePlanInput({ targetRef, writeStrategy: { mode: 'upsert', batchSize: 100 }, verification: { checks: [] }, risk: { approvals: [] } }),
    /UNSUPPORTED_WRITE_STRATEGY/
  );
  await assert.rejects(
    targetRuntime.normalizePlanInput({ targetRef, writeStrategy: { mode: 'insert', batchSize: 10001 }, verification: { checks: [] }, risk: { approvals: [] } }),
    /INVALID_WRITE_STRATEGY/
  );
  const effects = targetRuntime.approvalEffects({ risk: { approvals: ['target_write'] }, verification: { checks: [] }, writeStrategy: { mode: 'insert', batchSize: 2 } });
  assert.ok(effects.includes('mssql:insert_rows'));
  assert.ok(effects.includes('approval:target_write'));
  assert.throws(() => createMssqlTargetRuntime({}), /INVALID_MSSQL_RUNTIME_CONFIG/);
  assert.throws(() => createMssqlSourceRuntime({ credentialBroker: {} }), /INVALID_MSSQL_SOURCE_CONFIG/);
});
