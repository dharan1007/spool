import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyStage,
  evaluateOverall,
  verifyQualification,
  assertNoSymlinks,
  LIVE_PG_MARKER,
  QUALIFICATION_SCHEMA_VERSION
} from '../scripts/qualify/run-standalone.js';
import { writeSha256Sums } from '../scripts/qualify/checksums.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TAP_GOOD = '# tests 10\n# pass 10\n# fail 0\n# skipped 0\n';
const TAP_ZERO = '# tests 0\n# pass 0\n# fail 0\n# skipped 0\n';
const TAP_SKIP = '# tests 10\n# pass 9\n# fail 0\n# skipped 1\nok 1 - a mandatory test # SKIP\n';
const TAP_FAIL = '# tests 10\n# pass 9\n# fail 1\n# skipped 0\nnot ok 1 - a failing test\n';
const SMOKE_MARKER_LINE = '  "status": "PASS",';

const PG_ENV_REQUIRED = [
  'SPOOL_TEST_POSTGRES_ENDPOINT',
  'SPOOL_TEST_POSTGRES_DATABASE',
  'SPOOL_TEST_POSTGRES_USER',
  'SPOOL_TEST_PG_PASSWORD'
];

const FIXTURE_STAGES = [
  { id: 'unit', description: 'unit', mandatory: true, parses: 'node-test', skipAllow: [], markers: [], command: 'node', args: [] },
  { id: 'smoke', description: 'smoke', mandatory: true, markers: ['"status": "PASS"'], command: 'python', args: [] },
  { id: 'live', description: 'live db', mandatory: true, markers: [LIVE_PG_MARKER], requireEnv: [...PG_ENV_REQUIRED], whenEnvAbsent: 'blocked', blockedOnExitCodes: [2, 3, 4, 5], command: 'node', args: [] },
  { id: 'na-allowed', description: 'deployment smoke', mandatory: true, builtin: 'na', naReason: 'no-deployment-performed' }
];

const FIXTURE_PROFILES = {
  fixture: {
    name: 'fixture',
    stages: FIXTURE_STAGES,
    workload: { rows: 100_000, cdcDurationSeconds: 30, source: 'fixture envelope' },
    classLabel: 'CI_CORRECTNESS'
  }
};

const SPECS = Object.fromEntries(FIXTURE_STAGES.map(stage => [stage.id, stage]));

const CLEAN_BINDING = { gitShaStart: SHA_A, gitShaEnd: SHA_A, treeCleanStart: true, treeCleanEnd: true };

