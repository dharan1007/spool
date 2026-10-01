#!/usr/bin/env node
// SPOOL standalone qualification runner (prompt sections 9-11).
//
// One authoritative entry point:
//   node scripts/qualify/run-standalone.js --profile quick|correctness|postgres|release|pilot
//   node scripts/qualify/run-standalone.js --verify <evidence-dir>
//   node scripts/qualify/run-standalone.js --list
//
// Reuses existing scripts (static-check, npm test, browser smoke, release-gate,
// verify-package, industrial-postgres, disk-preflight, evidence writer,
// checksums, environment capture). Outcome model (section 10):
//   PASS | FAIL | NOT_EXECUTED | BLOCKED | NOT_APPLICABLE
// Mandatory NOT_EXECUTED/BLOCKED prevent PASS; a skipped mandatory test is
// NOT_EXECUTED; zero executed tests is NOT_EXECUTED; process exit code alone
// never establishes PASS. The independent verifier re-derives PASS from the
// evidence directory only and fails closed on every contradiction.
import { spawn, execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, copyFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { verifySha256Sums } from './checksums.js';
import { checkDiskPreflight, DISK_POLICY_VERSION } from './disk-preflight.js';
import { captureEnvironment } from './environment.js';
import { EvidenceWriter } from './evidence-writer.js';
import { PROFILE_DEFINITIONS } from './profiles.js';

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'NOT_EXECUTED', 'BLOCKED', 'NOT_APPLICABLE']);
export const ALLOWED_NA_REASONS = Object.freeze(['postgres-env-absent', 'no-deployment-performed']);
export const LIVE_PG_MARKER = 'LIVE_PG_PROBE OK';
export const BROWSER_SMOKE_MARKER = '"status": "PASS"';
export const STATIC_CHECK_MARKER = 'Static release check passed';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NODE = process.execPath;

// Skip names observed on a fully-provisioned Windows qualification host:
// 8 SQL Server + 7 MySQL + 3 SIGKILL + 2 POSIX-only = 20 NOT_EXECUTED tests.
// Any skip outside this allowlist makes its mandatory stage NOT_EXECUTED.
export const FULL_SUITE_SKIP_ALLOW = Object.freeze([
  'SQL Server',
  'MySQL',
  'real SIGKILL',
  'SIGKILL after',
  'Gate B fault: unwritable SQLite',
  'owner-only file permissions on POSIX'
]);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const FULL_SUITE_TIMEOUT_MS = 60 * 60 * 1000;

function gitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    return { sha, clean: status.trim() === '' };
  } catch (error) {
    return { sha: null, clean: false, error: String(error?.message ?? error) };
  }
}

