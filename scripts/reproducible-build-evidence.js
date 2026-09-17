import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { collectArtifactEntries, artifactRootSha256, requireExactCommitSha } from '../src/platform/artifact-root.js';
import { fail } from '../src/core/errors.js';

const RELEASE_FILES = new Set(['release.json', 'release-manifest.json']);
const HOST_CONSUMED_CONFIG = new Set(['vercel.json']);

function environmentFingerprint() {
  const lockfile = readFileSync('package-lock.json', 'utf8');
  const lockfileSha256 = createHash('sha256').update(lockfile).digest('hex');
  const sourceTreeSha256 = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packageLockSha256: lockfileSha256,
    sourceTreeSha256,
    npmVersion: execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
  });
}

function buildInto(distDir) {
  const identity = requireExactCommitSha(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'build commit');
  const env = Object.freeze({
    ...process.env,
    SPOOL_COMMIT_SHA: identity,
    SPOOL_DIST_DIR: distDir,
    SPOOL_BUILD_TIME: '2026-01-01T00:00:00.000Z'
  });
  execFileSync(process.execPath, ['scripts/build-dist.js'], { env, stdio: 'inherit' });
  return { distDir, env };
}

async function collectRoot(distDir) {
  const artifacts = await collectArtifactEntries(distDir, { excluded: RELEASE_FILES, hostConsumed: HOST_CONSUMED_CONFIG });
  return { root: artifactRootSha256(artifacts), artifacts: artifacts.length };
}

async function main() {
  const first = await mkdtemp(join(tmpdir(), 'spool-repro-a-'));
  const second = await mkdtemp(join(tmpdir(), 'spool-repro-b-'));
  let outcome;
  try {
    const a = buildInto(first);
    const b = buildInto(second);
    const [aRoot, bRoot] = await Promise.all([collectRoot(a.distDir), collectRoot(b.distDir)]);
    const reproducible = aRoot.root === bRoot.root;
    if (!reproducible) fail('DIST_NOT_REPRODUCIBLE', `dist root differs between independent builds: ${aRoot.root} vs ${bRoot.root}`);
    const environment = environmentFingerprint();
    const evidence = Object.freeze({
      schemaVersion: 1,
      reproducible,
      buildA: { artifactRootSha256: aRoot.root, artifactCount: aRoot.artifacts },
      buildB: { artifactRootSha256: bRoot.root, artifactCount: bRoot.artifacts },
      environment,
      rebuiltAt: new Date().toISOString()
    });
    await mkdir('release', { recursive: true });
    await writeFile('release/reproducibility-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    outcome = evidence;
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ pass: true, ...outcome })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();