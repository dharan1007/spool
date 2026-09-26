import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpectedRefusal, isUnexpectedFailure, foldScenarioFailures,
  isLogicalWalLevel, scenarioCanPass
} from '../scripts/qualify/failure-classification.js';

const valid = { code: 'SLOT_LOST', expected: true, classification: 'EXPECTED_REFUSAL' };

test('only a fully labelled expected refusal is non-failing', () => {
  assert.equal(isExpectedRefusal(valid), true);
  assert.equal(isUnexpectedFailure(valid), false);
  for (const f of [
    null, undefined, 'EXPECTED_REFUSAL', {}, [],
    { expected: true, classification: 'CORRECTNESS', code: 'BUG' },
    { expected: false, classification: 'EXPECTED_REFUSAL', code: 'BUG' },
    { classification: 'EXPECTED_REFUSAL', code: 'BUG' },
    { expected: true, code: 'BUG' },
    { expected: true, classification: 'EXPECTED_REFUSAL' },
    { expected: true, classification: 'EXPECTED_REFUSAL', code: '' },
    { expected: 'true', classification: 'EXPECTED_REFUSAL', code: 'BUG' },
    { expected: true, classification: 'EXPECTED_REFUSAL', code: 10 }
  ]) {
    assert.equal(isUnexpectedFailure(f), true, JSON.stringify(f));
  }
});

test('the scenario fold fails closed on contradictory and malformed failures', () => {
  assert.equal(foldScenarioFailures([]).status, 'PASS');
  assert.equal(foldScenarioFailures([valid]).status, 'PASS');
  assert.equal(foldScenarioFailures([valid, { expected: true, classification: 'CORRECTNESS', code: 'BUG' }]).status, 'FAIL');
  assert.equal(foldScenarioFailures([null]).status, 'FAIL');
  assert.equal(foldScenarioFailures([{ expected: false, classification: 'EXPECTED_REFUSAL', code: 'BUG' }]).status, 'FAIL');
  assert.equal(foldScenarioFailures([{ expected: true, classification: 'EXPECTED_REFUSAL', code: '' }]).status, 'FAIL');
});

test('CDC qualification refuses the physical-replication wal_level', () => {
  assert.equal(isLogicalWalLevel('logical'), true);
  for (const level of ['replica', 'minimal', '', undefined, null, 'LOGICAL']) {
    assert.equal(isLogicalWalLevel(level), false);
  }
});

test('a failed scenario result cannot be laundered into PASS by empty failures', () => {
  assert.equal(scenarioCanPass({foldedStatus: 'PASS'}), true);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS',reportedStatus: 'PASS', reportedMetricStatus: 'PASS', profileFailures: 0}), true);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS', reportedStatus: 'FAIL'}), false);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS', reportedMetricStatus: 'FAIL'}), false);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS', reportedMetricStatus: 'UNKNOWN'}), false);
  assert.equal(scenarioCanPass({foldedStatus: 'FAIL'}), false);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS',profileFailures:1}), false);
  assert.equal(scenarioCanPass({foldedStatus: 'PASS',profileFailures:undefined}), true);
});
