import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

test('SOC 2 Compliance Audit Verification', async () => {
  const reportPath = '.console-evidence/soc2-audit-report.json';
  assert.ok(existsSync(reportPath), 'SOC 2 audit report must exist');

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.overallScore, 100);
  assert.equal(report.totalControls, 8);
  assert.equal(report.passedControls, 8);

  for (const ctrl of report.controls) {
    assert.equal(ctrl.status, 'PASSED', `Control ${ctrl.id} must pass`);
  }
});