function fullSuiteFiles() {
  const roots = [
    { dir: join(ROOT, 'tests'), prefix: 'tests' },
    { dir: join(ROOT, 'tests', 'conformance'), prefix: 'tests/conformance' }
  ];
  const files = [];
  for (const { dir, prefix } of roots) {
    for (const entry of readdirSyncSafe(dir)) {
      if (entry.endsWith('.test.js')) files.push(`${prefix}/${entry}`);
    }
  }
  return files.sort();
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function conformanceFiles(prefix) {
  return readdirSyncSafe(join(ROOT, 'tests', 'conformance'))
    .filter(entry => entry.startsWith(prefix) && entry.endsWith('.test.js'))
    .map(entry => `tests/conformance/${entry}`)
    .sort();
}

function unitFiles() {
  return readdirSyncSafe(join(ROOT, 'tests'))
    .filter(entry => entry.endsWith('.test.js'))
    .map(entry => `tests/${entry}`)
    .sort();
}

function proc(id, description, args, extra = {}) {
  return {
    id,
    description,
    mandatory: true,
    command: NODE,
    args,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...extra
  };
}

function nodeTest(id, description, args, extra = {}) {
  return proc(id, description, args, { parses: 'node-test', skipAllow: [], ...extra });
}

function diskStage(kind, estimatedPeakBytes, description) {
  return {
    id: 'disk-preflight',
    description,
    mandatory: true,
    builtin: 'disk',
    diskKind: kind,
    estimatedPeakBytes
  };
}

// Peak-storage estimate for the CI correctness envelope, using the same
// rows*(payload+512)*3 formula `industrial-postgres.js` enforces itself:
// the runner's disk gate and the envelope's own preflight agree.
function ciPeakBytes() {
  const ci = PROFILE_DEFINITIONS.CI;
  return Math.ceil(ci.rows * (ci.payloadBytes + 512) * 3);
}

const QUICK_STAGES = Object.freeze([
  diskStage('conformance', 256 * 1024 * 1024, 'Disk headroom admits bounded conformance work'),
  proc('dependency-validation', 'Installed dependency tree validates', ['ls', '--depth=0'], {
    command: NPM,
    args: ['ls', '--depth=0'],
    shell: true
  }),
  proc('static-check', 'Repository static release check passes', ['scripts/static-check.js'], {
    markers: [STATIC_CHECK_MARKER],
    timeoutMs: 5 * 60 * 1000
  }),
  nodeTest('core-unit', 'Core unit tests', ['--test', 'tests/core.test.js', 'tests/transforms.test.js', 'tests/migration.test.js']),
  nodeTest('browser-source', 'Deterministic source-level browser tests', [
    '--test', 'tests/browser-worker-runtime.test.js', 'tests/ui-contract.test.js', 'tests/product-surface.test.js'
  ])
]);

const PG_ENV_REQUIRED = Object.freeze([
  'SPOOL_TEST_POSTGRES_ENDPOINT',
  'SPOOL_TEST_POSTGRES_DATABASE',
  'SPOOL_TEST_POSTGRES_USER',
  'SPOOL_TEST_PG_PASSWORD'
]);

function pgProbeStage({ whenEnvAbsent }) {
  return {
    id: 'postgres-probe',
    description: 'Live PostgreSQL probe reports a logical-replication target',
    mandatory: true,
    command: NODE,
    args: ['scripts/qualify/pg-probe.js'],
    markers: [LIVE_PG_MARKER],
    captureMeta: 'postgres-probe',
    requireEnv: [...PG_ENV_REQUIRED],
    whenEnvAbsent,
    naReason: whenEnvAbsent === 'na' ? 'postgres-env-absent' : null,
    blockedOnExitCodes: [2, 3, 4, 5],
    timeoutMs: 30 * 1000
  };
}

function buildProfiles() {
  const fullSuite = fullSuiteFiles();
  const quick = [...QUICK_STAGES];

  const correctness = [
    // The correctness tier admits bounded correctness-sized workloads
    // (disk policy, `spool-disk-preflight-v1`): below the 8 GiB floor this
    // stage refuses before anything runs, fail closed.
    diskStage('correctness', ciPeakBytes(), 'Disk headroom admits the bounded CI correctness workload'),
    ...quick.filter(stage => stage.id !== 'disk-preflight'),
    nodeTest('integration', 'Core integration tests', [
      '--test', 'tests/command-service.test.js', 'tests/e2e.test.js', 'tests/workers.test.js', 'tests/spoold.test.js'
    ]),
    nodeTest('unit-suite', 'Complete unit test surface', ['--test', '--test-concurrency=1', ...unitFiles()], {
      skipAllow: [...FULL_SUITE_SKIP_ALLOW],
      timeoutMs: FULL_SUITE_TIMEOUT_MS
    }),
    nodeTest('sqlite-conformance', 'SQLite target conformance', [
      '--test', 'tests/sqlite-target.test.js', 'tests/sqlite-preflight.test.js',
      'tests/conformance/sqlite-conformance.test.js', 'tests/conformance/sqlite-faults.test.js'
    ], { skipAllow: ['Gate B fault: unwritable SQLite'] }),
    pgProbeStage({ whenEnvAbsent: 'na' }),
    nodeTest('postgres-correctness', 'PostgreSQL correctness conformance', [
      '--test', '--test-concurrency=1', ...conformanceFiles('postgres-')
    ],
      {
        requireEnv: [...PG_ENV_REQUIRED],
        whenEnvAbsent: 'na',
        naReason: 'postgres-env-absent',
        dependsOn: 'postgres-probe',
        skipAllow: [...FULL_SUITE_SKIP_ALLOW]
      }),
    {
      id: 'browser-smoke',
      description: 'Built application passes launched-browser smoke',
      mandatory: true,
      command: process.platform === 'win32' ? 'python' : 'python3',
      args: ['scripts/browser-smoke.py'],
      markers: [BROWSER_SMOKE_MARKER],
      blockedOnOutput: ['No supported Chromium/Chrome executable found'],
      artifacts: ['browser-smoke.png'],
      timeoutMs: 10 * 60 * 1000
    },
    nodeTest('release-contract', 'Release contract checks relevant to correctness', [
      '--test', 'tests/release-contract.test.js'
    ]),
    proc('svmp-model', 'Migration model gate passes', ['scripts/check-svmp-model.js'], {
      timeoutMs: 5 * 60 * 1000
    }),
    // Q-04: the CI_CORRECTNESS class requires a bound workload envelope
    // (>=100k rows with >=30s real CDC, `PROFILE_DEFINITIONS.CI`). Running
    // the immutable CI profile through `industrial-postgres.js` (which
    // independently records its effective configuration and refuses a
    // diverged immutable name) makes the class claim evidence-backed; a
    // PASS without this stage can never claim the class (class-claim gate).
    {
      id: 'correctness-envelope',
      description: 'CI workload envelope: >=100k rows with >=30s real CDC against the isolated qualification instance',
      mandatory: true,
      command: NODE,
      args: ['scripts/qualify/industrial-postgres.js', '--profile', 'CI'],
      requireEnv: [...PG_ENV_REQUIRED],
      whenEnvAbsent: 'blocked',
      timeoutMs: 2 * 60 * 60 * 1000
    }
  ];

  const postgres = [
    diskStage('conformance', 1024 * 1024 * 1024, 'Disk headroom admits live PostgreSQL conformance'),
    pgProbeStage({ whenEnvAbsent: 'blocked' }),
    nodeTest('postgres-live-suite', 'Full suite with live PostgreSQL (tests/*.test.js + tests/conformance/*.test.js)',
      ['--test', '--test-concurrency=1', ...fullSuite],
      {
        requireEnv: [...PG_ENV_REQUIRED],
        whenEnvAbsent: 'blocked',
        dependsOn: 'postgres-probe',
        skipAllow: [...FULL_SUITE_SKIP_ALLOW],
        timeoutMs: FULL_SUITE_TIMEOUT_MS
      })
  ];

  const release = [
    ...correctness,
    nodeTest('security-suite', 'Security suites', [
      '--test', 'tests/security.test.js', 'tests/platform-security.test.js',
      'tests/credential-broker.test.js', 'tests/path-policy.test.js'
    ]),
    proc('dependency-audit', 'Dependency audit finds no high-or-worse advisories', ['audit', '--audit-level=high'], {
      command: NPM,
      args: ['audit', '--audit-level=high'],
      shell: true,
      timeoutMs: 10 * 60 * 1000
    }),
    proc('release-gate', 'Authoritative release gate (build, benchmarks, static, chain, reproducible build)',
      ['scripts/release-gate.js'], { timeoutMs: FULL_SUITE_TIMEOUT_MS }),
    proc('artifact-integrity-clean-install', 'Package artifact verifies through clean install and installed CLI smoke',
      ['scripts/verify-package.js'], { timeoutMs: FULL_SUITE_TIMEOUT_MS }),
    {
      id: 'deployment-smoke',
      description: 'Deployment smoke applies only when a deployment was performed',
      mandatory: true,
      builtin: 'na',
      naReason: 'no-deployment-performed'
    }
  ];

  const pilot = [
    diskStage('pilot', 4 * 1024 ** 3, 'Disk headroom admits a bounded pilot workload'),
    ...release.filter(stage => stage.id !== 'disk-preflight'),
    {
      id: 'pilot-envelope',
      description: 'PILOT workload envelope: >=1M rows with >=1h real CDC',
      mandatory: true,
      command: NODE,
      args: ['scripts/qualify/industrial-postgres.js', '--profile', 'SMALL'],
      env: { SPOOL_QUALIFY_CDC_DURATION_SECONDS: '3600' },
      timeoutMs: 6 * 60 * 60 * 1000
    }
  ];

  return Object.freeze({
    quick: Object.freeze({ name: 'quick', stages: Object.freeze(quick), workload: null, classLabel: 'SMOKE' }),
    correctness: Object.freeze({
      name: 'correctness',
      stages: Object.freeze(correctness),
      workload: Object.freeze({
        profile: 'CI',
        rows: PROFILE_DEFINITIONS.CI.rows,
        cdcDurationSeconds: PROFILE_DEFINITIONS.CI.cdcDurationSeconds,
        payloadBytes: PROFILE_DEFINITIONS.CI.payloadBytes,
        source: 'scripts/qualify/profiles.js CI'
      }),
      classLabel: 'CI_CORRECTNESS'
    }),
    postgres: Object.freeze({ name: 'postgres', stages: Object.freeze(postgres), workload: null, classLabel: 'CI_CORRECTNESS' }),
    release: Object.freeze({ name: 'release', stages: Object.freeze(release), workload: null, classLabel: 'RELEASE' }),
    pilot: Object.freeze({
      name: 'pilot',
      stages: Object.freeze(pilot),
      workload: Object.freeze({
        profile: 'SMALL',
        rows: PROFILE_DEFINITIONS.SMALL.rows,
        cdcDurationSeconds: 3600,
        payloadBytes: PROFILE_DEFINITIONS.SMALL.payloadBytes,
        source: 'scripts/qualify/profiles.js SMALL with SPOOL_QUALIFY_CDC_DURATION_SECONDS=3600'
      }),
      classLabel: 'PILOT'
    })
  });
}

export const PROFILES = buildProfiles();

export function parseTapOutput(output) {
  const read = key => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output ?? '');
    return match ? Number(match[1]) : null;
  };
  const tests = read('tests');
  const pass = read('pass');
  const fail = read('fail');
  const skipped = read('skipped');
  if (tests === null || pass === null || fail === null || skipped === null) return null;
  const skipNames = [];
  const pattern = /^ok \d+ - (.+?) # SKIP(?: (.*))?$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) skipNames.push(match[1]);
  return { tests, pass, fail, skipped, skipNames };
}

