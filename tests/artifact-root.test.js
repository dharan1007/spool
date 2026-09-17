import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactRootSha256, sha256Bytes, requireExactCommitSha, requireSha256Digest, collectArtifactEntries } from '../src/platform/artifact-root.js';

async function fixtureTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'spool-artifacts-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test('artifact root is canonical, order-independent when sorted and rejects tampering', async () => {
  const root = await fixtureTree({ 'a.txt': 'hello', 'b.txt': 'world' });
  try {
    const artifacts = await collectArtifactEntries(root);
    assert.deepEqual(artifacts.map(e => e.path), ['a.txt', 'b.txt']);
    const again = await collectArtifactEntries(root);
    assert.equal(artifactRootSha256(artifacts), artifactRootSha256(again));
    const resorted = [...artifacts].reverse().sort((a, b) => a.path.localeCompare(b.path));
    assert.equal(artifactRootSha256(artifacts), artifactRootSha256(resorted));
    const tampered = [{ ...artifacts[0], sha256: sha256Bytes(Buffer.from('HELLO')) }];
    assert.notEqual(artifactRootSha256(tampered), artifactRootSha256(artifacts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact root excludes release metadata and host-consumed config when requested', async () => {
  const root = await fixtureTree({ 'release.json': '{}', 'vercel.json': '{}', 'app.js': 'x' });
  try {
    const all = await collectArtifactEntries(root);
    assert.deepEqual(all.map(e => e.path), ['app.js', 'release.json', 'vercel.json']);
    const filtered = await collectArtifactEntries(root, { excluded: new Set(['release.json']), hostConsumed: new Set(['vercel.json']) });
    assert.deepEqual(filtered.map(e => e.path), ['app.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact SHA validators reject malformed input', () => {
  assert.equal(requireExactCommitSha('A'.repeat(40).toLowerCase()), 'a'.repeat(40));
  assert.throws(() => requireExactCommitSha('short'), /INVALID_COMMIT_SHA/);
  assert.throws(() => requireExactCommitSha('g'.repeat(40)), /INVALID_COMMIT_SHA/);
  assert.equal(requireSha256Digest('F'.repeat(64).toLowerCase()), 'f'.repeat(64));
  assert.throws(() => requireSha256Digest('f'.repeat(63)), /INVALID_SHA256/);
});