import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMysqlEndpoint, mysqlConnectionConfig } from '../src/connectors/mysql/connection.js';
import { MYSQL_TARGET_DESCRIPTOR, createMysqlTargetRuntime } from '../src/connectors/mysql/runtime.js';
import { MYSQL_SOURCE_DESCRIPTOR, createMysqlSourceRuntime } from '../src/connectors/mysql/source.js';
import { CredentialBroker } from '../src/daemon/credential-broker.js';

test('MySQL endpoint parsing enforces credential-free bounded endpoints', () => {
  const parsed = parseMysqlEndpoint('mysql://127.0.0.1:3306/?sslmode=disable');
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 3306);
  assert.equal(parsed.sslMode, 'disable');
  assert.equal(parseMysqlEndpoint('mysql://db.internal/?sslmode=require').port, 3306);
  assert.throws(() => parseMysqlEndpoint('mysql://user:secret@db/x'), /RAW_SECRET_FORBIDDEN/);
  assert.throws(() => parseMysqlEndpoint('mysql://db/x?sslmode=disable'), /INVALID_MYSQL_ENDPOINT/);
  assert.throws(() => parseMysqlEndpoint('mysql://db/?sslmode=bogus'), /INVALID_MYSQL_TLS_MODE/);
  assert.throws(() => parseMysqlEndpoint('mysql://db/?a=1'), /INVALID_MYSQL_ENDPOINT/);
  assert.throws(() => parseMysqlEndpoint('postgres://db/'), /INVALID_MYSQL_ENDPOINT/);
});

test('MySQL connection config requires a resolved secret and maps TLS modes', () => {
  const base = { endpoint: 'mysql://127.0.0.1:3306/?sslmode=disable', database: 'spooltest', identity: { user: 'spooltest' } };
  assert.throws(() => mysqlConnectionConfig(base, ''), /SECRET_NOT_FOUND/);
  const plain = mysqlConnectionConfig(base, 'pw');
  assert.equal(plain.host, '127.0.0.1');
  assert.equal(plain.user, 'spooltest');
  assert.equal(plain.ssl, undefined);
  assert.deepEqual(mysqlConnectionConfig({ ...base, endpoint: 'mysql://127.0.0.1:3306/?sslmode=require' }, 'pw').ssl, { rejectUnauthorized: false });
  assert.deepEqual(mysqlConnectionConfig({ ...base, endpoint: 'mysql://127.0.0.1:3306/?sslmode=verify-full' }, 'pw').ssl, {});
});

test('MySQL descriptors claim honest C1 source and C4 target capabilities', () => {
  assert.equal(MYSQL_SOURCE_DESCRIPTOR.assurance.level, 'C1');
  assert.equal(MYSQL_SOURCE_DESCRIPTOR.capabilities.snapshotBinding, true);
  assert.equal(MYSQL_SOURCE_DESCRIPTOR.capabilities.readOnlySnapshot, true);
  assert.equal(MYSQL_SOURCE_DESCRIPTOR.capabilities.databaseSnapshot, false);
  assert.equal(MYSQL_TARGET_DESCRIPTOR.assurance.level, 'C4');
  assert.equal(MYSQL_TARGET_DESCRIPTOR.capabilities.fencing, true);
  assert.equal(MYSQL_TARGET_DESCRIPTOR.capabilities.exactCommitEvidence, true);
  assert.equal(MYSQL_TARGET_DESCRIPTOR.capabilities.readAfterWriteVerification, false);
  assert.equal(MYSQL_TARGET_DESCRIPTOR.capabilities.repairExecution, false);
  assert.equal(MYSQL_TARGET_DESCRIPTOR.capabilities.bulkWrite, false);
});

test('MySQL runtimes validate plan input without connecting', async () => {
  const broker = new CredentialBroker();
  const targetRuntime = createMysqlTargetRuntime({ credentialBroker: broker });
  const sourceRuntime = createMysqlSourceRuntime({ credentialBroker: broker });
  const targetRef = {
    connector: 'mysql', connectionId: 'dst', resource: 'spooltest.rows',
    endpoint: 'mysql://127.0.0.1:3306/?sslmode=disable', database: 'spooltest', table: 'rows',
    identity: { user: 'spooltest' }, secretRef: { provider: 'env', key: 'SPOOL_TEST_MYSQL_PASSWORD' }
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
  assert.ok(effects.includes('mysql:insert_rows'));
  assert.ok(effects.includes('approval:target_write'));
  assert.throws(() => createMysqlTargetRuntime({}), /INVALID_MYSQL_RUNTIME_CONFIG/);
  assert.throws(() => createMysqlSourceRuntime({ credentialBroker: {} }), /INVALID_MYSQL_SOURCE_CONFIG/);
  void sourceRuntime;
});