function markerSeen(output, marker) {
  return typeof output === 'string' && output.includes(marker);
}

function note(...parts) {
  return parts.filter(Boolean).join(' ');
}

// Pure classification of one stage run against its contract. Fail closed:
// anything unverifiable becomes NOT_EXECUTED, crashes become FAIL, missing
// environment becomes BLOCKED, disallowed skips become NOT_EXECUTED.
export function classifyStage(spec, run = {}) {
  const outcome = (status, extra = {}) => ({
    status,
    naReason: status === 'NOT_APPLICABLE' ? (extra.naReason ?? spec.naReason ?? null) : null,
    counts: extra.counts
      ? { tests: extra.counts.tests, pass: extra.counts.pass, fail: extra.counts.fail, skipped: extra.counts.skipped }
      : null,
    skipNames: extra.skipNames ?? [],
    markersSeen: extra.markersSeen ?? [],
    notes: extra.notes ?? [],
    classification: {
      envMissing: run.envMissing === true,
      prereqFailed: run.prereqFailed === true,
      spawnError: run.spawnError ?? null,
      diskAllowed: run.diskAllowed ?? null,
      diskReason: run.diskReason ?? null
    }
  });

  if (spec.builtin === 'na') {
    return outcome('NOT_APPLICABLE', { naReason: spec.naReason, notes: [note('not applicable:', spec.naReason)] });
  }
  if (run.envMissing) {
    if (spec.whenEnvAbsent === 'na') {
      return outcome('NOT_APPLICABLE', { naReason: spec.naReason ?? 'postgres-env-absent', notes: ['required environment variables absent; allowed not-applicable reason'] });
    }
    return outcome('BLOCKED', { notes: ['required environment variables absent'] });
  }
  if (run.prereqFailed) {
    return outcome('NOT_EXECUTED', { notes: ['prerequisite stage did not pass'] });
  }
  if (spec.builtin === 'disk') {
    if (run.diskAllowed === true) return outcome('PASS', { notes: [run.diskReason ?? 'disk policy satisfied'] });
    return outcome('BLOCKED', { notes: [run.diskReason ?? 'disk policy refused the workload'] });
  }
  if (run.spawnError) {
    return outcome('BLOCKED', { notes: [`process could not start: ${run.spawnError}`] });
  }
  if (run.signal) {
    return outcome('FAIL', { notes: [`process terminated by signal ${run.signal}`] });
  }
  if (run.exitCode === null || run.exitCode === undefined) {
    return outcome('FAIL', { notes: ['process produced no terminal completion state'] });
  }
  if (Array.isArray(spec.blockedOnExitCodes) && spec.blockedOnExitCodes.includes(run.exitCode)) {
    return outcome('BLOCKED', { notes: [`exit ${run.exitCode} reports an unavailable environment`] });
  }
  if (run.exitCode !== 0) {
    if (Array.isArray(spec.blockedOnOutput)) {
      const hit = spec.blockedOnOutput.find(pattern => typeof run.output === 'string' && run.output.includes(pattern));
      if (hit) return outcome('BLOCKED', { notes: [`environment cannot run this stage: ${hit}`] });
    }
    return outcome('FAIL', { notes: [`process exited ${run.exitCode}`] });
  }

  const markersSeen = (spec.markers ?? []).filter(marker => markerSeen(run.output, marker));
  const missingMarkers = (spec.markers ?? []).filter(marker => !markersSeen.includes(marker));

  if (spec.parses === 'node-test') {
    const counts = parseTapOutput(run.output);
    if (!counts) return outcome('NOT_EXECUTED', { notes: ['node test summary missing from output'] });
    if (counts.tests === 0) return outcome('NOT_EXECUTED', { notes: ['stage executed zero tests'] });
    if (counts.fail > 0) return outcome('FAIL', { notes: [`${counts.fail} test failure(s) reported`] });
    if (counts.skipped !== counts.skipNames.length) {
      return outcome('NOT_EXECUTED', { notes: [`skipped count ${counts.skipped} cannot be attributed to named tests`] });
    }
    if (counts.skipped > 0) {
      const allow = spec.skipAllow ?? [];
      const disallowed = counts.skipNames.filter(name => !allow.some(pattern => name.includes(pattern)));
      if (disallowed.length > 0) {
        return outcome('NOT_EXECUTED', { notes: [`mandatory test skipped: ${disallowed[0]}`], counts, skipNames: counts.skipNames, markersSeen });
      }
    }
    if (missingMarkers.length > 0) {
      return outcome('NOT_EXECUTED', { notes: [`required evidence marker missing: ${missingMarkers[0]}`], counts, skipNames: counts.skipNames, markersSeen });
    }
    return outcome('PASS', { notes: [`${counts.tests} tests executed`] , counts, skipNames: counts.skipNames, markersSeen });
  }

  if (missingMarkers.length > 0) {
    return outcome('NOT_EXECUTED', { notes: [`required evidence marker missing: ${missingMarkers[0]}`], markersSeen });
  }
  if ((spec.markers ?? []).length > 0) return outcome('PASS', { notes: ['evidence markers present'], markersSeen });
  return outcome('PASS', { notes: [`exit 0 satisfies the stage contract`], markersSeen });
}

