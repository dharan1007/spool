import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_POLICY } from '../src/platform/production-policy.js';
import { daemonConfigFromEnv, startSpoolDaemonV2 } from '../src/daemon/spoold-v2-main.js';

const TOKEN = 't'.repeat(32);
const SIGNING_KEY = 'k'.repeat(32);
const COMMIT = 'a'.repeat(40);

function env(overrides = {}) {
  return {
    SPOOL_DAEMON_TOKEN: TOKEN,
    SPOOL_APPROVAL_SIGNING_KEY: SIGNING_KEY,
    SPOOL_RELEASE_COMMIT_SHA: COMMIT,
    SPOOL_DAEMON_PORT: '0',
    ...overrides
  };
}

function readable(code, pattern) {
  return error => {
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  };
}

test('daemon configuration fails closed without credentials or release identity', () => {
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_DAEMON_TOKEN: undefined })), readable('INVALID_DAEMON_CONFIG', /SPOOL_DAEMON_TOKEN/));
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_DAEMON_TOKEN: 'short' })), readable('INVALID_DAEMON_CONFIG', /SPOOL_DAEMON_TOKEN/));
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_APPROVAL_SIGNING_KEY: undefined })), readable('INVALID_DAEMON_CONFIG', /SPOOL_APPROVAL_SIGNING_KEY/));
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_RELEASE_COMMIT_SHA: 'abc' })), readable('INVALID_DAEMON_CONFIG', /SPOOL_RELEASE_COMMIT_SHA/));
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_RELEASE_VERSION: '9.9.9' })), readable('INVALID_DAEMON_CONFIG', /policy release/));
  assert.throws(() => daemonConfigFromEnv(env({ SPOOL_DAEMON_PORT: '70000' })), readable('INVALID_DAEMON_CONFIG', /SPOOL_DAEMON_PORT/));
});

test('source ceiling cannot exceed the reviewed production policy', () => {
  const ceiling = daemonConfigFromEnv(env()).maxSourceBytes;
  assert.equal(ceiling, PRODUCTION_POLICY.maxSourceBytes);
  assert.equal(daemonConfigFromEnv(env({ SPOOL_SOURCE_CEILING_BYTES: String(1024 * 1024) })).maxSourceBytes, 1024 * 1024);
  assert.throws(
    () => daemonConfigFromEnv(env({ SPOOL_SOURCE_CEILING_BYTES: String(PRODUCTION_POLICY.maxSourceBytes + 1) })),
    readable('INVALID_DAEMON_CONFIG', /SPOOL_SOURCE_CEILING_BYTES/)
  );
});

test('production entrypoint serves real health, readiness and authenticated routes, then closes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'spool-daemon-entry-'));
  const logged = [];
  let running;
  try {
    running = await startSpoolDaemonV2(env({ SPOOL_STATE_DIR: stateDir }), { log: { info: line => logged.push(line) } });
    const base = `http://127.0.0.1:${running.address.port}`;
    assert.deepEqual(await (await fetch(`${base}/v2/health`)).json(), { status: 'ok' });
    assert.equal((await fetch(`${base}/v2/ready`)).status, 200);
    assert.equal((await fetch(`${base}/v2/migrations`)).status, 401);
    const listed = await fetch(`${base}/v2/migrations`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).ok, true);
    // The state directory is the only durable surface and holds the registry.
    assert.deepEqual((await readdir(stateDir)).filter(name => name === 'registry.db'), ['registry.db']);
    // One operator-visible line, and it never contains credentials.
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`listening on 127\\.0\\.0\\.1:${running.address.port}`));
    assert.ok(!logged[0].includes(TOKEN) && !logged[0].includes(SIGNING_KEY));
  } finally {
    if (running) await running.close();
  }
  // After close the listener is gone rather than lingering until process exit.
  const closedPort = running.address.port;
  await assert.rejects(fetch(`http://127.0.0.1:${closedPort}/v2/health`), /fetch failed/);
  await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
