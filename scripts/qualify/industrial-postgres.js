#!/usr/bin/env node
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { resolveProfile, formatProfile, qualifiesIndustrialScale } from './profiles.js';
import { captureEnvironment } from './environment.js';
import { EvidenceWriter } from './evidence-writer.js';
import { ResourceSampler } from './sampler.js';
import { datasetId } from './dataset.js';
import { writeSha256Sums } from './checksums.js';
import { REQUIRED_SCENARIOS, requiredScenarioNames, foldScenarioFailures } from './scenarios.js';
import { measureDisk } from './disk-preflight.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--profile' && args[i + 1]) opts.profile = args[++i];
    else if (a === '--output' && args[i + 1]) opts.output = args[++i];
    else if (a.startsWith('--profile=')) opts.profile = a.split('=')[1];
    else if (a.startsWith('--output=')) opts.output = a.split('=')[1];
    else if (a === '--rows' && args[i + 1]) opts.rows = Number(args[++i]);
    else if (a === '--payload-bytes' && args[i + 1]) opts.payloadBytes = Number(args[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/qualify/industrial-postgres.js [options]

Options:
  --profile <name>        CI|SMALL|MEDIUM|LARGE|INDUSTRIAL (default: CI)
  --output <dir>          Output directory (default: qualification/<runId>)
  --rows <n>              Override row count
  --payload-bytes <n>     Override payload bytes
  --help                  Show this help

Env overrides:
  SPOOL_QUALIFY_PROFILE, SPOOL_QUALIFY_ROWS, SPOOL_QUALIFY_PAYLOAD_BYTES,
  SPOOL_QUALIFY_BATCH_SIZE, SPOOL_QUALIFY_WRITERS, SPOOL_QUALIFY_WORKERS,
  SPOOL_QUALIFY_CDC_DURATION_SECONDS, SPOOL_TEST_POSTGRES_ENDPOINT,
  SPOOL_TEST_POSTGRES_DATABASE, SPOOL_TEST_POSTGRES_USER, SPOOL_TEST_PG_PASSWORD

Examples:
  npm run qualify:postgres:ci
  node scripts/qualify/industrial-postgres.js --profile SMALL --output qualification/manual
`);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) { printHelp(); process.exit(0); }

  const profileName = opts.profile ?? process.env.SPOOL_QUALIFY_PROFILE ?? 'CI';
  const overrides = {};
  if (opts.rows) overrides.rows = opts.rows;
  if (opts.payloadBytes) overrides.payloadBytes = opts.payloadBytes;
  // Also check env overrides for rows etc.
  if (process.env.SPOOL_QUALIFY_ROWS) overrides.rows = Number(process.env.SPOOL_QUALIFY_ROWS);
  if (process.env.SPOOL_QUALIFY_PAYLOAD_BYTES) overrides.payloadBytes = Number(process.env.SPOOL_QUALIFY_PAYLOAD_BYTES);
  if (process.env.SPOOL_QUALIFY_BATCH_SIZE) overrides.batchSize = Number(process.env.SPOOL_QUALIFY_BATCH_SIZE);
  if (process.env.SPOOL_QUALIFY_WRITERS) overrides.writers = Number(process.env.SPOOL_QUALIFY_WRITERS);
  if (process.env.SPOOL_QUALIFY_WORKERS) overrides.workers = Number(process.env.SPOOL_QUALIFY_WORKERS);
  if (process.env.SPOOL_QUALIFY_CDC_DURATION_SECONDS) overrides.cdcDurationSeconds = Number(process.env.SPOOL_QUALIFY_CDC_DURATION_SECONDS);

  const profile = resolveProfile(profileName, overrides);
  const runId = `spool-qualify-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  // PG config
  const pgEndpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT;
  const pgDatabase = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
  const pgUser = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
  const pgPassword = process.env.SPOOL_TEST_PG_PASSWORD ?? process.env.SPOOL_TEST_POSTGRES_PASSWORD ?? '';
  let pgConfig = null;
  let envPgConfig = null;
  if (pgEndpoint && pgPassword) {
    const url = new URL(pgEndpoint);
    pgConfig = { host: url.hostname, port: Number(url.port || 5432), database: pgDatabase, user: pgUser, password: pgPassword };
    envPgConfig = { host: url.hostname, port: Number(url.port || 5432), database: pgDatabase, user: pgUser, password: pgPassword };
  } else {
    console.error('PostgreSQL qualification requires SPOOL_TEST_POSTGRES_ENDPOINT and SPOOL_TEST_PG_PASSWORD');
    console.error('Set them or run with --help for usage');
    process.exit(2);
  }

  const outputRoot = opts.output ?? join('qualification', runId);
  const runDir = outputRoot;
  await mkdir(runDir, { recursive: true });

  // Environment capture
  const { env, digest: envDigest } = await captureEnvironment({ pgConfig: envPgConfig });
  const gitDirty = env.git.dirty;
  // Scenarios construct production command services, which require a
  // release identity with an exact git SHA. Bind the captured HEAD SHA
  // through the existing SPOOL_COMMIT_SHA seam the scenarios already read
  // (explicit overrides win), so the envelope fails only on workload
  // behavior, never on release identity.
  if (!process.env.SPOOL_COMMIT_SHA && /^[a-f0-9]{40}$/.test(env.git?.sha ?? '')) {
    process.env.SPOOL_COMMIT_SHA = env.git.sha;
  }
  const releaseGrade = !gitDirty;
  const startTime = new Date().toISOString();
  const startMonotonic = process.hrtime.bigint();
  const seed = `qualify-${runId}-${profile.name}`;
  const did = datasetId({ seed, rowCount: profile.rows, payloadBytes: profile.payloadBytes });

  const evidenceWriter = new EvidenceWriter({ runDir });
  await evidenceWriter.init();
  const sampler = new ResourceSampler({ evidenceWriter, intervalMs: 1000 });
  sampler.start();

  const failures = [];
  const metrics = {};
  let overallResult = 'PASS';
  let configDigest = null;

  // Config: requested vs effective is pinned here and again in the manifest.
  // An immutable profile name with a diverged configuration is rejected by
  // the verifier — overrides produce a <BASE>_CUSTOM run, never a quiet PASS
  // under the larger name.
  const config = {
    profile,
    requestedProfile: profile.requestedProfile ?? profile.name,
    requestedConfig: profile.requestedConfig ?? { ...profile },
    effectiveConfig: {
      rows: profile.rows, payloadBytes: profile.payloadBytes, batchSize: profile.batchSize,
      writers: profile.writers, workers: profile.workers,
      cdcDurationSeconds: profile.cdcDurationSeconds,
      largeTransactionRows: profile.largeTransactionRows, maxRssBytes: profile.maxRssBytes
    },
    seed,
    datasetId: did,
    runId,
    pgConfig: { host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user },
    outputDir: runDir,
    overrides
  };
  configDigest = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  await evidenceWriter.writeJson('config.json', config);
  await evidenceWriter.writeJson('environment.json', env);

  // Preflight: PG replication settings and real disk headroom. Any preflight
  // failure fails the run: an unmeasured environment cannot produce a
  // trustworthy qualification verdict.
  const preflightFailures = [];
  try {
    const { Client } = await import('pg');
    const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await c.connect();
    const walRes = await c.query(`SHOW wal_level`);
    if (!['logical', 'replica'].includes(walRes.rows[0].wal_level) && profile.cdcDurationSeconds > 0) {
      preflightFailures.push({ scenario: 'preflight', code: 'WAL_LEVEL_NOT_LOGICAL', message: `wal_level=${walRes.rows[0].wal_level}, CDC requires logical`, expected: false, classification: 'ENVIRONMENT', timestamp: new Date().toISOString() });
    }
    await c.end();
  } catch (e) {
    preflightFailures.push({ scenario: 'preflight', code: 'PREFLIGHT_ERROR', message: e.message, expected: false, classification: 'ENVIRONMENT', timestamp: new Date().toISOString() });
  }
  // Real disk measurement (shared disk-preflight on the evidence directory):
  // source materialization plus target-side staging plus WAL headroom. Memory
  // free is not disk free; the old freemem approximation is gone.
  try {
    const measurement = measureDisk(runDir);
    if (!measurement.measurable) throw new Error(measurement.error);
    const availableBytes = measurement.freeBytes;
    const neededBytes = Math.ceil(profile.rows * (profile.payloadBytes + 512) * 3);
    if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(neededBytes)) {
      throw new Error('disk measurement returned non-numeric capacity');
    }
    if (availableBytes < neededBytes) {
      preflightFailures.push({ scenario: 'preflight', code: 'INSUFFICIENT_DISK', message: `available ${availableBytes} bytes < required ${neededBytes} bytes for profile ${profile.name}`, expected: false, classification: 'ENVIRONMENT', timestamp: new Date().toISOString() });
    } else {
      metrics.preflight = { status: 'PASS', availableBytes, neededBytes, measuredAt: measurement.measuredAt };
    }
  } catch (e) {
    preflightFailures.push({ scenario: 'preflight', code: 'DISK_UNMEASURABLE', message: `Disk headroom cannot be measured: ${e.message}`, expected: false, classification: 'ENVIRONMENT', timestamp: new Date().toISOString() });
  }
  if (preflightFailures.length) {
    failures.push(...preflightFailures);
    overallResult = 'FAIL';
  }

  // Helper to run scenario with timing and failure capture. Failures returned
  // inside a result propagate exactly like thrown failures: any unexpected
  // failure (not an expected refusal) fails the run. Recording a failure
  // without failing was the old silent-PASS hole. The fold rule lives in
  // scenarios.js (unit-tested) so the harness cannot drift from it.
  async function runScenario(entry, fn) {
    const name = entry.name;
    const start = process.hrtime.bigint();
    const startWall = new Date().toISOString();
    evidenceWriter.appendRaw({ scenario: name, event: 'scenario_started', timestamp: startWall });
    // Watchdog heartbeats: while a scenario runs, emit periodic diagnostics
    // (elapsed, RSS, heap) so a hung stage is identifiable from raw.jsonl
    // instead of a silent gap. Heartbeats never pass/fail anything — a
    // legitimate multi-hour operation emits heartbeats and continues.
    const HEARTBEAT_MS = 30_000;
    const heartbeat = setInterval(() => {
      const mem = process.memoryUsage();
      evidenceWriter.appendRaw({
        scenario: name, event: 'scenario_heartbeat',
        elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
        rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
        timestamp: new Date().toISOString()
      });
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
    try {
      const result = await fn().finally(() => clearInterval(heartbeat));
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      evidenceWriter.appendRaw({ scenario: name, event: 'scenario_completed', durationMs: ms, timestamp: new Date().toISOString() });
      const folded = foldScenarioFailures(result?.failures);
      if (folded.failures.length) failures.push(...folded.failures);
      // Requested-vs-effective enforcement: the scenario must have consumed
      // the declared profile fields exactly. A missing effectiveConfig or
      // any divergence is PROFILE_DOWNSCALED — the run is not that profile.
      const effective = result?.metrics?.effectiveConfig;
      const downscaled = [];
      if (!effective || typeof effective !== 'object') {
        downscaled.push({ scenario: name, code: 'PROFILE_EFFECTIVE_UNRECORDED', message: `Scenario ${name} did not record its effective configuration`, expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
      } else {
        for (const key of entry.profileKeys ?? []) {
          if (effective[key] !== profile[key]) {
            downscaled.push({ scenario: name, code: 'PROFILE_DOWNSCALED', message: `Scenario ${name} ran ${key}=${effective[key]} instead of declared ${profile[key]}`, expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
          }
        }
      }
      if (downscaled.length) failures.push(...downscaled);
      const status = folded.status === 'FAIL' || downscaled.length ? 'FAIL' : 'PASS';
      metrics[name] = { ...result?.metrics, durationMs: ms, status };
      if (status === 'FAIL') overallResult = 'FAIL';
      return result;
    } catch (e) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      evidenceWriter.appendRaw({ scenario: name, event: 'scenario_failed', durationMs: ms, error: e.message, code: e.code ?? 'UNKNOWN', timestamp: new Date().toISOString() });
      const classification = e.code === 'ENVIRONMENT_UNQUALIFIED' ? 'ENVIRONMENT' : (e.expected ? 'EXPECTED_REFUSAL' : 'CORRECTNESS');
      failures.push({ scenario: name, code: e.code ?? 'UNKNOWN', message: e.message, expected: !!e.expected, classification, timestamp: new Date().toISOString() });
      metrics[name] = { status: e.expected ? 'PASS' : 'FAIL', durationMs: ms, error: e.message, code: e.code };
      if (!e.expected) overallResult = 'FAIL';
      return null;
    }
  }

  // Run every required scenario sequentially. The manifest (scenarios.js) is
  // statically imported: no dynamic loading, no per-scenario try/catch, no
  // stubs. A missing module crashes the harness instead of passing silently.
  for (const entry of REQUIRED_SCENARIOS) {
    await runScenario(entry, () => entry.run({ profile, seed, evidenceWriter, pgConfig, runId }));
  }

  sampler.stop();
  const resourceSummary = sampler.summary();
  metrics.resource = resourceSummary;

  // Check memory ceiling
  if (profile.maxRssBytes && resourceSummary.rss?.peak > profile.maxRssBytes) {
    failures.push({ scenario: 'resource', code: 'MEMORY_CEILING_EXCEEDED', message: `peak RSS ${resourceSummary.rss.peak} exceeds ceiling ${profile.maxRssBytes}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
    overallResult = 'FAIL';
  }

  // Required-scenario completeness: every manifest entry must have reported
  // with a terminal status. A scenario that never ran is INCOMPLETE, never a
  // silent pass — this is what makes exit code 3 reachable and honest.
  for (const name of requiredScenarioNames()) {
    const status = metrics[name]?.status;
    if (status !== 'PASS' && status !== 'FAIL') {
      failures.push({ scenario: name, code: 'SCENARIO_NOT_RUN', message: `Required scenario ${name} produced no terminal status`, expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
      metrics[name] = { status: 'FAIL', error: 'SCENARIO_NOT_RUN' };
      overallResult = 'INCOMPLETE';
    }
  }

  // Write metrics and failures
  await evidenceWriter.writeJson('metrics.json', metrics);
  await evidenceWriter.writeJson('failures.json', failures);

  // Close writer before checksums (ensure raw.jsonl flushed)
  await evidenceWriter.close();

  // Stub tripwire: no scenario may record a stub event and still pass. The
  // manifest-driven loop has no stub paths; this scan turns any future
  // stub-shaped evidence into a harness failure instead of a quiet PASS.
  let stubEvents = 0;
  try {
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const lines = createInterface({ input: createReadStream(join(runDir, 'raw.jsonl'), 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line)?.event === 'stub') stubEvents += 1;
      } catch {
        failures.push({ scenario: 'evidence', code: 'RAW_EVENT_CORRUPT', message: 'raw.jsonl contains a non-JSON line', expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
        overallResult = 'FAIL';
        break;
      }
    }
  } catch (e) {
    failures.push({ scenario: 'evidence', code: 'RAW_UNREADABLE', message: `raw.jsonl cannot be scanned for stubs: ${e.message}`, expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
    overallResult = 'FAIL';
  }
  if (stubEvents > 0) {
    failures.push({ scenario: 'evidence', code: 'STUB_EVENTS_PRESENT', message: `${stubEvents} stub events recorded; stubs never pass`, expected: false, classification: 'HARNESS', timestamp: new Date().toISOString() });
    overallResult = 'FAIL';
    await writeFile(join(runDir, 'failures.json'), JSON.stringify(failures, null, 2), 'utf8');
  }

  const endTime = new Date().toISOString();
  const durationMs = Number(process.hrtime.bigint() - startMonotonic) / 1e6;

  // Manifest (schemaVersion 4): evidence.files is the complete sorted file
  // set excluding only sha256sums.txt itself — a file cannot contain its own
  // checksum, so checksums live in sha256sums.txt alone and the manifest pins
  // the set, never stale embedded sums. The verifier enforces set equality.
  // report.md is listed although written after: nothing else appears later.
  const evidenceFiles = [...(await readdir(runDir)), 'manifest.json', 'report.md'].sort();
  const scenarioStatus = {};
  for (const name of requiredScenarioNames()) scenarioStatus[name] = metrics[name]?.status ?? 'MISSING';
  const unexpectedFailures = failures.filter(f => f.classification !== 'EXPECTED_REFUSAL' && f.expected === false).length;
  const manifest = {
    schemaVersion: 4,
    qualificationRunId: runId,
    suiteVersion: 'industrial-postgres-v1',
    repository: 'dharan1007/spool',
    commitSha: process.env.SPOOL_COMMIT_SHA ?? env.git.sha ?? 'unknown',
    dirty: gitDirty,
    profile: profile.name,
    profileConfig: profile,
    requestedProfile: config.requestedProfile,
    requestedConfig: config.requestedConfig,
    effectiveConfig: config.effectiveConfig,
    datasetId: did,
    seed,
    startTime,
    endTime,
    durationMs,
    environmentDigest: envDigest,
    configDigest: `sha256:${configDigest}`,
    result: overallResult,
    // releaseGrade is an integrity/reproducibility claim for THIS workload.
    // It is intentionally distinct from industrial-scale qualification:
    // CI/SMALL/MEDIUM/LARGE can produce release-grade evidence, but only the
    // immutable 1B-row / 24h INDUSTRIAL profile may claim industrial scale.
    releaseGrade: overallResult === 'PASS' && releaseGrade,
    industrialScaleGrade: qualifiesIndustrialScale({
      result: overallResult,
      dirty: gitDirty,
      profile: profile.name,
      requestedProfile: config.requestedProfile
    }),
    evidence: {
      files: evidenceFiles
    },
    scenarios: scenarioStatus,
    summary: {
      totalScenarios: requiredScenarioNames().length,
      scenariosRun: Object.values(scenarioStatus).filter(status => status === 'PASS' || status === 'FAIL').length,
      failures: failures.length,
      expectedRefusals: failures.filter(f => f.classification === 'EXPECTED_REFUSAL').length,
      unexpectedFailures,
      stubs: stubEvents
    }
  };
  // Report (written before the manifest so the manifest's file set is
  // complete; report content pins the same locals the manifest records).
  const commitSha = process.env.SPOOL_COMMIT_SHA ?? env.git.sha ?? 'unknown';
  const gradeReason = manifest.result === 'PASS'
    ? (manifest.releaseGrade ? null : (gitDirty ? 'DIRTY_WORKTREE' : 'UNKNOWN'))
    : `RESULT_${manifest.result}`;
  const industrialScaleReason = manifest.industrialScaleGrade
    ? null
    : (profile.name === 'INDUSTRIAL'
        ? (manifest.result !== 'PASS' ? `RESULT_${manifest.result}` : (gitDirty ? 'DIRTY_WORKTREE' : 'NOT_IMMUTABLE_INDUSTRIAL'))
        : `PROFILE_${profile.name}_IS_NOT_INDUSTRIAL_SCALE`);
  const report = `# SPOOL PostgreSQL Qualification

Run: ${runId}
Profile: ${formatProfile(profile)} (${profile.description})
Commit: ${commitSha}${gitDirty ? ' (dirty)' : ''}
Dataset: ${did}
Seed: ${seed}
Environment: ${env.os.platform} ${env.os.arch} Node ${env.node.version} PG ${env.pg.serverVersion ?? 'unknown'}
Duration: ${(durationMs / 1000).toFixed(1)}s
Result: **${overallResult}**
Release integrity grade: ${manifest.releaseGrade ? 'true' : 'false'}${gradeReason ? ` (${gradeReason})` : ''}
Industrial scale grade: ${manifest.industrialScaleGrade ? 'true' : 'false'}${industrialScaleReason ? ` (${industrialScaleReason})` : ''}

## Summary
- Scenarios: ${manifest.summary.totalScenarios} (run: ${manifest.summary.scenariosRun})
- Failures: ${failures.length} (expected refusals: ${manifest.summary.expectedRefusals}, stubs: ${manifest.summary.stubs})
- Peak RSS: ${resourceSummary.rss ? `${(resourceSummary.rss.peak / 1024 / 1024).toFixed(1)} MiB` : 'n/a'} (ceiling ${(profile.maxRssBytes / 1024 / 1024).toFixed(0)} MiB)
- Throughput (target): ${metrics['postgres.target.load']?.rowsPerSec ? `${metrics['postgres.target.load'].rowsPerSec.toFixed(0)} rows/s` : 'n/a'}

## Scenarios
${requiredScenarioNames().map(name => `- **${name}**: ${manifest.scenarios[name] ?? 'MISSING'}`).join('\n')}

## Failures
${failures.length === 0 ? 'None' : failures.map(f => `- [${f.classification}] ${f.scenario} ${f.code}: ${f.message} (expected=${f.expected})`).join('\n')}

## Resource
- RSS initial: ${resourceSummary.rss?.initial ? `${(resourceSummary.rss.initial / 1024 / 1024).toFixed(1)} MiB` : 'n/a'}
- RSS peak: ${resourceSummary.rss?.peak ? `${(resourceSummary.rss.peak / 1024 / 1024).toFixed(1)} MiB` : 'n/a'}
- Heap median: ${resourceSummary.heap?.median ? `${(resourceSummary.heap.median / 1024 / 1024).toFixed(1)} MiB` : 'n/a'}

## Evidence
- Directory: ${runDir}
- Files: ${evidenceFiles.join(', ')}

## Limits Observed
- Max CDC lag: ${metrics['postgres.cdc.soak']?.maxLagMs ?? 'n/a'} ms
- Verification throughput: ${metrics['postgres.content-exact.verification']?.rowsPerSec ?? 'n/a'} rows/s
- Repair throughput: ${metrics['postgres.repair.load']?.rowsPerSec ?? 'n/a'} rows/s

> Generated at ${new Date().toISOString()} by industrial-postgres qualification harness.
`;
  await writeFile(join(runDir, 'report.md'), report, 'utf8');
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ ...manifest, releaseGradeReason: gradeReason }, null, 2), 'utf8');

  // Single checksums write, last: covers every evidence file including the
  // manifest and the report. The manifest pins the set; this file pins
  // contents; the verifier enforces both.
  await writeSha256Sums(runDir);

  console.log(`\nQualification ${overallResult} — evidence at ${runDir}`);
  console.log(`Profile: ${formatProfile(profile)}`);
  console.log(`Dataset: ${did}`);
  console.log(`Commit: ${commitSha}${gitDirty ? ' (dirty)' : ''}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  if (failures.length) console.log(`Failures: ${failures.length} (see failures.json)`);
  console.log(`Report: ${join(runDir, 'report.md')}`);

  const exitCode = overallResult === 'PASS' ? 0 : overallResult === 'FAIL' ? 1 : 3;
  process.exit(exitCode);
}

main().catch(e => {
  console.error('Qualification harness fatal:', e);
  process.exit(2);
});
