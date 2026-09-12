import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModel() {
  return import('../src/protocol/svmp-model.js');
}

test('SVMP execution model exhaustively explores normal, crash, takeover, drift, and reconciliation paths', async () => {
  const { checkSvmpExecutionModel } = await loadModel();
  const report = checkSvmpExecutionModel();
  assert.equal(report.ok, true);
  assert.equal(report.violations.length, 0);
  assert.ok(report.statesExplored >= 100, `model explored too few states: ${report.statesExplored}`);
  for (const action of [
    'target_commit', 'crash_after_commit', 'reconcile_committed', 'lease_lost',
    'worker_takeover', 'stale_worker_write_attempt', 'source_drift', 'target_drift',
    'authority_expired', 'verification_failure'
  ]) {
    assert.ok(report.actionsExplored.includes(action), `model never explored ${action}`);
  }
});

test('SVMP execution model proves the core mutation safety invariants', async () => {
  const { checkSvmpExecutionModel } = await loadModel();
  const report = checkSvmpExecutionModel();
  const proved = new Set(report.invariantsProved);
  for (const invariant of [
    'checkpoint_requires_exact_commit_evidence',
    'verified_requires_checkpoint_and_evidence',
    'stale_fence_cannot_mutate',
    'mutation_identity_commits_at_most_once',
    'execution_requires_current_authority',
    'drift_cannot_reach_verified',
    'unknown_commit_requires_reconciliation',
    'conflicting_reconciliation_cannot_advance'
  ]) {
    assert.ok(proved.has(invariant), `model did not prove ${invariant}`);
  }
});

test('SVMP model checker detects an intentionally unsafe checkpoint transition', async () => {
  const { checkSvmpExecutionModel, UNSAFE_MODEL_MUTATIONS } = await loadModel();
  const report = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_CHECKPOINT_WITHOUT_EVIDENCE });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some(item => item.invariant === 'checkpoint_requires_exact_commit_evidence'));
  const violation = report.violations.find(item => item.invariant === 'checkpoint_requires_exact_commit_evidence');
  assert.ok(Array.isArray(violation.trace) && violation.trace.length > 0, 'counterexample must include a trace');
});

test('SVMP model checker detects an intentionally unsafe stale-writer transition', async () => {
  const { checkSvmpExecutionModel, UNSAFE_MODEL_MUTATIONS } = await loadModel();
  const report = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_STALE_FENCE_WRITE });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some(item => item.invariant === 'stale_fence_cannot_mutate' || item.invariant === 'mutation_identity_commits_at_most_once'));
});

test('formal SVMP specification is checked in the production release gate', async () => {
  const { readFile } = await import('node:fs/promises');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const spec = await readFile(new URL('../models/SVMP.md', import.meta.url), 'utf8');
  assert.match(packageJson.scripts['check:model'] ?? '', /check-svmp-model\.js/);
  assert.match(packageJson.scripts.check ?? '', /check:model/);
  assert.match(spec, /checkpoint_requires_exact_commit_evidence/);
  assert.match(spec, /stale_fence_cannot_mutate/);
  assert.match(spec, /unknown_commit_requires_reconciliation/);
  assert.match(spec, /counterexample/i);
});