function specAllowsNaReason(spec, reason) {
  if (!reason || !ALLOWED_NA_REASONS.includes(reason)) return false;
  if (!spec) return false;
  if (spec.builtin === 'na') return spec.naReason === reason;
  if (spec.whenEnvAbsent === 'na') return reason === 'postgres-env-absent';
  return false;
}

// Overall outcome: violations dominate; otherwise FAIL > BLOCKED >
// NOT_EXECUTED > PASS. Mandatory NOT_EXECUTED/BLOCKED prevent PASS and a
// profile with zero executed tests cannot pass.
export function evaluateOverall(stages, binding = {}, specsById = {}) {
  const violations = [];
  if (!binding.gitShaStart) {
    violations.push({ rule: 'git-unavailable', detail: 'qualification could not bind a starting Git SHA' });
  } else if (binding.gitShaEnd !== binding.gitShaStart) {
    violations.push({
      rule: 'git-sha-changed',
      detail: `qualification started at ${binding.gitShaStart} and ended at ${binding.gitShaEnd}`
    });
  }
  if (binding.treeCleanStart === false) {
    violations.push({ rule: 'tree-dirty-start', detail: 'qualification must start from a clean tree' });
  }
  if (binding.treeCleanStart === true && binding.treeCleanEnd === false) {
    violations.push({ rule: 'tree-became-dirty', detail: 'worktree became dirty during qualification' });
  }
  for (const stage of stages) {
    if (stage.status === 'NOT_APPLICABLE' && !specAllowsNaReason(specsById[stage.id], stage.naReason)) {
      violations.push({ rule: 'na-reason-invalid', detail: `stage ${stage.id} is NOT_APPLICABLE without an allowed reason` });
    }
  }

  const hasFail = stages.some(stage => stage.status === 'FAIL');
  if (hasFail || violations.length > 0) return { result: 'FAIL', violations };
  if (stages.some(stage => stage.mandatory && stage.status === 'BLOCKED')) return { result: 'BLOCKED', violations };
  if (stages.some(stage => stage.mandatory && stage.status === 'NOT_EXECUTED')) return { result: 'NOT_EXECUTED', violations };

  const passed = stages.filter(stage => stage.status === 'PASS');
  if (passed.length === 0) {
    return { result: 'NOT_EXECUTED', violations: [...violations, { rule: 'zero-stages-passed', detail: 'no stage reached PASS' }] };
  }
  const executedTests = stages.reduce((total, stage) => {
    if (!stage.counts) return total;
    return total + (stage.counts.tests - stage.counts.skipped);
  }, 0);
  if (executedTests === 0) {
    return { result: 'NOT_EXECUTED', violations: [...violations, { rule: 'zero-tests-executed', detail: 'profile executed zero tests' }] };
  }
  return { result: 'PASS', violations };
}

