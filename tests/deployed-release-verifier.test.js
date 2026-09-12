import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function rootFor(entries) {
  const canonical = entries
    .map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return sha256(canonical);
}

function response(body, status = 200) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(bytes.toString('utf8')); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
}

function releaseFixture({ commit = '0123456789abcdef0123456789abcdef01234567', artifactBody = 'console.log("verified");\n', artifactPath = 'src/app.js' } = {}) {
  const bytes = Buffer.from(artifactBody);
  const artifacts = [{ path: artifactPath, size: bytes.byteLength, sha256: sha256(bytes) }];
  const artifactRootSha256 = rootFor(artifacts);
  const release = {
    schemaVersion: 2,
    version: '1.1.1-test',
    commit,
    builtAt: '2026-09-13T00:00:00.000Z',
    transport: 'same-origin-es-modules',
    artifactRootSha256,
    manifest: '/release-manifest.json'
  };
  const manifest = {
    schemaVersion: 2,
    releaseCommit: commit,
    artifactHashAlgorithm: 'sha256',
    artifactRootSha256,
    artifacts
  };
  return { release, manifest, bytes, artifactPath };
}

async function loadVerifier() {
  return import('../scripts/verify-deployed-release.js');
}

test('deployed release verifier proves commit, manifest root, and every declared artifact digest', async () => {
  const fixture = releaseFixture();
  const requested = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === '/release.json') return response(JSON.stringify(fixture.release));
    if (path === '/release-manifest.json') return response(JSON.stringify(fixture.manifest));
    if (path === `/${fixture.artifactPath}`) return response(fixture.bytes);
    return response('missing', 404);
  };
  const { verifyDeployedRelease } = await loadVerifier();
  const result = await verifyDeployedRelease({
    baseUrl: 'https://example.test',
    expectedCommit: fixture.release.commit,
    fetchImpl
  });
  assert.equal(result.commit, fixture.release.commit);
  assert.equal(result.artifactRootSha256, fixture.release.artifactRootSha256);
  assert.equal(result.artifactCount, 1);
  assert.deepEqual(requested, ['/release.json', '/release-manifest.json', '/src/app.js']);
});

test('deployed release verifier fails closed when a deployed artifact was modified after the manifest was built', async () => {
  const fixture = releaseFixture();
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === '/release.json') return response(JSON.stringify(fixture.release));
    if (path === '/release-manifest.json') return response(JSON.stringify(fixture.manifest));
    if (path === `/${fixture.artifactPath}`) return response('tampered');
    return response('missing', 404);
  };
  const { verifyDeployedRelease } = await loadVerifier();
  await assert.rejects(
    () => verifyDeployedRelease({ baseUrl: 'https://example.test', expectedCommit: fixture.release.commit, fetchImpl }),
    error => error?.code === 'ARTIFACT_SIZE_MISMATCH' || error?.code === 'ARTIFACT_DIGEST_MISMATCH'
  );
});

test('deployed release verifier rejects a valid manifest for the wrong source commit', async () => {
  const fixture = releaseFixture();
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === '/release.json') return response(JSON.stringify(fixture.release));
    if (path === '/release-manifest.json') return response(JSON.stringify(fixture.manifest));
    if (path === `/${fixture.artifactPath}`) return response(fixture.bytes);
    return response('missing', 404);
  };
  const { verifyDeployedRelease } = await loadVerifier();
  await assert.rejects(
    () => verifyDeployedRelease({ baseUrl: 'https://example.test', expectedCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', fetchImpl }),
    error => error?.code === 'DEPLOYED_COMMIT_MISMATCH'
  );
});

test('deployed release verifier rejects unsafe manifest paths before fetching them', async () => {
  const fixture = releaseFixture({ artifactPath: '../secret.txt' });
  const requested = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === '/release.json') return response(JSON.stringify(fixture.release));
    if (path === '/release-manifest.json') return response(JSON.stringify(fixture.manifest));
    return response('should-not-fetch', 200);
  };
  const { verifyDeployedRelease } = await loadVerifier();
  await assert.rejects(
    () => verifyDeployedRelease({ baseUrl: 'https://example.test', expectedCommit: fixture.release.commit, fetchImpl }),
    error => error?.code === 'UNSAFE_ARTIFACT_PATH'
  );
  assert.deepEqual(requested, ['/release.json', '/release-manifest.json']);
});