function unitCounts(tap) {
  const tests = Number(/^# tests (\d+)$/m.exec(tap)[1]);
  const pass = Number(/^# pass (\d+)$/m.exec(tap)[1]);
  const fail = Number(/^# fail (\d+)$/m.exec(tap)[1]);
  const skipped = Number(/^# skipped (\d+)$/m.exec(tap)[1]);
  return { tests, pass, fail, skipped };
}

function defaultLogs() {
  return {
    'stage-unit.log': TAP_GOOD,
    'stage-smoke.log': `browser launched\n${SMOKE_MARKER_LINE}\n`,
    'stage-live.log': `LIVE_PG_PROBE OK\nLIVE_PG_PROBE_META {"version":"PostgreSQL 17.5"}\n`,
    'stage-na-allowed.log': 'not applicable: no-deployment-performed\n'
  };
}

function defaultStages() {
  return [
    {
      id: 'unit', description: 'unit', mandatory: true, status: 'PASS', naReason: null,
      exitCode: 0, signal: null, counts: unitCounts(TAP_GOOD), skipNames: [], markersSeen: [],
      notes: ['10 tests executed'], classification: { envMissing: false, prereqFailed: false, spawnError: null, diskAllowed: null, diskReason: null },
      log: 'stage-unit.log', durationMs: 1
    },
    {
      id: 'smoke', description: 'smoke', mandatory: true, status: 'PASS', naReason: null,
      exitCode: 0, signal: null, counts: null, skipNames: [], markersSeen: ['"status": "PASS"'],
      notes: ['evidence markers present'], classification: { envMissing: false, prereqFailed: false, spawnError: null, diskAllowed: null, diskReason: null },
      log: 'stage-smoke.log', durationMs: 1
    },
    {
      id: 'live', description: 'live db', mandatory: true, status: 'PASS', naReason: null,
      exitCode: 0, signal: null, counts: null, skipNames: [], markersSeen: [LIVE_PG_MARKER],
      notes: ['evidence markers present'], classification: { envMissing: false, prereqFailed: false, spawnError: null, diskAllowed: null, diskReason: null },
      log: 'stage-live.log', durationMs: 1, probeMeta: { version: 'PostgreSQL 17.5' }
    },
    {
      id: 'na-allowed', description: 'deployment smoke', mandatory: true, status: 'NOT_APPLICABLE',
      naReason: 'no-deployment-performed', exitCode: null, signal: null, counts: null, skipNames: [], markersSeen: [],
      notes: ['not applicable: no-deployment-performed'], classification: { envMissing: false, prereqFailed: false, spawnError: null, diskAllowed: null, diskReason: null },
      log: 'stage-na-allowed.log', durationMs: 1
    }
  ];
}

async function buildRun({ logs = defaultLogs(), adjustManifest = null, skipChecksums = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-qualify-fixture-'));
  for (const [name, content] of Object.entries(logs)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  const stages = defaultStages();
  const aggregate = { tests: 10, pass: 10, fail: 0, skipped: 0, executed: 10 };
  const manifest = {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    tool: 'scripts/qualify/run-standalone.js',
    policy: 'spool-disk-preflight-v1',
    profile: 'fixture',
    result: 'PASS',
    qualificationClass: 'CI_CORRECTNESS',
    gitSha: SHA_A,
    gitShaEnd: SHA_A,
    treeClean: true,
    treeCleanEnd: true,
    environmentVersions: { node: 'v22.0.0', npm: '11.0.0', platform: 'win32', arch: 'x64', release: 'test' },
    environmentDigest: 'sha256:fixture',
    databaseVersions: { postgres: 'PostgreSQL 17.5' },
    workload: FIXTURE_PROFILES.fixture.workload,
    testCounts: aggregate,
    failures: [],
    violations: [],
    stages,
    measuredResourceUsage: { runnerMaxRssKilobytes: 1, source: 'runner-process', note: 'fixture' },
    startedAt: '2026-09-30T00:00:00.000Z',
    endedAt: '2026-09-30T00:01:00.000Z'
  };
  const onDisk = (await readdir(dir)).filter(name => name !== 'sha256sums.txt');
  manifest.evidence = { files: [...new Set([...onDisk, 'qualification-manifest.json'])].sort() };
  if (adjustManifest) adjustManifest(manifest);
  await writeFile(join(dir, 'qualification-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (!skipChecksums) await writeSha256Sums(dir);
  return { dir, manifest };
}

function verify(dir) {
  return verifyQualification(dir, { profiles: FIXTURE_PROFILES });
}

test('1. mandatory stage that executes zero tests cannot pass', async () => {
  const classified = classifyStage(SPECS.unit, { exitCode: 0, signal: null, output: TAP_ZERO });
  assert.equal(classified.status, 'NOT_EXECUTED');
  const overall = evaluateOverall(
    [{ id: 'unit', mandatory: true, status: classified.status, counts: classified.counts }],
    CLEAN_BINDING,
    { unit: SPECS.unit }
  );
  assert.equal(overall.result, 'NOT_EXECUTED');

  const { dir } = await buildRun({
    logs: { ...defaultLogs(), 'stage-unit.log': TAP_ZERO },
    adjustManifest: manifest => {
      manifest.stages[0].counts = unitCounts(TAP_ZERO);
    }
  });
  await assert.rejects(verify(dir), /zero-tests-pass|stage-status-claim/);
});

test('2. mandatory skipped test makes the stage NOT_EXECUTED, never PASS', async () => {
  const classified = classifyStage(SPECS.unit, { exitCode: 0, signal: null, output: TAP_SKIP });
  assert.equal(classified.status, 'NOT_EXECUTED');
  assert.match(classified.notes.join(' '), /skipped/);

  const { dir } = await buildRun({
    logs: { ...defaultLogs(), 'stage-unit.log': TAP_SKIP },
    adjustManifest: manifest => {
      manifest.stages[0].counts = unitCounts(TAP_SKIP);
    }
  });
  await assert.rejects(verify(dir), /stage-status-claim/);
});

test('3. subprocess exit code other than zero is FAIL', () => {
  const classified = classifyStage(SPECS.unit, { exitCode: 7, signal: null, output: TAP_GOOD });
  assert.equal(classified.status, 'FAIL');
  const overall = evaluateOverall(
    [{ id: 'unit', mandatory: true, status: 'FAIL', counts: null }],
    CLEAN_BINDING,
    { unit: SPECS.unit }
  );
  assert.equal(overall.result, 'FAIL');
});

test('4. missing result file fails verification', async () => {
  const { dir } = await buildRun();
  await unlink(join(dir, 'stage-unit.log'));
  await assert.rejects(verify(dir), /stage-log-unreadable|stage-log-absent|file-set-mismatch|Checksum/);
});

test('5. checksum mismatch fails verification', async () => {
  const { dir } = await buildRun();
  await writeFile(join(dir, 'stage-unit.log'), `${TAP_GOOD}tampered\n`, 'utf8');
  await assert.rejects(verify(dir), /Checksum mismatch/);
});

test('6. stage reporting FAIL cannot be covered by an overall PASS even when the process exits 0', async () => {
  const { dir } = await buildRun({
    logs: { ...defaultLogs(), 'stage-unit.log': TAP_FAIL },
    adjustManifest: manifest => {
      manifest.stages[0].status = 'FAIL';
      manifest.stages[0].counts = unitCounts(TAP_FAIL);
      manifest.stages[0].notes = ['1 test failure(s) reported'];
    }
  });
  await assert.rejects(verify(dir), /result-claim/);
});

test('7. scenario crash before terminal completion is FAIL, not an expected refusal', () => {
  const crashed = classifyStage(SPECS.unit, { exitCode: null, signal: 'SIGSEGV', output: '' });
  assert.equal(crashed.status, 'FAIL');
  const claimedCleanExit = classifyStage(SPECS.unit, { exitCode: 0, signal: 'SIGKILL', output: TAP_GOOD });
  assert.equal(claimedCleanExit.status, 'FAIL');
  const overall = evaluateOverall(
    [{ id: 'unit', mandatory: true, status: 'FAIL', counts: null }],
    CLEAN_BINDING,
    { unit: SPECS.unit }
  );
  assert.equal(overall.result, 'FAIL');
});

test('8. missing PostgreSQL credentials block qualification', () => {
  const classified = classifyStage(SPECS.live, { envMissing: true });
  assert.equal(classified.status, 'BLOCKED');
  const overall = evaluateOverall(
    [
      { id: 'unit', mandatory: true, status: 'PASS', counts: { tests: 10, pass: 10, fail: 0, skipped: 0 } },
      { id: 'live', mandatory: true, status: 'BLOCKED', counts: null }
    ],
    CLEAN_BINDING,
    SPECS
  );
  assert.equal(overall.result, 'BLOCKED');
});

test('9. unreachable PostgreSQL blocks qualification', () => {
  const classified = classifyStage(SPECS.live, {
    exitCode: 2,
    signal: null,
    output: 'LIVE_PG_PROBE UNAVAILABLE host=127.0.0.1 port=5433 code=ECONNREFUSED'
  });
  assert.equal(classified.status, 'BLOCKED');
  const overall = evaluateOverall(
    [
      { id: 'unit', mandatory: true, status: 'PASS', counts: { tests: 10, pass: 10, fail: 0, skipped: 0 } },
      { id: 'live', mandatory: true, status: 'BLOCKED', counts: null }
    ],
    CLEAN_BINDING,
    SPECS
  );
  assert.equal(overall.result, 'BLOCKED');
});

test('10. worktree becoming dirty during qualification fails closed', async () => {
  const dirty = evaluateOverall(
    [{ id: 'unit', mandatory: true, status: 'PASS', counts: { tests: 10, pass: 10, fail: 0, skipped: 0 } }],
    { ...CLEAN_BINDING, treeCleanEnd: false },
    { unit: SPECS.unit }
  );
  assert.equal(dirty.result, 'FAIL');
  assert.ok(dirty.violations.some(v => v.rule === 'tree-became-dirty'));

  const { dir } = await buildRun({
    adjustManifest: manifest => { manifest.treeCleanEnd = false; }
  });
  await assert.rejects(verify(dir), /result-claim/);
});

test('11. ending Git SHA different from starting SHA fails closed', async () => {
  const changed = evaluateOverall(
    [{ id: 'unit', mandatory: true, status: 'PASS', counts: { tests: 10, pass: 10, fail: 0, skipped: 0 } }],
    { ...CLEAN_BINDING, gitShaEnd: SHA_B },
    { unit: SPECS.unit }
  );
  assert.equal(changed.result, 'FAIL');
  assert.ok(changed.violations.some(v => v.rule === 'git-sha-changed'));

  const { dir } = await buildRun({
    adjustManifest: manifest => { manifest.gitShaEnd = SHA_B; }
  });
  await assert.rejects(verify(dir), /result-claim/);
});

test('12. manifest claims about tests that were never executed are rejected', async () => {
  const { dir } = await buildRun({
    adjustManifest: manifest => {
      manifest.stages[0].counts = { tests: 99, pass: 99, fail: 0, skipped: 0 };
      manifest.testCounts = { tests: 99, pass: 99, fail: 0, skipped: 0, executed: 99 };
    }
  });
  await assert.rejects(verify(dir), /counts-claim|aggregate-counts-claim/);
});

test('13. absent required stage fails verification', async () => {
  const { dir } = await buildRun({
    adjustManifest: manifest => {
      manifest.stages = manifest.stages.filter(stage => stage.id !== 'live');
    }
  });
  await assert.rejects(verify(dir), /required-stage-absent/);
});

test('14. duplicate evidence entries fail verification', async () => {
  const { dir } = await buildRun({
    adjustManifest: manifest => {
      manifest.evidence.files = [...manifest.evidence.files, 'stage-unit.log'];
    }
  });
  await assert.rejects(verify(dir), /duplicate-evidence/);
});

test('15. symlinks and unexpected evidence files fail verification', async () => {
  assert.throws(
    () => assertNoSymlinks([{ name: 'qualification-manifest.json', isSymbolicLink: false }, { name: 'link', isSymbolicLink: true }]),
    /symlink evidence entries are forbidden/
  );
  const { dir } = await buildRun();
  await writeFile(join(dir, 'unexpected.bin'), 'not part of the evidence contract', 'utf8');
  await assert.rejects(verify(dir), /file-set-mismatch/);
});

test('16. browser smoke that never launches a browser cannot pass', async () => {
  const classified = classifyStage(SPECS.smoke, {
    exitCode: 0,
    signal: null,
    output: 'python process ran but produced no launch summary\n'
  });
  assert.equal(classified.status, 'NOT_EXECUTED');

  const { dir } = await buildRun({
    logs: { ...defaultLogs(), 'stage-smoke.log': 'python process ran but produced no launch summary\n' },
    adjustManifest: manifest => {
      manifest.stages[1].markersSeen = [];
      manifest.stages[1].notes = ['evidence markers present'];
    }
  });
  await assert.rejects(verify(dir), /stage-status-claim/);
});

test('17. a real database stage without live evidence cannot pass', async () => {
  const classified = classifyStage(SPECS.live, {
    exitCode: 0,
    signal: null,
    output: 'unit-level doubles ran instead of a live connection\n'
  });
  assert.equal(classified.status, 'NOT_EXECUTED');

  const { dir } = await buildRun({
    logs: { ...defaultLogs(), 'stage-live.log': 'unit-level doubles ran instead of a live connection\n' },
    adjustManifest: manifest => {
      manifest.stages[2].markersSeen = [];
      delete manifest.stages[2].probeMeta;
    }
  });
  await assert.rejects(verify(dir), /stage-status-claim/);
});

test('18. NOT_APPLICABLE without an allowed reason fails verification', async () => {
  const { dir } = await buildRun({
    adjustManifest: manifest => {
      manifest.stages[3].naReason = 'operator-decided';
    }
  });
  await assert.rejects(verify(dir), /na-reason-invalid/);

  const derived = evaluateOverall(
    [{ id: 'na-allowed', mandatory: true, status: 'NOT_APPLICABLE', naReason: 'operator-decided', counts: null }],
    CLEAN_BINDING,
    SPECS
  );
  assert.equal(derived.result, 'FAIL');
  assert.ok(derived.violations.some(v => v.rule === 'na-reason-invalid'));
});

test('19. sound evidence verifies as PASS end to end', async () => {
  const { dir, manifest } = await buildRun();
  const verified = await verify(dir);
  assert.equal(verified.result, 'PASS');
  assert.equal(verified.qualificationClass, 'CI_CORRECTNESS');
  const derived = evaluateOverall(manifest.stages, {
    gitShaStart: manifest.gitSha,
    gitShaEnd: manifest.gitShaEnd,
    treeCleanStart: manifest.treeClean,
    treeCleanEnd: manifest.treeCleanEnd
  }, SPECS);
  assert.equal(derived.result, 'PASS');
});

test('20. CI_CORRECTNESS class cannot be claimed without a bound workload envelope', async () => {
  const noWorkloadProfile = {
    name: 'fixture',
    stages: FIXTURE_STAGES,
    workload: null,
    classLabel: 'CI_CORRECTNESS'
  };
  const { dir } = await buildRun();
  await assert.rejects(
    verifyQualification(dir, { profiles: { fixture: noWorkloadProfile } }),
    /class-claim|workload-claim/
  );
});
