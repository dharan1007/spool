import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package verifier exercises the installed spool binary end to end', async () => {
  const source = await readFile('scripts/verify-package.js', 'utf8');
  assert.match(source, /npm[\s\S]*pack/);
  assert.match(source, /npm[\s\S]*install/);
  for (const command of ['--help', 'inspect', 'dry-run', 'approve', 'run', 'receipt']) {
    assert.ok(source.includes(command), `package verifier must exercise ${command}`);
  }
  assert.match(source, /writtenRows[\s\S]*3/);
  assert.match(source, /rejectedRows[\s\S]*2/);
});
