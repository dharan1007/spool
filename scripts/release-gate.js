import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../src/core/errors.js';

const EXACT_GIT_SHA = /^[a-f0-9]{40}$/i;

function gitHead() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!EXACT_GIT_SHA.test(sha)) return null;
    return sha.toLowerCase();
  } catch {
    return null;
  }
}

function resolveCommit() {
  for (const name of ['SPOOL_COMMIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA', 'CF_PAGES_COMMIT_SHA']) {
    const value = process.env[name]?.trim() || '';
    if (!value) continue;
    if (!EXACT_GIT_SHA.test(value)) fail('INVALID_COMMIT_SHA', `${name} must be an exact 40-character Git commit SHA`);
    return value.toLowerCase();
  }
  return gitHead();
}

function run(script, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: Object.freeze({ ...process.env, ...env })
  });
  if (result.error) fail('RELEASE_GATE_SPAWN', `${script} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail('RELEASE_GATE_FAILED', `${script} exited with status ${result.status}`);
}

function gate() {
  const commit = resolveCommit();
  if (!commit) fail('RELEASE_COMMIT', 'No exact commit SHA available; set SPOOL_COMMIT_SHA or run inside a Git worktree');
  process.stdout.write(`release-gate: binding SHA=${commit}\n`);

  run('scripts/build-dist.js', { SPOOL_COMMIT_SHA: commit });
  run('benchmarks/run.js', { SPOOL_COMMIT_SHA: commit });
  run('scripts/static-check.js');
  run('scripts/verify-release-chain.js', {
    SPOOL_DIST_DIR: process.env.SPOOL_DIST_DIR?.trim() || 'dist',
    EXPECTED_SHA: process.env.EXPECTED_SHA?.trim() || commit,
    SPOOL_RELEASE_PUBLIC_KEY: process.env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key',
    // Validate built bytes before generating this attempt's signed evidence.
    SPOOL_PARITY_EVIDENCE: ''
  });
  run('scripts/reproducible-build-evidence.js', { SPOOL_COMMIT_SHA: commit });

  const privateKey = process.env.SPOOL_RELEASE_PRIVATE_KEY?.trim() || '';
  if (privateKey) {
    const parityEvidence = process.env.SPOOL_PARITY_EVIDENCE?.trim() || resolve(
      process.env.SPOOL_QUALIFICATION_EVIDENCE_ROOT || join('..', 'evidence'),
      'release-signatures', commit, randomUUID(), 'parity-evidence.json');
    run('scripts/sign-release.js', {
      SPOOL_RELEASE_PRIVATE_KEY: privateKey,
      SPOOL_DIST_DIR: process.env.SPOOL_DIST_DIR?.trim() || 'dist',
      EXPECTED_SHA: commit,
      SPOOL_PARITY_EVIDENCE: parityEvidence
    });
    run('scripts/verify-release-chain.js', {
      SPOOL_DIST_DIR: process.env.SPOOL_DIST_DIR?.trim() || 'dist',
      EXPECTED_SHA: commit,
      SPOOL_RELEASE_PUBLIC_KEY: process.env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key',
      SPOOL_PARITY_EVIDENCE: parityEvidence
    });
  } else {
    process.stdout.write('release-gate: SPOOL_RELEASE_PRIVATE_KEY not supplied; signed parity evidence skipped\n');
  }
  process.stdout.write(`release-gate: PASS ${commit}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) gate();
