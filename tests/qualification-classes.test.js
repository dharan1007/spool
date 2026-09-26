import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALIFICATION_CLASSES, QUALIFICATION_REQUIREMENTS,
  developmentQualification, assertDevelopmentQualification } from '../scripts/qualify/qualification-classes.js';

const id = { runId: 'run-123', commitSha: 'a'.repeat(40), profile: 'INDUSTRIAL' };

test('classes have frozen, increasing workload minimums and complete gate obligations', () => {
  assert.deepEqual(QUALIFICATION_CLASSES, [
    'NOT_QUALIFIED','CI_CORRECTNESS','PILOT','SMALL_PRODUCTION',
    'MEDIUM_PRODUCTION','LARGE_PRODUCTION','INDUSTRIAL']);
  let rows = 0; let cdc = 0;
  for (const key of QUALIFICATION_CLASSES.slice(1)) {
    const v = QUALIFICATION_REQUIREMENTS[key];
    assert.ok(Object.isFrozen(v)); assert.ok(Object.isFrozen(v.gates));
    assert.ok(v.minRows >= rows && v.minCdcSeconds >= cdc);
    assert.ok(v.gates.includes('executable_mandatory_ci'));
    assert.ok(v.gates.includes('independent_content_verification'));
    rows = v.minRows; cdc = v.minCdcSeconds;
  }
  assert.ok(QUALIFICATION_REQUIREMENTS.INDUSTRIAL.gates.includes('independent_certification'));
});

test('clean INDUSTRIAL profile alone cannot claim earned qualification', () => {
  const v = developmentQualification(id);
  assert.equal(v.class, 'NOT_QUALIFIED');
  assert.equal(assertDevelopmentQualification(v, id), true);
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.reasonCodes));
});

test('forged pilot, missing attestations, altered run identity, or boolean grade fail closed', () => {
  const original = developmentQualification(id);
  for (const change of [
    { class: 'PILOT' }, { class: 'INDUSTRIAL' }, { evidenceType: 'CERTIFIED' },
    { reasonCodes: [] }, { runId: 'other' }, { commitSha: 'b'.repeat(40) },
    { profile: 'CI' }, { schemaVersion: 4 },
  ]) assert.throws(() => assertDevelopmentQualification({ ...original, ...change }, id));
  assert.throws(() => developmentQualification({ ...id, commitSha: '' }));
});
