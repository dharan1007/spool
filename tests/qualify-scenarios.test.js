import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_SCENARIOS,
  requiredScenarioNames,
  isUnexpectedFailure,
  foldScenarioFailures
} from '../scripts/qualify/scenarios.js';

test('required scenario manifest is complete and ordered', () => {
  assert.deepEqual(requiredScenarioNames(), [
    'postgres.target.load',
    'postgres.bulk.load',
    'postgres.content-exact.verification',
    'postgres.repair.load',
    'postgres.cdc.soak',
    'postgres.workers.load',
    'postgres.largeTransactions',
    'postgres.database-source.load',
    'postgres.crashRecovery'
  ]);
  for (const entry of REQUIRED_SCENARIOS) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.run, 'function');
  }
});

test('unexpected failures are exactly the non-expected, non-refusal records', () => {
  assert.equal(isUnexpectedFailure({ expected: false, classification: 'CORRECTNESS' }), true);
  assert.equal(isUnexpectedFailure({ expected: false, classification: 'ENVIRONMENT' }), true);
  assert.equal(isUnexpectedFailure({ expected: false, classification: 'HARNESS' }), true);
  assert.equal(isUnexpectedFailure({ expected: true, classification: 'CORRECTNESS' }), false);
  assert.equal(isUnexpectedFailure({ expected: false, classification: 'EXPECTED_REFUSAL' }), false);
  // Malformed records fail closed: a null entry is a scenario bug, not a pass.
  assert.equal(isUnexpectedFailure(null), true);
  assert.equal(isUnexpectedFailure(undefined), true);
});

test('folded scenario failures drive PASS/FAIL with no silent pass', () => {
  const clean = foldScenarioFailures([]);
  assert.equal(clean.status, 'PASS');
  assert.deepEqual(clean.unexpected, []);

  const refusal = foldScenarioFailures([{ expected: true, classification: 'EXPECTED_REFUSAL' }]);
  assert.equal(refusal.status, 'PASS');
  assert.equal(refusal.failures.length, 1);

  const bad = foldScenarioFailures([
    { expected: true, classification: 'EXPECTED_REFUSAL' },
    { expected: false, classification: 'CORRECTNESS', code: 'X' }
  ]);
  assert.equal(bad.status, 'FAIL');
  assert.equal(bad.unexpected.length, 1);
  assert.equal(bad.unexpected[0].code, 'X');

  const missing = foldScenarioFailures(null);
  assert.equal(missing.status, 'PASS');
  assert.deepEqual(missing.failures, []);
});
