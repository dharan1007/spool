import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpooldRuntime } from '../src/daemon/runtime.js';
import { SpooldClient, discoverSpoold } from '../src/client/spoold-client.js';

async function tempStateDir() {
  return mkdtemp(join(tmpdir(), 'spoold-client-'));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function runCli(args, { env = process.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli/main.js', ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (stdin == null) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

test('spoold client discovers live descriptor and private pairing credential then executes a real command', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    const descriptor = await runtime.start();
    const pairing = await readJson(join(stateDir, 'spoold-pairing.json'));
    const discovered = await discoverSpoold({ stateDir });

    assert.equal(discovered.descriptor.instanceId, descriptor.instanceId);
    assert.equal(discovered.descriptor.protocolVersion, 'spoold-v1');
    assert.equal(discovered.token, pairing.token);
    assert.doesNotMatch(JSON.stringify(discovered.descriptor), new RegExp(pairing.token));

    const client = await SpooldClient.fromStateDir({ stateDir });
    const connectors = await client.command('list_connectors', {});
    assert.deepEqual(connectors.map(item => item.name), ['filesystem', 'sqlite']);
  } finally {
    await runtime.close();
  }
});

test('spoold client accepts lifecycle commands and preserves daemon rejection codes', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const client = await SpooldClient.fromStateDir({ stateDir });
    await assert.rejects(
      () => client.command('pause_job', { jobId: 'job_missing' }),
      error => error?.code === 'JOB_NOT_FOUND'
    );
    await assert.rejects(
      () => client.command('resume_job', { jobId: 'job_missing' }),
      error => error?.code === 'JOB_NOT_FOUND'
    );
  } finally {
    await runtime.close();
  }
});

test('spoold discovery rejects protocol drift before opening a command connection', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const descriptorPath = join(stateDir, 'spoold.json');
    const descriptor = await readJson(descriptorPath);
    descriptor.protocolVersion = 'spoold-v999';
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    await assert.rejects(
      () => discoverSpoold({ stateDir }),
      error => error?.code === 'SPOOLD_PROTOCOL_UNSUPPORTED'
    );
  } finally {
    await runtime.close();
  }
});

test('spoold discovery rejects credential path traversal and instance mismatch', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const descriptorPath = join(stateDir, 'spoold.json');
    const original = await readJson(descriptorPath);

    await writeFile(descriptorPath, `${JSON.stringify({
      ...original,
      auth: { ...original.auth, credentialFile: '../stolen.json' }
    }, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => discoverSpoold({ stateDir }),
      error => error?.code === 'SPOOLD_CREDENTIAL_PATH_INVALID'
    );

    await writeFile(descriptorPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    const pairingPath = join(stateDir, original.auth.credentialFile);
    const pairing = await readJson(pairingPath);
    pairing.instanceId = 'different-instance';
    await writeFile(pairingPath, `${JSON.stringify(pairing, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => discoverSpoold({ stateDir }),
      error => error?.code === 'SPOOLD_INSTANCE_MISMATCH'
    );
  } finally {
    await runtime.close();
  }
});

test('CLI is a thin spoold client with machine-readable success output', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const result = await runCli(['list_connectors', '--state-dir', stateDir]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.command, 'list_connectors');
    assert.deepEqual(output.result.map(item => item.name), ['filesystem', 'sqlite']);
  } finally {
    await runtime.close();
  }
});

test('CLI recognizes lifecycle commands and reports remote command failures rather than usage errors', async () => {
  const stateDir = await tempStateDir();
  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    for (const command of ['pause_job', 'resume_job']) {
      const result = await runCli([command, '--state-dir', stateDir, '--stdin'], {
        stdin: JSON.stringify({ jobId: 'job_missing' })
      });
      assert.equal(result.code, 4);
      const output = JSON.parse(result.stderr);
      assert.equal(output.ok, false);
      assert.equal(output.error.code, 'JOB_NOT_FOUND');
      assert.notEqual(output.error.code, 'CLI_USAGE_ERROR');
    }
  } finally {
    await runtime.close();
  }
});

test('CLI reads command request JSON from stdin and returns stable daemon-discovery exit code', async () => {
  const stateDir = await tempStateDir();
  const missing = await runCli(['list_connectors', '--state-dir', stateDir]);
  assert.equal(missing.code, 3);
  const missingOutput = JSON.parse(missing.stderr);
  assert.equal(missingOutput.ok, false);
  assert.equal(missingOutput.error.code, 'SPOOLD_NOT_RUNNING');
  assert.equal(missingOutput.error.message, 'Unable to connect to local spoold');

  const runtime = await createSpooldRuntime({ stateDir, port: 0 });
  try {
    await runtime.start();
    const put = await runCli(['put_connection', '--state-dir', stateDir, '--stdin'], {
      stdin: JSON.stringify({ name: 'localfs', type: 'filesystem', config: { root: stateDir } })
    });
    assert.equal(put.code, 0);
    const output = JSON.parse(put.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.name, 'localfs');
    assert.equal(output.result.type, 'filesystem');
  } finally {
    await runtime.close();
  }
});

test('CLI rejects unknown options without exposing daemon credentials', async () => {
  const result = await runCli(['list_connectors', '--token', 'should-never-be-accepted']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stderr);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'CLI_USAGE_ERROR');
  assert.doesNotMatch(result.stderr, /should-never-be-accepted/);
});

test('package exposes the spool CLI without replacing the spoold daemon entrypoint', async () => {
  const pkg = await readJson(join(process.cwd(), 'package.json'));
  assert.equal(pkg.scripts.spoold, 'node src/daemon/main.js');
  assert.equal(pkg.scripts.spool, 'node src/cli/main.js');
  assert.equal(pkg.bin.spool, 'src/cli/main.js');
});