// Classes whose definition includes a workload envelope (section 23:
// CI_CORRECTNESS needs >=100k rows with >=30s real CDC; PILOT needs its own
// envelope). A PASS without a bound workload can never claim them.
const WORKLOAD_REQUIRED_CLASSES = new Set(['CI_CORRECTNESS', 'PILOT']);

function classFor(profile, result) {
  if (result !== 'PASS') return 'NOT_ESTABLISHED';
  if (WORKLOAD_REQUIRED_CLASSES.has(profile.classLabel) && !profile.workload) return 'NOT_ESTABLISHED';
  return profile.classLabel;
}

function aggregateCounts(stages) {
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, executed: 0 };
  for (const stage of stages) {
    if (!stage.counts) continue;
    totals.tests += stage.counts.tests;
    totals.pass += stage.counts.pass;
    totals.fail += stage.counts.fail;
    totals.skipped += stage.counts.skipped;
  }
  totals.executed = totals.tests - totals.skipped;
  return totals;
}

function runProcess({ command, args, env, cwd, timeoutMs, shell }) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      windowsHide: true
    });
    const CAP = 8 * 1024 * 1024;
    let output = '';
    let truncated = false;
    const append = chunk => {
      if (output.length >= CAP) {
        truncated = true;
        return;
      }
      output += chunk;
      if (output.length > CAP) {
        output = output.slice(0, CAP);
        truncated = true;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => {
      resolvePromise({ spawnError: error.message, exitCode: null, signal: null, output, truncated });
    });
    child.on('close', (exitCode, signal) => {
      resolvePromise({ spawnError: null, exitCode, signal, output, truncated });
    });
  });
}

async function executeStage(spec, { cwd, evidenceDir, env }) {
  const logName = `stage-${spec.id}.log`;
  const logPath = join(evidenceDir, logName);

  if (spec.builtin === 'disk') {
    const result = checkDiskPreflight({ kind: spec.diskKind, estimatedPeakBytes: spec.estimatedPeakBytes, path: cwd });
    const classification = { diskAllowed: result.allowed, diskReason: result.code === 'DISK_PREFLIGHT_OK' ? result.reason : `${result.code}: ${result.reason}` };
    await writeFile(logPath, JSON.stringify(result, null, 2), 'utf8');
    return { ...classification, logName, output: '' };
  }
  if (spec.builtin === 'na') {
    await writeFile(logPath, `not applicable: ${spec.naReason}\n`, 'utf8');
    return { logName, output: '' };
  }

  const envMissing = (spec.requireEnv ?? []).some(name => !env[name]);
  if (envMissing) {
    await writeFile(logPath, `not executed: missing required environment ${(spec.requireEnv ?? []).filter(name => !env[name]).join(', ')}\n`, 'utf8');
    return { envMissing, logName, output: '' };
  }

  const run = await runProcess({
    command: spec.command,
    args: spec.args,
    env: { ...env, ...(spec.env ?? {}) },
    cwd,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    shell: spec.shell
  });
  await writeFile(
    logPath,
    `$ ${[spec.command, ...spec.args].join(' ')}\nexit=${run.exitCode} signal=${run.signal ?? ''} truncated=${run.truncated === true}\n${run.output}`,
    'utf8'
  );

  if (spec.artifacts) {
    for (const artifact of spec.artifacts) {
      const source = join(cwd, artifact);
      if (!existsSync(source)) continue;
      const target = join(evidenceDir, artifact);
      try {
        await rename(source, target);
      } catch {
        await copyFile(source, target);
        await unlink(source);
      }
    }
  }

  let meta = null;
  if (spec.captureMeta === 'postgres-probe') {
    const metaLine = (run.output ?? '').split('\n').find(line => line.startsWith('LIVE_PG_PROBE_META '));
    if (metaLine) {
      try {
        meta = JSON.parse(metaLine.slice('LIVE_PG_PROBE_META '.length));
      } catch {
        meta = null;
      }
    }
  }

  return {
    envMissing: false,
    exitCode: run.exitCode,
    signal: run.signal,
    output: run.output,
    spawnError: run.spawnError,
    logName,
    meta
  };
}

