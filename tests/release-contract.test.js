import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { qualificationPlan, validateBoundEvidence } from '../scripts/qualify-bounded-release.js';

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
