import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const commandServiceSource = await readFile(new URL('../src/daemon/command-service.js', import.meta.url), 'utf8');

test('command service routes target behavior through connector registry/runtime instead of SQLite implementation classes', () => {
  assert.match(commandServiceSource, /ConnectorRegistry/);
  assert.match(commandServiceSource, /createSqliteTargetRuntime/);
  assert.match(commandServiceSource, /SQLITE_TARGET_DESCRIPTOR/);

  assert.doesNotMatch(commandServiceSource, /connectors\/sqlite\/target\.js/);
  assert.doesNotMatch(commandServiceSource, /connectors\/sqlite\/preflight\.js/);
  assert.doesNotMatch(commandServiceSource, /execution\/lease-store\.js/);
  assert.doesNotMatch(commandServiceSource, /new\s+SqliteTarget\s*\(/);
  assert.doesNotMatch(commandServiceSource, /new\s+LeaseStore\s*\(/);
});