export async function runProfile(profileName, { evidenceDir = null, env = process.env, cwd = ROOT } = {}) {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown profile '${profileName}'. Known profiles: ${Object.keys(PROFILES).join(', ')}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = evidenceDir ?? join(ROOT, 'qualification', `standalone-${profileName}-${stamp}`);
  await mkdir(dir, { recursive: true });
  const writer = new EvidenceWriter({ runDir: dir });
  await writer.init();

  const startedAt = new Date().toISOString();
  const gitStart = gitInfo();
  const environment = await captureEnvironment();
  const databaseVersions = { postgres: null };
  const specsById = Object.fromEntries(profile.stages.map(stage => [stage.id, stage]));
  const stages = [];
  let stopping = false;

  for (const spec of profile.stages) {
    process.stdout.write(`[qualify] ${profileName}: ${spec.id} ...\n`);
    const begin = Date.now();
    let executed;
    if (stopping) {
      await writeFile(join(dir, `stage-${spec.id}.log`), 'not executed: an earlier stage failed or was blocked\n', 'utf8');
      executed = { prereqFailed: true, logName: `stage-${spec.id}.log`, output: '' };
    } else {
      const dependsFailed = spec.dependsOn
        ? stages.find(stage => stage.id === spec.dependsOn)?.status !== 'PASS'
        : false;
      if (dependsFailed) {
        await writeFile(join(dir, `stage-${spec.id}.log`), `not executed: prerequisite '${spec.dependsOn}' did not pass\n`, 'utf8');
        executed = { prereqFailed: true, logName: `stage-${spec.id}.log`, output: '' };
      } else {
        executed = await executeStage(spec, { cwd, evidenceDir: dir, env });
      }
    }
    const classified = classifyStage(spec, executed);
    const record = {
      id: spec.id,
      description: spec.description,
      mandatory: spec.mandatory === true,
      status: classified.status,
      naReason: classified.naReason,
      exitCode: executed.exitCode ?? null,
      signal: executed.signal ?? null,
      counts: classified.counts,
      skipNames: classified.skipNames,
      markersSeen: classified.markersSeen,
      notes: classified.notes,
      classification: classified.classification,
      log: executed.logName ?? null,
      durationMs: Date.now() - begin
    };
    if (executed.meta && spec.captureMeta === 'postgres-probe') {
      record.probeMeta = executed.meta;
      if (classified.status === 'PASS' && executed.meta.version) {
        databaseVersions.postgres = executed.meta.version;
      }
    }
    stages.push(record);
    process.stdout.write(`[qualify] ${profileName}: ${spec.id} -> ${record.status} (${record.durationMs}ms)\n`);
    if (record.status === 'FAIL' || record.status === 'BLOCKED') stopping = true;
  }

  const gitEnd = gitInfo();
  const endedAt = new Date().toISOString();
  const binding = {
    gitShaStart: gitStart.sha,
    gitShaEnd: gitEnd.sha,
    treeCleanStart: gitStart.clean,
    treeCleanEnd: gitEnd.clean
  };
  const overall = evaluateOverall(stages, binding, specsById);
  const counts = aggregateCounts(stages);
  const failures = stages.filter(stage => stage.status === 'FAIL').map(stage => ({ stage: stage.id, notes: stage.notes }));
  const manifest = {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    tool: 'scripts/qualify/run-standalone.js',
    policy: DISK_POLICY_VERSION,
    profile: profileName,
    result: overall.result,
    qualificationClass: classFor(profile, overall.result),
    gitSha: binding.gitShaStart,
    gitShaEnd: binding.gitShaEnd,
    treeClean: binding.treeCleanStart,
    treeCleanEnd: binding.treeCleanEnd,
    environmentVersions: {
      node: environment.env.node.version,
      npm: environment.env.node.npmVersion,
      platform: environment.env.os.platform,
      arch: environment.env.os.arch,
      release: environment.env.os.release
    },
    environmentDigest: environment.digest,
    databaseVersions,
    workload: profile.workload,
    testCounts: counts,
    failures,
    violations: overall.violations,
    stages,
    measuredResourceUsage: {
      runnerMaxRssKilobytes: process.resourceUsage().maxRSS,
      source: 'runner-process',
      note: 'per-stage resource envelopes are bound by workload stages (pilot/release) evidence'
    },
    startedAt,
    endedAt
  };

  const filesBeforeManifest = (await readdir(dir)).filter(file => file !== 'sha256sums.txt');
  manifest.evidence = { files: [...new Set([...filesBeforeManifest, 'qualification-manifest.json'])].sort() };
  await writer.writeJson('qualification-manifest.json', manifest);
  await writer.writeChecksums();

  process.stdout.write(`[qualify] ${profileName}: result ${manifest.result} (${counts.tests} tests, ${counts.skipped} skipped, class ${manifest.qualificationClass})\n`);
  process.stdout.write(`[qualify] evidence: ${dir}\n`);
  return { dir, manifest };
}

