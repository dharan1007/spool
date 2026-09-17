import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CredentialBroker } from '../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../src/connectors/postgres/connection.js';
import {
  createSoakPlan,
  runSoakRound,
  isRetryablePostgresFault,
  classifyPostgresFault,
  createRecoveryMeter,
  partitionFaultBy,
  recordRpoRto,
  requirePostgresFaultPlan,
  terminateBackendByPid,
  terminateBackendOf
} from '../../src/connectors/postgres/reference.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function dbRef() {
  return { endpoint, database, identity: { user }, secretRef };
}

async function adminClient() {
  const parsed = parsePostgresEndpoint(endpoint);
  const client = new Client({ host: parsed.host, port: parsed.port, database, user, password, ssl: false });
  await client.connect();
  return client;
}

const SOAK_TABLE = 'soak_target';

async function resetSoakTable() {
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public."${SOAK_TABLE}" CASCADE`);
    await client.query(`CREATE TABLE public."${SOAK_TABLE}" (a integer PRIMARY KEY, b text NOT NULL)`);
  } finally { await client.end(); }
}

async function countSoakRows() {
  const client = await adminClient();
  try {
    const result = await client.query(`SELECT count(*)::int AS n FROM public."${SOAK_TABLE}"`);
    return result.rows[0].n;
  } finally { await client.end(); }
}

test('soak plan requires a unique id window that fits every round', () => {
  const plan = createSoakPlan({ rounds: 3, batchSize: 50, uniqueStart: 1_000, uniqueEnd: 1_300, writers: 2 });
  assert.equal(plan.totalRowsPerRound, 100);
  assert.equal(plan.rounds, 3);
  assert.throws(() => createSoakPlan({ rounds: 10, batchSize: 200, uniqueStart: 0, uniqueEnd: 100, writers: 1 }), /INVALID_SOAK_PLAN/);
});

test('soak round inserts real rows into a live table with pacing and unique ids', { skip: !enabled, timeout: 120_000 }, async () => {
  await resetSoakTable();
  const plan = createSoakPlan({ rounds: 4, batchSize: 25, uniqueStart: 0, uniqueEnd: 200, writers: 2 });
  const results = [];
  for (let round = 1; round <= plan.rounds; round += 1) {
    for (let writer = 0; writer < plan.writers; writer += 1) {
      results.push(await runSoakRound({ ref: dbRef(), credentialBroker: broker, plan, round, writerIndex: writer }));
    }
  }
  assert.equal(results.length, plan.rounds * plan.writers);
  const distinct = new Set(results.map(r => `${r.fromKey}:${r.toKey}`));
  assert.equal(distinct.size, results.length, 'soak windows must not collide across writers');
  const expected = plan.rounds * plan.totalRowsPerRound;
  assert.equal(await countSoakRows(), expected);
});

test('terminated backend fails the in-flight query closed with a classified connection fault', { skip: !enabled, timeout: 120_000 }, async () => {
  await resetSoakTable();
  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const base = { host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false };
    const victim = new Client(base);
    victim.on('error', () => {});
    await victim.connect();
    try {
      const pidRow = await victim.query('SELECT pg_backend_pid() AS pid');
      const pid = pidRow.rows[0].pid;
      const inFlight = victim.query('SELECT pg_sleep(30)').then(
        () => null,
        error => error
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      const fault = await terminateBackendByPid({ ref: dbRef(), credentialBroker: broker, pid });
      assert.equal(fault.terminated, true);
      assert.equal(fault.pid, pid);
      const queryError = await inFlight;
      assert.ok(queryError, 'terminated backend must fail the in-flight query');
      assert.equal(queryError.code, '57P01');
      assert.equal(classifyPostgresFault(queryError), 'ADMIN_SHUTDOWN');
      assert.equal(isRetryablePostgresFault(queryError), false);
    } finally {
      try { await victim.end(); } catch { /* closed by terminate */ }
    }
  });
  assert.equal(await countSoakRows(), 0);
});

test('idle backend terminated through the client handle reports the fault and stays closed', { skip: !enabled, timeout: 60_000 }, async () => {
  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const client = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    client.on('error', () => {});
    await client.connect();
    try {
      const fault = await terminateBackendOf({ ref: dbRef(), credentialBroker: broker, client });
      assert.equal(fault.terminated, true);
      assert.ok(fault.pid > 0);
      await assert.rejects(client.query('SELECT 1'), /not queryable|terminat/);
    } finally {
      try { await client.end(); } catch { /* closed by terminate */ }
    }
  });
});

test('fault plans validate their shape and partition faults describe themselves', () => {
  const plan = requirePostgresFaultPlan({ kind: 'backend-terminate', atRound: 2, terminateBackend: true });
  assert.equal(plan.kind, 'backend-terminate');
  assert.equal(plan.atRound, 2);
  assert.equal(plan.terminateBackend, true);
  assert.equal(plan.cancelQuery, false);
  assert.throws(() => requirePostgresFaultPlan(null), /INVALID_POSTGRES_FAULT/);
  assert.throws(() => requirePostgresFaultPlan({}), /INVALID_POSTGRES_FAULT/);
  const fakeClient = { query() {} };
  assert.equal(partitionFaultBy({ client: fakeClient, kind: 'terminate' }).describe(), 'partition: backend terminated by server');
  assert.equal(partitionFaultBy({ client: fakeClient, kind: 'cancel' }).describe(), 'partition: query cancelled by server');
  assert.throws(() => partitionFaultBy({}), /INVALID_FAULT_INJECTION/);
  assert.throws(() => partitionFaultBy({ client: fakeClient, kind: 'nuke' }), /INVALID_FAULT_INJECTION/);
});

test('deadlock between two real transactions is detected, classified and retryable', { skip: !enabled, timeout: 60_000 }, async () => {
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public.deadlock_a`);
    await client.query(`CREATE TABLE public.deadlock_a (k integer PRIMARY KEY, v integer NOT NULL)`);
    await client.query(`INSERT INTO public.deadlock_a VALUES (1, 10), (2, 20)`);
  } finally { await client.end(); }

  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const txnA = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    const txnB = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    await txnA.connect();
    await txnB.connect();
    let aError = null;
    let bError = null;
    try {
      await txnA.query('BEGIN');
      await txnA.query('SET LOCAL lock_timeout = 0');
      await txnB.query('BEGIN');
      await txnB.query('SET LOCAL lock_timeout = 0');
      await txnA.query('SELECT * FROM public.deadlock_a WHERE k = 1 FOR UPDATE');
      await txnB.query('SELECT * FROM public.deadlock_a WHERE k = 2 FOR UPDATE');
      const aStep = txnA.query('SELECT * FROM public.deadlock_a WHERE k = 2 FOR UPDATE').catch(error => { aError = error; });
      const bStep = txnB.query('SELECT * FROM public.deadlock_a WHERE k = 1 FOR UPDATE').catch(error => { bError = error; });
      await Promise.all([aStep, bStep]);
    } finally {
      try { await txnA.query('ROLLBACK'); } catch { /* fault wins */ }
      try { await txnB.query('ROLLBACK'); } catch { /* fault wins */ }
      try { await txnA.end(); } catch { /* fault wins */ }
      try { await txnB.end(); } catch { /* fault wins */ }
    }
    const loser = aError ?? bError;
    assert.ok(loser, 'deadlock scenario must produce a losing transaction');
    assert.equal(loser.code, '40P01');
    assert.equal(classifyPostgresFault(loser), 'DEADLOCK_DETECTED');
    assert.equal(isRetryablePostgresFault(loser), true);
  });
});

