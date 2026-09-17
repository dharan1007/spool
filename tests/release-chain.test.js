import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSigningKeyPair } from '../src/platform/signing.js';
import { buildReleaseChain, signedReleaseEnvelope, verifySignedReleaseEnvelope, loadReleaseChain } from '../src/platform/release-chain.js';
import { artifactRootSha256 } from '../src/platform/artifact-root.js';

function sha256Bytes(body) {
  return createHash('sha256').update(body).digest('hex');
}

async function fixtureDist(files, commit) {
  const dist = await mkdtemp(join(tmpdir(), 'spool-dist-'));
  const artifacts = [];
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dist, relative);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
    const body = Buffer.from(content, 'utf8');
    artifacts.push({ path: relative, size: body.byteLength, sha256: sha256Bytes(body) });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const root = artifactRootSha256(artifacts);
  const release = { schemaVersion: 2, version: '1.0.0', commit, artifactRootSha256: root, manifest: '/release-manifest.json' };
  const manifest = {
    schemaVersion: 2,
    releaseCommit: commit,
    artifactHashAlgorithm: 'sha256',
    artifactRootSha256: root,
    artifacts
  };
  await writeFile(join(dist, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  await writeFile(join(dist, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dist, release, manifest, root };
}

test('release chain binds commit, dist root, release.json and manifest deterministically', async () => {
  const commit = 'c'.repeat(40);
  const fixture = await fixtureDist({ 'src/app.js': 'const app = 1;' }, commit);
  try {
    const chain = await buildReleaseChain({ distDir: fixture.dist, release: fixture.release, manifest: fixture.manifest, commit, sourceCommitResolved: commit });
    assert.equal(chain.commit, commit);
    assert.equal(chain.artifactRootSha256, fixture.root);
    assert.equal(chain.artifactCount, 1);
  } finally {
    await rm(fixture.dist, { recursive: true, force: true });
  }
});

test('release chain fails closed on dist root disagreement with manifest or release.json', async () => {
  const commit = 'c'.repeat(40);
  const fixture = await fixtureDist({ 'src/app.js': 'const app = 1;' }, commit);
  try {
    const badRelease = { ...fixture.release, artifactRootSha256: '0'.repeat(64) };
    await assert.rejects(() => buildReleaseChain({ distDir: fixture.dist, release: badRelease, manifest: fixture.manifest, commit, sourceCommitResolved: commit }), /DIST_ROOT_MISMATCH/);
    const badManifest = { ...fixture.manifest, artifactRootSha256: '1'.repeat(64) };
    await assert.rejects(() => buildReleaseChain({ distDir: fixture.dist, release: fixture.release, manifest: badManifest, commit, sourceCommitResolved: commit }), /DIST_ROOT_MISMATCH/);
    await assert.rejects(() => buildReleaseChain({ distDir: fixture.dist, release: fixture.release, manifest: fixture.manifest, commit: 'd'.repeat(40), sourceCommitResolved: commit }), /RELEASE_COMMIT_MISMATCH/);
  } finally {
    await rm(fixture.dist, { recursive: true, force: true });
  }
});

test('signed release envelope signs and verifies with the exact bound identity', () => {
  const { publicKey, privateKey } = generateSigningKeyPair();
  const envelope = signedReleaseEnvelope({ version: '1.0.0', commit: 'c'.repeat(40), artifactRootSha256: 'f'.repeat(64), generatedAt: '2026-09-14T00:00:00.000Z', privateKey });
  assert.equal(envelope.payload.domain, 'release-parity-v1');
  const verified = verifySignedReleaseEnvelope(envelope, publicKey, { expectedCommit: 'c'.repeat(40), expectedRoot: 'f'.repeat(64) });
  assert.equal(verified.version, '1.0.0');
});

test('signed release envelope rejects wrong key, wrong commit and tampered payload', () => {
  const { publicKey, privateKey } = generateSigningKeyPair();
  const other = generateSigningKeyPair();
  const envelope = signedReleaseEnvelope({ version: '1.0.0', commit: 'c'.repeat(40), artifactRootSha256: 'f'.repeat(64), generatedAt: '2026-09-14T00:00:00.000Z', privateKey });
  assert.throws(() => verifySignedReleaseEnvelope(envelope, other.publicKey), /RELEASE_SIGNATURE_INVALID/);
  assert.throws(() => verifySignedReleaseEnvelope(envelope, publicKey, { expectedCommit: '0'.repeat(40) }), /RELEASE_ENVELOPE_COMMIT_MISMATCH/);
  const tampered = { ...envelope, payload: { ...envelope.payload, artifactRootSha256: '0'.repeat(64) } };
  assert.throws(() => verifySignedReleaseEnvelope(tampered, publicKey), /RELEASE_SIGNATURE_INVALID/);
  assert.throws(() => verifySignedReleaseEnvelope({ ...envelope, payload: { ...envelope.payload, domain: 'wrong' } }, publicKey), /RELEASE_ENVELOPE_DOMAIN/);
});

test('release chain loads from a real dist directory with coherent identity', async () => {
  const commit = 'c'.repeat(40);
  const fixture = await fixtureDist({ 'src/app.js': 'const app = 1;' }, commit);
  try {
    const chain = await loadReleaseChain({ distDir: fixture.dist, commit, sourceCommitResolved: commit });
    assert.equal(chain.artifactRootSha256, fixture.root);
    assert.equal(chain.version, '1.0.0');
  } finally {
    await rm(fixture.dist, { recursive: true, force: true });
  }
});