function isPlainFileName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

async function evidenceEntryKinds(dir) {
  const kinds = [];
  for (const name of await readdir(dir)) {
    const info = await lstat(join(dir, name));
    kinds.push({ name, isSymbolicLink: info.isSymbolicLink() });
  }
  return kinds;
}

export function assertNoSymlinks(entries) {
  const linked = entries.filter(entry => entry.isSymbolicLink).map(entry => entry.name);
  if (linked.length > 0) throw new Error(`symlink evidence entries are forbidden: ${linked.join(', ')}`);
}

// Independent verifier: reads only the evidence directory (plus its profile
// contract) and re-derives every claim. Throws with all problems on any
// contradiction; returns the manifest when the bundle is sound.
export async function verifyQualification(dir, { profiles: profilesMap = PROFILES } = {}) {
  const problems = [];
  const push = (rule, detail) => problems.push({ rule, detail });

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'qualification-manifest.json'), 'utf8'));
  } catch (error) {
    push('manifest-missing', `qualification-manifest.json unreadable: ${error.message}`);
    throw new Error(formatProblems(problems));
  }
  if (manifest.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) {
    push('schema-version', `unsupported schemaVersion ${manifest.schemaVersion}`);
  }

  const profile = profilesMap[manifest.profile];
  if (!profile) {
    push('unknown-profile', `profile '${manifest.profile}' has no authoritative contract`);
    throw new Error(formatProblems(problems));
  }
  const specsById = Object.fromEntries(profile.stages.map(stage => [stage.id, stage]));
  const requiredIds = profile.stages.map(stage => stage.id);

  if (!Array.isArray(manifest.stages)) {
    push('stages-missing', 'manifest.stages is not an array');
    throw new Error(formatProblems(problems));
  }
  const seenIds = new Set();
  for (const stage of manifest.stages) {
    if (seenIds.has(stage.id)) push('duplicate-stage', `stage '${stage.id}' appears more than once`);
    seenIds.add(stage.id);
  }
  for (const id of requiredIds) {
    if (!seenIds.has(id)) push('required-stage-absent', `profile ${manifest.profile} requires stage '${id}'`);
  }
  for (const stage of manifest.stages) {
    const spec = specsById[stage.id];
    if (!spec) {
      push('unknown-stage', `stage '${stage.id}' is not part of profile ${manifest.profile}`);
      continue;
    }
    if (!OUTCOMES.includes(stage.status)) {
      push('bad-status', `stage '${stage.id}' has non-terminal status '${stage.status}'`);
      continue;
    }
    if ((spec.mandatory === true) !== (stage.mandatory === true)) {
      push('contract-weakened', `stage '${stage.id}' mandatory flag does not match the profile contract`);
    }

    let output = null;
    if (!stage.log) {
      push('stage-log-absent', `stage '${stage.id}' has no evidence log`);
    } else {
      try {
        output = await readFile(join(dir, stage.log), 'utf8');
      } catch {
        push('stage-log-unreadable', `stage '${stage.id}' log cannot be read`);
      }
    }

    if (stage.status === 'NOT_APPLICABLE' && !specAllowsNaReason(spec, stage.naReason)) {
      push('na-reason-invalid', `stage '${stage.id}' is NOT_APPLICABLE without an allowed reason`);
    }

    const record = stage.classification ?? {};
    const classified = classifyStage(spec, {
      exitCode: stage.exitCode,
      signal: stage.signal,
      output: output ?? '',
      envMissing: record.envMissing === true,
      prereqFailed: record.prereqFailed === true,
      spawnError: record.spawnError,
      diskAllowed: record.diskAllowed,
      diskReason: record.diskReason
    });
    if (classified.status !== stage.status) {
      push('stage-status-claim', `stage '${stage.id}' claims ${stage.status} but the contract derives ${classified.status}`);
    }
    if (spec.parses === 'node-test' && stage.status === 'PASS') {
      if (!stage.counts || !classified.counts || JSON.stringify(stage.counts) !== JSON.stringify(classified.counts)) {
        push('counts-claim', `stage '${stage.id}' claims PASS with counts its log does not support`);
      }
      const parsed = output !== null ? parseTapOutput(output) : null;
      if (!parsed || parsed.tests === 0) {
        push('zero-tests-pass', `stage '${stage.id}' claims PASS without executed tests`);
      }
    }
  }

  const evidenceFiles = Array.isArray(manifest.evidence?.files) ? manifest.evidence.files : null;
  if (!evidenceFiles) {
    push('evidence-list-absent', 'manifest.evidence.files is missing');
  } else {
    if (new Set(evidenceFiles).size !== evidenceFiles.length) push('duplicate-evidence', 'manifest.evidence.files contains duplicates');
    for (const name of evidenceFiles) {
      if (!isPlainFileName(name)) push('unexpected-evidence-path', `evidence entry '${name}' is not a plain file name`);
    }
    let entries;
    try {
      entries = await evidenceEntryKinds(dir);
    } catch (error) {
      push('evidence-dir-unreadable', error.message);
      entries = [];
    }
    try {
      assertNoSymlinks(entries);
    } catch (error) {
      push('symlink-evidence', error.message);
    }
    const onDisk = entries.map(entry => entry.name).filter(name => name !== 'sha256sums.txt').sort();
    const pinned = evidenceFiles ? [...evidenceFiles].sort() : [];
    if (onDisk.length !== pinned.length || onDisk.some((name, index) => name !== pinned[index])) {
      push('file-set-mismatch', `on disk [${onDisk.join(', ')}] vs manifest [${pinned.join(', ')}]`);
    }
  }

  try {
    await verifySha256Sums(dir);
  } catch (error) {
    push('checksum-mismatch', error.message);
  }

  const binding = {
    gitShaStart: manifest.gitSha,
    gitShaEnd: manifest.gitShaEnd,
    treeCleanStart: manifest.treeClean,
    treeCleanEnd: manifest.treeCleanEnd
  };
  const overall = evaluateOverall(manifest.stages, binding, specsById);
  if (overall.result !== manifest.result) {
    push('result-claim', `manifest result ${manifest.result} does not follow from evidence (derived ${overall.result})`);
  }
  const counts = aggregateCounts(manifest.stages);
  if (manifest.testCounts && JSON.stringify(counts) !== JSON.stringify(manifest.testCounts)) {
    push('aggregate-counts-claim', 'aggregate testCounts disagree with stage records');
  }
  if (manifest.result === 'PASS' && counts.tests - counts.skipped <= 0) {
    push('zero-tests-pass', 'manifest claims PASS with zero executed tests');
  }
  const expectedClass = classFor(profile, manifest.result);
  if (manifest.qualificationClass !== expectedClass) {
    push('class-claim', `qualificationClass '${manifest.qualificationClass}' is not justified by result ${manifest.result}`);
  }
  if (JSON.stringify(manifest.workload ?? null) !== JSON.stringify(profile.workload ?? null)) {
    push('workload-claim', 'manifest workload does not match the profile contract');
  }
  const started = Date.parse(manifest.startedAt ?? '');
  const ended = Date.parse(manifest.endedAt ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    push('timestamps-invalid', 'startedAt/endedAt missing or unordered');
  }

  if (problems.length > 0) throw new Error(formatProblems(problems));
  return manifest;
}

