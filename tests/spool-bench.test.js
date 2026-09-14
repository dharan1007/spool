import test from 'node:test';
import assert from 'node:assert/strict';
import { runSpoolBench } from '../benchmarks/spool-bench.js';

test('SPOOL-Bench measures verification, merkle, repair and SQLite suites with sane evidence', async () => {
  const report = await runSpoolBench({ contentSizes: [100], merkleSizes: [100], repairMissing: [5], sqliteSizes: [100] });
  assert.equal(report.contentVerification.length, 1);
  assert.equal(report.contentVerification[0].rows, 100);
  assert.match(report.contentVerification[0].rootHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.contentVerification[0].merkleRoot, /^sha256:[a-f0-9]{64}$/);
  assert.ok(report.contentVerification[0].verifyRowsPerSecond > 0);

  assert.equal(report.merkle.length, 1);
  assert.equal(report.merkle[0].leaves, 100);
  assert.match(report.merkle[0].root, /^sha256:[a-f0-9]{64}$/);

  assert.equal(report.repairPlan.length, 1);
  assert.equal(report.repairPlan[0].missingRows, 5);
  assert.equal(report.repairPlan[0].operations, 5);
  assert.match(report.repairPlan[0].repairPlanId, /^sha256:[a-f0-9]{64}$/);

  assert.equal(report.sqliteEndToEnd.length, 1);
  assert.equal(report.sqliteEndToEnd[0].rows, 100);
  assert.ok(report.sqliteEndToEnd[0].writeRowsPerSecond > 0);
});
