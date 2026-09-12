import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function buildWithReleaseEnv(env = {}) {
  return spawnSync(process.execPath, ['scripts/build-dist.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SPOOL_COMMIT_SHA: '',
      VERCEL_GIT_COMMIT_SHA: '',
      GITHUB_SHA: '',
      SPOOL_REQUIRE_RELEASE_IDENTITY: '',
      VERCEL: '',
      ...env
    }
  });
}

test('release build emits commit-bound v2 provenance when release identity is supplied', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = buildWithReleaseEnv({
    SPOOL_RELEASE_VERSION: '1.1.0-test',
    SPOOL_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    SPOOL_BUILD_TIME: '2026-09-09T09:30:00.000Z'
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  assert.equal(release.schemaVersion, 2);
  assert.equal(release.version, '1.1.0-test');
  assert.equal(release.commit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(release.commitSource, 'SPOOL_COMMIT_SHA');
  assert.equal(release.builtAt, '2026-09-09T09:30:00.000Z');
  assert.equal(release.transport, 'same-origin-es-modules');
  assert.equal(release.manifest, '/release-manifest.json');
  assert.match(release.artifactRootSha256, /^[a-f0-9]{64}$/);
});

test('local build never invents a production commit identity when every supported identity source is absent', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = buildWithReleaseEnv({
    SPOOL_RELEASE_VERSION: '1.1.0-test',
    SPOOL_BUILD_TIME: '2026-09-09T09:30:00.000Z'
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  assert.equal(release.commit, null);
  assert.equal(release.commitSource, null);
  assert.equal(release.version, '1.1.0-test');
  assert.match(release.artifactRootSha256, /^[a-f0-9]{64}$/);
});
