import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The self-assessment must be generated at the current HEAD rather than read from
// a stale committed artifact, and its output must never be mistakable for an
// auditor-issued SOC 2 report.
test('internal control self-assessment runs at HEAD and cannot be read as an attestation', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'spool-self-assessment-'));
  const outPath = join(outDir, 'internal-control-self-assessment.json');
  try {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'internal-control-self-assessment.js'), '--out', outPath],
      { cwd: root, encoding: 'utf8', timeout: 120_000 }
    );
    assert.equal(result.error, undefined, String(result.error ?? ''));
    assert.equal(result.status, 0, `self-assessment exited ${result.status}: ${result.stderr || result.stdout}`);

    const report = JSON.parse(await readFile(outPath, 'utf8'));

    assert.equal(report.report, 'INTERNAL_CONTROL_SELF_ASSESSMENT');
    assert.equal(report.attestation, false, 'the report must state it is not an attestation');
    assert.equal(report.independentAudit, 'NOT_PERFORMED', 'no independent audit has been performed');
    assert.match(report.disclaimer, /not an audit/i);
    assert.match(report.disclaimer, /not a SOC 2 report/i);
    assert.doesNotMatch(JSON.stringify(report), /overallScore|Compliance Score/);

    assert.ok(Number.isInteger(report.totalChecks) && report.totalChecks > 0);
    assert.equal(report.checks.length, report.totalChecks);
    assert.equal(report.passedChecks, report.totalChecks, 'every mapped control check must hold at HEAD');
    for (const check of report.checks) {
      assert.equal(check.status, 'PASSED', `Control ${check.id} must pass`);
      assert.equal(typeof check.criteria, 'string');
      assert.ok(check.details.length > 0);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('no committed artifact claims a SOC 2 audit result', async () => {
  const { stdout } = { stdout: spawnSync('git', ['ls-files', '.console-evidence'], { cwd: root, encoding: 'utf8' }).stdout };
  const tracked = stdout.split(/\r?\n/).filter(Boolean);
  for (const file of tracked) {
    const text = await readFile(join(root, file), 'utf8').catch(() => '');
    assert.doesNotMatch(text, /"framework":\s*"SOC 2 Type I \/ Type II/, `${file} must not claim an automated SOC 2 assessment`);
  }
  assert.equal(tracked.includes('.console-evidence/soc2-audit-report.json'), false, 'the stale SOC 2-labelled report must stay removed');
});
