import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CLI exposes staged production commands and machine-readable help', () => {
  const child = spawnSync(process.execPath, ['src/cli/spool.js', '--help'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const help = JSON.parse(child.stdout);
  assert.equal(help.name, 'spool');
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
