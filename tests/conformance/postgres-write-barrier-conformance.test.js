import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { acquirePostgresTableShareLockBarrier } from '../../src/cutover/write-barrier.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT;
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? process.env.SPOOL_TEST_POSTGRES_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);

function pgConfig() {
  const url = new URL(endpoint);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database,
    user,
    password,
    ssl: false,
    application_name: 'spool-write-barrier-conformance',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 65_000,
    keepAlive: true
  };
}

const broker = {
  withSecret: async (_ref, fn) => fn(password)
};

function sourceRef(table) {
  const url = new URL(endpoint);
  return {
    connector: 'postgres',
    endpoint: `postgresql://${url.hostname}${url.port ? `:${url.port}` : ''}/?sslmode=disable`,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' }
  };
}

async function client() {
  const c = new Client(pgConfig());
  await c.connect();
  return c;
}

async function reset(table) {
  const c = await client();
  try {
    await c.query(`DROP TABLE IF EXISTS public."${table}"`);
    await c.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, value text NOT NULL)`);
    await c.query(`INSERT INTO public."${table}"(id,value) VALUES (1,'before')`);
  } finally {
    await c.end();
  }
}

async function expectLockTimeout(fn) {
  await assert.rejects(fn, error => String(error?.code) === '55P03');
}

test('PostgreSQL table SHARE barrier blocks DML from sessions that existed before acquisition while reads continue', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'spool_barrier_existing_session';
  await reset(table);
  const writer = await client();
  const reader = await client();
  let barrier;
  try {
    // This session exists before the barrier. A database-level read-only
    // default would not fence it; the table lock must.
    barrier = await acquirePostgresTableShareLockBarrier({
      migrationId: 'barrier-existing-session',
      sourceRef: sourceRef(table),
      credentialBroker: broker,
      lockTimeoutMs: 10_000,
      probeTimeoutMs: 250
    });

    assert.equal(barrier.kind, 'POSTGRES_TABLE_SHARE_LOCK');
    assert.equal(barrier.zeroDowntime, false);
    assert.match(barrier.barrierId, /^sha256:[a-f0-9]{64}$/);
    assert.match(barrier.finalLsn, /^[0-9A-F]+\/[0-9A-F]+$/);
    assert.equal((await barrier.verifyHeld()).held, true);

    // SELECT uses ACCESS SHARE and is intentionally allowed while SHARE is held.
    const visible = await reader.query(`SELECT value FROM public."${table}" WHERE id=1`);
    assert.equal(visible.rows[0].value, 'before');

    // Existing writer session attempts real DML. It must be refused by the
    // database lock manager, not by application-side convention.
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await expectLockTimeout(() =>
      writer.query(`UPDATE public."${table}" SET value='during-barrier' WHERE id=1`)
    );
    await writer.query('ROLLBACK');

    await barrier.release();
    barrier = null;

    // After release, that exact pre-existing session can write again.
    await writer.query(`UPDATE public."${table}" SET value='after-release' WHERE id=1`);
    const after = await reader.query(`SELECT value FROM public."${table}" WHERE id=1`);
    assert.equal(after.rows[0].value, 'after-release');
  } finally {
    if (barrier) await barrier.release().catch(() => {});
    await writer.end().catch(() => {});
    await reader.end().catch(() => {});
  }
});

test('barrier waits for an active writer and fails closed on lock acquisition timeout', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'spool_barrier_active_writer';
  await reset(table);
  const writer = await client();
  try {
    await writer.query('BEGIN');
    await writer.query(`UPDATE public."${table}" SET value='uncommitted' WHERE id=1`);

    await assert.rejects(
      () => acquirePostgresTableShareLockBarrier({
        migrationId: 'barrier-active-writer-timeout',
        sourceRef: sourceRef(table),
        credentialBroker: broker,
        lockTimeoutMs: 250,
        probeTimeoutMs: 100
      }),
      error => error?.code === 'WRITE_BARRIER_ACQUIRE_TIMEOUT'
    );

    await writer.query('ROLLBACK');

    const barrier = await acquirePostgresTableShareLockBarrier({
      migrationId: 'barrier-active-writer-after-drain',
      sourceRef: sourceRef(table),
      credentialBroker: broker,
      lockTimeoutMs: 5_000,
      probeTimeoutMs: 100
    });
    try {
      assert.equal((await barrier.verifyHeld()).held, true);
    } finally {
      await barrier.release();
    }
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    await writer.end().catch(() => {});
  }
});

test('barrier handle reports loss after release and repeated release is idempotent', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'spool_barrier_release_semantics';
  await reset(table);
  const barrier = await acquirePostgresTableShareLockBarrier({
    migrationId: 'barrier-release',
    sourceRef: sourceRef(table),
    credentialBroker: broker,
    lockTimeoutMs: 5_000,
    probeTimeoutMs: 100
  });

  assert.equal((await barrier.verifyHeld()).held, true);
  const first = await barrier.release();
  assert.equal(first.released, true);
  const second = await barrier.release();
  assert.equal(second.released, true);
  assert.equal(second.repeated, true);
  await assert.rejects(
    () => barrier.verifyHeld(),
    error => error?.code === 'WRITE_BARRIER_RELEASED'
  );
});


test('PostgreSQL backend termination drops the barrier and writers recover instead of deadlocking forever', { skip: !enabled, timeout: 120_000 }, async () => {
  const table = 'spool_barrier_backend_termination';
  await reset(table);
  const writer = await client();
  const killer = await client();
  const barrier = await acquirePostgresTableShareLockBarrier({
    migrationId: 'barrier-backend-termination',
    sourceRef: sourceRef(table),
    credentialBroker: broker,
    lockTimeoutMs: 5_000,
    probeTimeoutMs: 100
  });
  try {
    assert.equal((await barrier.verifyHeld()).held, true);

    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    await expectLockTimeout(() =>
      writer.query(`UPDATE public."${table}" SET value='while-held' WHERE id=1`)
    );
    await writer.query('ROLLBACK');

    const killed = await killer.query('SELECT pg_catalog.pg_terminate_backend($1)::boolean AS terminated', [barrier.proof.backendPid]);
    assert.equal(killed.rows[0].terminated, true);

    // The locker connection is now dead. verifyHeld must fail closed.
    await assert.rejects(
      () => barrier.verifyHeld(),
      error => error?.code === 'WRITE_BARRIER_LOST'
    );

    // PostgreSQL releases transaction locks when the owning backend dies.
    const deadline = Date.now() + 10_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '500ms'");
        await writer.query(`UPDATE public."${table}" SET value='after-backend-loss' WHERE id=1`);
        await writer.query('COMMIT');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await writer.query('ROLLBACK').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.equal(lastError, null, `write remained blocked after barrier backend termination: ${lastError?.message ?? lastError}`);
  } finally {
    await barrier.release().catch(() => {});
    await writer.query('ROLLBACK').catch(() => {});
    await writer.end().catch(() => {});
    await killer.end().catch(() => {});
  }
});
