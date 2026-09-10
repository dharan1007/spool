import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('CLI exposes staged production commands and machine-readable help', () => {
  const child = spawnSync(process.execPath, ['src/cli/spool.js', '--help'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const help = JSON.parse(child.stdout);
  assert.equal(help.name, 'spool');
  assert.match(help.usage, /--out/);
  for (const command of ['inspect', 'plan', 'dry-run', 'approve', 'run', 'status', 'verify', 'receipt']) {
    assert.ok(help.commands.includes(command));
  }
});

test('CLI rejects missing required configuration with stable JSON error envelope', () => {
  const child = spawnSync(process.execPath, ['src/cli/spool.js', 'inspect'], { encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  const error = JSON.parse(child.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'CLI_USAGE');
  assert.ok(Array.isArray(error.error.nextActions));
});

test('CLI sanitizes unexpected storage failures instead of exposing internal exception text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-cli-error-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  const stateDirectory = join(dir, 'state-as-directory');
  mkdirSync(sourceRoot);
  mkdirSync(targetRoot);
  mkdirSync(stateDirectory);
  const requestPath = join(dir, 'request.json');
  writeFileSync(requestPath, JSON.stringify({ migrationId: 'mig_cli_error' }));
  try {
    const child = spawnSync(process.execPath, [
      'src/cli/spool.js', 'inspect',
      '--request', requestPath,
      '--source-root', sourceRoot,
      '--target-root', targetRoot,
      '--state', stateDirectory
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SPOOL_APPROVAL_KEY: '0123456789abcdef0123456789abcdef',
        SPOOL_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567'
      }
    });
    assert.notEqual(child.status, 0);
    const envelope = JSON.parse(child.stderr);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
    assert.equal(envelope.error.message, 'Unexpected internal error');
    assert.doesNotMatch(child.stderr, /state-as-directory|database|sqlite/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