test('serialization fault from concurrent updates under repeatable read is detected and retryable', { skip: !enabled, timeout: 60_000 }, async () => {
  const client = await adminClient();
  try {
    await client.query(`DROP TABLE IF EXISTS public.serial_a`);
    await client.query(`CREATE TABLE public.serial_a (k integer PRIMARY KEY, v integer NOT NULL)`);
    await client.query(`INSERT INTO public.serial_a VALUES (1, 100)`);
  } finally { await client.end(); }

  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const txnA = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    const txnB = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false });
    await txnA.connect();
    await txnB.connect();
    let conflict = null;
    try {
      await txnA.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await txnA.query('UPDATE public.serial_a SET v = v + 1 WHERE k = 1');
      await txnB.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const bSelect = txnB.query('SELECT * FROM public.serial_a WHERE k = 1 FOR SHARE').then(
        () => null,
        error => error
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      await txnA.query('COMMIT');
      const selectError = await bSelect;
      if (selectError) {
        conflict = selectError;
      } else {
        try {
          await txnB.query('UPDATE public.serial_a SET v = v * 2 WHERE k = 1');
        } catch (error) {
          conflict = error;
        }
      }
    } finally {
      try { await txnA.query('ROLLBACK'); } catch { /* fault wins */ }
      try { await txnB.query('ROLLBACK'); } catch { /* fault wins */ }
      try { await txnA.end(); } catch { /* fault wins */ }
      try { await txnB.end(); } catch { /* fault wins */ }
    }
    assert.ok(conflict, 'concurrent repeatable-read update must produce a serialization fault');
    assert.equal(conflict.code, '40001');
    assert.equal(classifyPostgresFault(conflict), 'SERIALIZATION_FAILURE');
    assert.equal(isRetryablePostgresFault(conflict), true);
  });
});

test('connection churn opens and closes many real clients while the metadata stays intact', { skip: !enabled, timeout: 120_000 }, async () => {
  await broker.withSecret(secretRef, async secret => {
    const parsed = parsePostgresEndpoint(endpoint);
    const churn = 25;
    let verified = 0;
    for (let i = 0; i < churn; i += 1) {
      const client = new Client({ host: parsed.host, port: parsed.port, database, user, password: secret, ssl: false, application_name: 'churn-probe' });
      await client.connect();
      try {
        const result = await client.query('SELECT 1 AS ok');
        assert.equal(result.rows[0].ok, 1);
        verified += 1;
      } finally { await client.end(); }
    }
    assert.equal(verified, churn);
  });
});

test('recovery meter tracks flush freshness and failure counts with an injectable clock', () => {
  let now = 1_000;
  const meter = createRecoveryMeter({ now: () => now });
  assert.equal(meter.rpo(), null);
  assert.equal(meter.failures(), 0);
  meter.markFlushed();
  now += 250;
  assert.equal(meter.rpo(), 250);
  meter.markFailure();
  meter.markFailure();
  assert.equal(meter.failures(), 2);
  meter.clear();
  assert.equal(meter.rpo(), null);
  assert.equal(meter.failures(), 0);
});

test('rpo/rto records validate their budgets', () => {
  const record = recordRpoRto({ name: 'destination-restart', rpoMs: 0, rtoMs: 1_500 });
  assert.equal(record.name, 'destination-restart');
  assert.equal(record.rpoMs, 0);
  assert.equal(record.rtoMs, 1_500);
  assert.throws(() => recordRpoRto({ name: '' }), /INVALID_RPO_RTO/);
  assert.throws(() => recordRpoRto({ name: 'x', rpoMs: -1 }), /INVALID_RPO_RTO/);
});