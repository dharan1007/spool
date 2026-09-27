import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutedTap } from '../scripts/qualify/assert-test-execution.js';

const make = ({ tests = 2, pass = 2, fail = 0, cancelled = 0, skipped = 0, todo = 0, entries = ['ok 1 - first', 'ok 2 - second'] } = {}) =>
  ['TAP version 13', ...entries, '# tests ' + tests, '# pass ' + pass, '# fail ' + fail,
    '# cancelled ' + cancelled, '# skipped ' + skipped, '# todo ' + todo].join('\n');

test('actual TAP with executed passing cases is accepted', () => {
  const result = assertExecutedTap(make(), { minimumTests: 2 });
  assert.equal(result.status, 'EXECUTED_ALL_PASS');
  assert.equal(result.tests, 2);
});
test('a pass exit status with zero actual tests is rejected', () => {
  assert.throws(() => assertExecutedTap(make({ tests: 0, pass: 0, entries: [] })), /Insufficient/);
});
test('all-skipped and partially skipped suites never count as qualified', () => {
  for (const transcript of [
    make({ pass: 0, skipped: 2, entries: ['ok 1 - no db # SKIP', 'ok 2 - no db # SKIP'] }),
    make({ pass: 1, skipped: 1, entries: ['ok 1 - real', 'ok 2 - skip # SKIP'] })
  ]) assert.throws(() => assertExecutedTap(transcript), /skipped/);
});
test('claimed PASS cannot override failed/cancelled/TODO or missing tests', () => {
  for (const transcript of [
    make({ pass: 1, fail: 1, entries: ['ok 1 - yes', 'not ok 2 - fail'] }),
    make({ pass: 1, cancelled: 1 }),
    make({ pass: 1, todo: 1 }),
    make({ pass: 1 }),
    make().replace('# pass 2', '')
  ]) assert.throws(() => assertExecutedTap(transcript));
});
test('fake summaries with no test entries and partial transcripts are rejected', () => {
  assert.throws(() => assertExecutedTap(make({ entries: [] })), /No completed/);
  assert.throws(() => assertExecutedTap('TAP version 13\nok 1 - unresolved'), /summary/);
  assert.throws(() => assertExecutedTap(make().replace('TAP version 13', '')), /header/);
  assert.throws(() => assertExecutedTap(make() + '\n# pass 2'), /ambiguous/);
});
