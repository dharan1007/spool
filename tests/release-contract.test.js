import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { qualificationPlan, validateBoundEvidence } from '../scripts/qualify-bounded-release.js';
import { releaseGate } from '../src/release/gate.js';

test('release gate fails closed when no signing evidence is configured', () => {
  const steps = [];
  const output = [];
  let thrown = null;
  try {
    // Qualification steps are stubbed by the injected runner; the UNSIGNED
    // decision itself is the behavior under test and stays real.
    releaseGate(
      { SPOOL_COMMIT_SHA: 'a'.repeat(40) },
      { stepRunner: (script, env) => steps.push([script, env.SPOOL_PARITY_EVIDENCE ?? null]), write: line => output.push(line) }
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'gate must throw without signing evidence');
  assert.equal(thrown.code, 'UNSIGNED_BUILD');
  // All qualification steps still ran in order before the fail-closed decision...
  assert.deepEqual(steps.map(([script]) => script), [
    'scripts/build-dist.js',
    'benchmarks/run.js',
    'scripts/static-check.js',
    'scripts/verify-release-chain.js',
    'scripts/reproducible-build-evidence.js'
  ]);
  // ...and NO signing step may exist without signing material.
  assert.ok(!output.some(line => line.includes('SIGNED_RELEASE_VERIFIED')));
});

test('release gate verifies signed evidence when signing keys are configured', () => {
  const steps = [];
  const output = [];
  releaseGate(
    { SPOOL_COMMIT_SHA: 'b'.repeat(40), SPOOL_RELEASE_PRIVATE_KEY: 'x'.repeat(64) },
    { stepRunner: (script, env) => steps.push([script, env.SPOOL_PARITY_EVIDENCE ?? null]), write: line => output.push(line) }
  );
  const scripts = steps.map(([script]) => script);
  assert.deepEqual(scripts, [
    'scripts/build-dist.js',
    'benchmarks/run.js',
    'scripts/static-check.js',
    'scripts/verify-release-chain.js',
    'scripts/reproducible-build-evidence.js',
    'scripts/sign-release.js',
    'scripts/verify-release-chain.js'
  ]);
  // The signed parity evidence env is wired into both verification passes.
  assert.equal(steps[3][1], '', 'pre-sign verification runs without parity evidence');
  assert.ok(steps[5][1] && steps[6][1] === steps[5][1], 'sign and verify passes share exact parity evidence');
  assert.ok(output.some(line => line.includes('SIGNED_RELEASE_VERIFIED')));
});

test('release contracts require local qualification and security documentation without GitHub Actions', async () => {
  const artifacts = [
    'SECURITY.md', 'docs/DEMO_SCRIPT.md', 'scripts/browser-smoke.py',
    'scripts/qualify-bounded-release.js', 'scripts/release-gate.js',
    'scripts/verify-deployed-release.js', 'scripts/reproducible-build-evidence.js'
  ];
  for (const file of artifacts) {
    const info = await stat(new URL('../' + file, import.meta.url));
    assert.ok(info.isFile() && info.size > 100, file + ': missing release component');
  }
  const { commands, requiredRealSurfaces, actionsFree } = qualificationPlan();
  assert.equal(actionsFree, true);
  assert.ok(commands.length >= 8, 'release gate must execute broad required checks');
  assert.deepEqual(commands.find(c => c.id === 'full_suite')?.command, ['npm', 'test']);
  assert.ok(commands.some(c => c.id === 'required_sqlite_suite'));
  for (const id of ['build', 'benchmark', 'static', 'model', 'package', 'release_chain']) {
    assert.ok(commands.some(c => c.id === id), id + ' must run on the same release SHA');
  }
  assert.deepEqual(requiredRealSurfaces.map(c => c.id), ['browser_ui', 'sqlite_sustained', 'production_denial']);
  assert.ok(!commands.some(c => c.command.join(' ').includes('github')), 'qualification must not invoke GitHub Actions');
});

test('mandatory proof cannot be supplied by a status flag or evidence from a different commit', () => {
  const sha = 'a'.repeat(40);
  const value = { surface: 'browser_ui', status: 'PASS', commitSha: sha, actualExecution: true, assertions: 10 };
  assert.doesNotThrow(() => validateBoundEvidence(value, sha, 'browser_ui'));
  for (const override of [
    { status: 'NOT_EXECUTED' }, { actualExecution: false }, { assertions: 0 },
    { commitSha: 'b'.repeat(40) }, { surface: 'sqlite_sustained' }
  ]) {
    assert.throws(() => validateBoundEvidence({ ...value, ...override }, sha, 'browser_ui'));
  }
});

test('benchmark evidence honours the qualification output directory', async () => {
  const stress = await readFile(new URL('../tests/api-stress.test.js', import.meta.url), 'utf8');
  assert.match(stress, /process\.env\.SPOOL_BENCHMARK_OUTPUT_DIR \|\| join\(process\.cwd\(\), '\.console-evidence'\)/);
  // The release runner exports SPOOL_BENCHMARK_OUTPUT_DIR, so a tracked-file
  // rewrite during qualification would be reported as source drift.
  const runner = await readFile(new URL('../scripts/qualify-bounded-release.js', import.meta.url), 'utf8');
  assert.match(runner, /SPOOL_BENCHMARK_OUTPUT_DIR: join\(root\.evidence, 'benchmarks'\)/);
});

test('deployed release verifier checks actual artifact digests, not a commit-only success marker', async () => {
  const verifier = await readFile(new URL('../scripts/verify-deployed-release.js', import.meta.url), 'utf8');
  assert.match(verifier, /sha256/);
  assert.match(verifier, /artifactRoot/);
  assert.match(verifier, /MAX_ARTIFACTS/);
  assert.match(verifier, /redirect: 'error'/);
  assert.match(verifier, /UNSAFE_ARTIFACT_PATH/);
  const gate = await readFile(new URL('../scripts/qualify-bounded-release.js', import.meta.url), 'utf8');
  assert.match(gate, /assertCleanSource\(current\)/);
  assert.match(gate, /Tracked source changed during candidate qualification/);
  assert.match(gate, /required_sqlite_skip_or_failure/);
  assert.match(gate, /NOT_EXECUTED/);
  assert.doesNotMatch(gate, /deploy --prod|gh release create|workflow_dispatch/);
});
