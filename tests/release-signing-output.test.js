import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { artifactRootSha256 } from '../src/platform/artifact-root.js';
import { verifySignedReleaseEnvelope } from '../src/platform/release-chain.js';

test('real signing writes absolute external evidence without modifying tracked historical provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-sign-output-'));
  const script = resolve('scripts/sign-release.js');
  try {
    const source = join(root, 'source');
    const dist = join(source, 'dist');
    await mkdir(join(source, 'release'), { recursive: true });
    await mkdir(dist);
    const historical = await readFile(resolve('release/parity-evidence.json'), 'utf8');
    await writeFile(join(source, 'release/parity-evidence.json'), historical);
    const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git(['init', '--quiet']); git(['add', 'release/parity-evidence.json']);
    git(['-c', 'user.name=Release regression', '-c', 'user.email=release-regression@example.invalid', 'commit', '--quiet', '-m', 'Historical provenance fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    const bytes = Buffer.from('SPOOL release signing regression\n');
    const artifacts = [{ path: 'index.html', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
    const artifactRoot = artifactRootSha256(artifacts);
    await writeFile(join(dist, 'index.html'), bytes);
    await writeFile(join(dist, 'release.json'), JSON.stringify({ version: '1.1.2', commit, artifactRootSha256: artifactRoot }));
    await writeFile(join(dist, 'release-manifest.json'), JSON.stringify({ releaseCommit: commit, artifactRootSha256: artifactRoot, artifacts }));
    const key = generateKeyPairSync('ed25519');
    const output = join(root, 'external', 'attempt', 'parity-evidence.json');
    const run = (parityPath = output) => spawnSync(process.execPath, [script], { cwd: source, encoding: 'utf8', env: {
      ...process.env, SPOOL_DIST_DIR: dist, EXPECTED_SHA: commit, SPOOL_RELEASE_VERSION: '1.1.2',
      SPOOL_PARITY_EVIDENCE: parityPath,
      SPOOL_RELEASE_PRIVATE_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' })
    } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).unchanged, false);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    verifySignedReleaseEnvelope(evidence.envelope, key.publicKey.export({ type: 'spki', format: 'pem' }), { expectedCommit: commit, expectedRoot: artifactRoot });
    assert.equal(await readFile(join(source, 'release/parity-evidence.json'), 'utf8'), historical);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '');
    assert.equal(existsSync(join(source, 'external')), false);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).unchanged, true);
    const forbidden = run(join(source, 'release/parity-evidence.json'));
    assert.equal(forbidden.status, 1);
    assert.match(forbidden.stderr, /RELEASE_EVIDENCE_PATH/);
    assert.equal(await readFile(join(source, 'release/parity-evidence.json'), 'utf8'), historical);
  } finally {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.equal((await lstat(absolute)).isSymbolicLink(), false);
    await rm(absolute, { recursive: true, force: true });
  }
});