function formatProblems(problems) {
  const lines = problems.map(problem => ` - [${problem.rule}] ${problem.detail}`);
  return `Qualification verification failed:\n${lines.join('\n')}`;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/qualify/run-standalone.js --profile <quick|correctness|postgres|release|pilot>
  node scripts/qualify/run-standalone.js --verify <evidence-dir>
  node scripts/qualify/run-standalone.js --list

Exit code is 0 only when the overall result is PASS.
`);
}

export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    return args.length === 0 ? 2 : 0;
  }
  const listAt = args.indexOf('--list');
  if (listAt !== -1) {
    for (const profile of Object.values(PROFILES)) {
      process.stdout.write(`${profile.name}: ${profile.stages.map(stage => stage.id).join(', ')}\n`);
    }
    return 0;
  }
  const verifyAt = args.indexOf('--verify');
  if (verifyAt !== -1) {
    const dir = args[verifyAt + 1];
    if (!dir) {
      process.stderr.write('--verify requires an evidence directory\n');
      return 2;
    }
    try {
      const manifest = await verifyQualification(resolvePath(dir));
      process.stdout.write(`Qualification evidence verified: ${dir}\nresult=${manifest.result} profile=${manifest.profile} class=${manifest.qualificationClass}\n`);
      return manifest.result === 'PASS' ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  const profileAt = args.indexOf('--profile');
  const profileName = profileAt !== -1 ? args[profileAt + 1] : null;
  if (!profileName) {
    process.stderr.write('--profile is required\n');
    printHelp();
    return 2;
  }
  const evidenceAt = args.indexOf('--evidence-dir');
  const evidenceDir = evidenceAt !== -1 ? args[evidenceAt + 1] : null;
  let outcome;
  try {
    outcome = await runProfile(profileName, { evidenceDir: evidenceDir ?? null });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    await verifyQualification(outcome.dir);
    process.stdout.write(`[qualify] self-verification: OK\n`);
  } catch (error) {
    process.stderr.write(`[qualify] self-verification FAILED\n${error.message}\n`);
    return 3;
  }
  return outcome.manifest.result === 'PASS' ? 0 : 1;
}

function resolvePath(target) {
  return target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target) ? target : join(process.cwd(), target);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv).then(code => {
    process.exitCode = code;
  });
}
