import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteJobStore } from '../src/daemon/sqlite-job-store.js';
import { createSpooldRuntime } from '../src/daemon/runtime.js';

async function tempStateDir() {
  return mkdtemp(join(tmpdir(), 'spoold-runtime-'));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function modeBits(value) {
  return value.mode & 0o777;
}

async function command(descriptor, token, name, body = {}) {
  return fetch(`${descriptor.endpoint}/v1/commands/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function firstJsonLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => cleanup(new Error('Timed out waiting for spoold descriptor')), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      try { cleanup(null, JSON.parse(line)); }
      catch (error) { cleanup(error); }
    };
    const onError = error => cleanup(error);
    const cleanup = (error, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

function childExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for spoold child exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('self-hosted runtime generates durable private pairing credentials and a token-free live descriptor', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  const descriptorPath = join(stateDir, 'spoold.json');
  const pairingPath = join(stateDir, 'spoold-pairing.json');
  let firstToken;

  try {
    const first = await runtime.start();
    const descriptor = await readJson(descriptorPath);
    const pairing = await readJson(pairingPath);
    firstToken = pairing.token;

    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.protocolVersion, 'spoold-v1');
    assert.equal(descriptor.host, '127.0.0.1');
    assert.equal(descriptor.port, first.port);
    assert.equal(descriptor.endpoint, `http://127.0.0.1:${first.port}`);
    assert.equal(descriptor.auth.type, 'bearer');
    assert.equal(descriptor.auth.credentialFile, 'spoold-pairing.json');
    assert.equal(descriptor.instanceId, pairing.instanceId);
    assert.equal(typeof pairing.token, 'string');
    assert.match(pairing.token, /^[a-f0-9]{64,}$/);
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(pairing.token));

    assert.equal(modeBits(await stat(stateDir)), 0o700);
    assert.equal(modeBits(await stat(pairingPath)), 0o600);
    assert.equal(modeBits(await stat(descriptorPath)), 0o600);

    const response = await command(descriptor, pairing.token, 'list_connectors');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.result.map(item => item.name), ['filesystem', 'sqlite']);
  } finally {
    await runtime.close();
  }

  await assert.rejects(() => access(descriptorPath), error => error?.code === 'ENOENT');
  await access(pairingPath);

  const secondRuntime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await secondRuntime.start();
    const secondPairing = await readJson(pairingPath);
    assert.equal(secondPairing.token, firstToken);
  } finally {
    await secondRuntime.close();
  }
});

test('runtime performs startup recovery before publishing the live daemon descriptor', async () => {
  const stateDir = await tempStateDir();
  const seedStore = new SQLiteJobStore({ stateDir });
  const created = await seedStore.create({ planId: 'sha256:runtime-recovery-plan', planRevision: 1 });
  const running = await seedStore.update(created.jobId, job => ({ ...job, state: 'RUNNING' }), {
    expectedStateVersion: created.stateVersion,
    expectedExecutionEpoch: created.executionEpoch
  });
  await seedStore.acquireExecution(running.jobId, {
    expectedStateVersion: running.stateVersion,
    ownerId: 'orphaned-runtime-owner',
    leaseMs: 60_000
  });
  seedStore.close();

  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const descriptor = await readJson(join(stateDir, 'spoold.json'));
    const pairing = await readJson(join(stateDir, 'spoold-pairing.json'));
    const response = await command(descriptor, pairing.token, 'inspect_job', { jobId: created.jobId });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.state, 'RECOVERY_REQUIRED');
    assert.equal(payload.result.executionOwner, undefined);
  } finally {
    await runtime.close();
  }
});

test('runtime enforces one live daemon per state directory and releases ownership on clean shutdown', async () => {
  const stateDir = await tempStateDir();
  const first = await createSpooldRuntime({ stateDir, port: 0 });
  const second = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await first.start();
    await assert.rejects(() => second.start(), /already running|lock/i);
  } finally {
    await second.close();
    await first.close();
  }

  const third = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    const descriptor = await third.start();
    assert.equal(descriptor.protocolVersion, 'spoold-v1');
  } finally {
    await third.close();
  }
});

test('runtime refuses non-loopback composition before writing live daemon state', async () => {
  const stateDir = await tempStateDir();
  await assert.rejects(
    () => createSpooldRuntime({ stateDir, host: '0.0.0.0', port: 0 }),
    /loopback/i
  );
  await assert.rejects(() => access(join(stateDir, 'spoold.json')), error => error?.code === 'ENOENT');
});

test('daemon entrypoint starts from environment and removes live descriptor on SIGTERM', async () => {
  const stateDir = await tempStateDir();
  const child = spawn(process.execPath, ['src/daemon/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SPOOL_STATE_DIR: stateDir,
      SPOOLD_HOST: '127.0.0.1',
      SPOOLD_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const announced = await firstJsonLine(child.stdout);
    assert.equal(announced.protocolVersion, 'spoold-v1');
    assert.equal(announced.host, '127.0.0.1');
    assert.equal(Number.isInteger(announced.port), true);
    const persisted = await readJson(join(stateDir, 'spoold.json'));
    assert.equal(persisted.endpoint, announced.endpoint);

    const exitPromise = childExit(child);
    assert.equal(child.kill('SIGTERM'), true);
    const exited = await exitPromise;
    assert.equal(exited.code, 0);
    assert.equal(exited.signal, null);
    await assert.rejects(() => access(join(stateDir, 'spoold.json')), error => error?.code === 'ENOENT');
    await access(join(stateDir, 'spoold-pairing.json'));
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
});
