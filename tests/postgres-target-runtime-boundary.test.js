import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const commandServiceSource = await readFile(new URL('../src/daemon/command-service.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('production command service registers PostgreSQL through the target runtime boundary', () => {
  assert.match(commandServiceSource, /POSTGRES_TARGET_DESCRIPTOR/);
  assert.match(commandServiceSource, /createPostgresTargetRuntime/);
  assert.equal(packageJson.dependencies?.pg, '8.23.0');
});
