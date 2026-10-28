// Release gate decision logic, injectable for deterministic qualification.
//
// The CLI wrapper (scripts/release-gate.js) supplies the real step runner;
// tests inject a recording runner so the fail-closed signing rule is proven
// without executing builds. The rule itself is NOT injectable: a build whose
// commit carries no signing evidence is always rejected.
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';

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

export function resolveCommit(env = process.env) {
  for (const name of ['SPOOL_COMMIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA']) {
    const value = env[name]?.trim() || '';
    if (!value) continue;
    if (!EXACT_GIT_SHA.test(value)) fail('INVALID_COMMIT_SHA', `${name} must be an exact 40-character Git commit SHA`);
    return value.toLowerCase();
  }
  return gitHead();
}

function realStepRunner(script, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: Object.freeze({ ...process.env, ...env })
  });
  if (result.error) fail('RELEASE_GATE_SPAWN', `${script} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail('RELEASE_GATE_FAILED', `${script} exited with status ${result.status}`);
}

// Runs the full release gate. `stepRunner(script, env)` executes one gate step;
// failures are typed SpoolError exits. A release commit WITHOUT signing keys
// always fails CLOSED with UNSIGNED_BUILD — there is no flag, marker or
// historical evidence path that qualifies it.
export function releaseGate(env = process.env, { stepRunner = realStepRunner, write = line => process.stdout.write(line) } = {}) {
  const commit = resolveCommit(env);
  if (!commit) fail('RELEASE_COMMIT', 'No exact commit SHA available; set SPOOL_COMMIT_SHA or run inside a Git worktree');
  write(`release-gate: binding SHA=${commit}\n`);

  stepRunner('scripts/build-dist.js', { SPOOL_COMMIT_SHA: commit });
  stepRunner('benchmarks/run.js', { SPOOL_COMMIT_SHA: commit });
  stepRunner('scripts/static-check.js', {});
  stepRunner('scripts/verify-release-chain.js', {
    SPOOL_DIST_DIR: env.SPOOL_DIST_DIR?.trim() || 'dist',
    EXPECTED_SHA: env.EXPECTED_SHA?.trim() || commit,
    SPOOL_RELEASE_PUBLIC_KEY: env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key',
    // Validate built bytes before generating this attempt's signed evidence.
    SPOOL_PARITY_EVIDENCE: ''
  });
  stepRunner('scripts/reproducible-build-evidence.js', { SPOOL_COMMIT_SHA: commit });

  const privateKey = env.SPOOL_RELEASE_PRIVATE_KEY?.trim() || '';
  if (privateKey) {
    const parityEvidence = env.SPOOL_PARITY_EVIDENCE?.trim() || resolve(
      env.SPOOL_QUALIFICATION_EVIDENCE_ROOT || join('..', 'evidence'),
      'release-signatures', commit, randomUUID(), 'parity-evidence.json');
    stepRunner('scripts/sign-release.js', {
      SPOOL_RELEASE_PRIVATE_KEY: privateKey,
      SPOOL_DIST_DIR: env.SPOOL_DIST_DIR?.trim() || 'dist',
      EXPECTED_SHA: commit,
      SPOOL_PARITY_EVIDENCE: parityEvidence
    });
    stepRunner('scripts/verify-release-chain.js', {
      SPOOL_DIST_DIR: env.SPOOL_DIST_DIR?.trim() || 'dist',
      EXPECTED_SHA: commit,
      SPOOL_RELEASE_PUBLIC_KEY: env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key',
      SPOOL_PARITY_EVIDENCE: parityEvidence
    });
    write(`release-gate: SIGNED_RELEASE_VERIFIED ${commit}\n`);
  } else {
    write('release-gate: SPOOL_RELEASE_PRIVATE_KEY not supplied; cannot verify signed release\n');
    fail('UNSIGNED_BUILD', 'Release cannot be qualified without signing evidence; set SPOOL_RELEASE_PRIVATE_KEY or build with authorized release keys');
  }
  write(`release-gate: PASS ${commit}\n`);
}
