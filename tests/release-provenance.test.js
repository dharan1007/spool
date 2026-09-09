import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function buildWithReleaseEnv(env = {}) {
  return spawnSync(process.execPath, ['scripts/build-dist.js'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

test('release build emits commit-bound release.json when release identity is supplied', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = buildWithReleaseEnv({
    SPOOL_RELEASE_VERSION: '1.1.0-test',
    SPOOL_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    SPOOL_BUILD_TIME: '2026-09-09T09:30:00.000Z'
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  assert.deepEqual(release, {
    schemaVersion: 1,
    version: '1.1.0-test',
    commit: '0123456789abcdef0123456789abcdef01234567',
    builtAt: '2026-09-09T09:30:00.000Z',
    transport: 'same-origin-es-modules'
  });
});

test('release build never invents a production commit identity', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = buildWithReleaseEnv({
    SPOOL_RELEASE_VERSION: '1.1.0-test',
    SPOOL_COMMIT_SHA: '',
    SPOOL_BUILD_TIME: '2026-09-09T09:30:00.000Z'
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  assert.equal(release.commit, null);
  assert.equal(release.version, '1.1.0-test');
});
