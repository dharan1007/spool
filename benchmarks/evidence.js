import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { fail } from '../src/core/errors.js';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function environmentFingerprint() {
  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  });
}

function utcTimestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, '-');
}

export async function writeBenchmarkEvidence({
  resultsDir = 'benchmarks/results',
  suite,
  suiteVersion,
  sourceCommit = null,
  benchmarkCommit = null,
  competitor = null,
  metrics,
  failures = [],
  comparison = null,
  now = new Date()
} = {}) {
  if (typeof suite !== 'string' || !suite) fail('INVALID_BENCHMARK_EVIDENCE', 'suite is required');
  if (!Number.isSafeInteger(suiteVersion) || suiteVersion < 1) fail('INVALID_BENCHMARK_EVIDENCE', 'suiteVersion must be a positive safe integer');
  if (!metrics || typeof metrics !== 'object') fail('INVALID_BENCHMARK_EVIDENCE', 'metrics are required');
  if (!Array.isArray(failures)) fail('INVALID_BENCHMARK_EVIDENCE', 'failures must be an array');
  const timestamp = utcTimestamp(now);
  const dir = join(resultsDir, suite, timestamp);
  await mkdir(join(dir, 'raw'), { recursive: true });

  let resolvedSourceCommit = sourceCommit;
  if (resolvedSourceCommit == null) {
    try {
      const { execFileSync } = await import('node:child_process');
      resolvedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
    } catch { /* recorded explicitly as unavailable */ }
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    suite,
    suiteVersion,
    recordedAt: now.toISOString(),
    sourceCommit: resolvedSourceCommit,
    benchmarkCommit,
    competitor,
    environment: environmentFingerprint()
  });
  const files = {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'environment.json': `${JSON.stringify(manifest.environment, null, 2)}\n`,
    'raw/metrics.json': `${JSON.stringify(metrics, null, 2)}\n`,
    'metrics.json': `${JSON.stringify(metrics, null, 2)}\n`,
    'failures.json': `${JSON.stringify(failures, null, 2)}\n`,
    'comparison.json': `${JSON.stringify(comparison ?? { comparable: false, reason: 'no baseline recorded for this environment' }, null, 2)}\n`
  };
  const sums = [];
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
    sums.push(`${sha256(Buffer.from(body, 'utf8'))}  ${name}`);
  }
  const report = [
    `# ${suite} evidence`,
    '',
    `- recorded: ${manifest.recordedAt}`,
    `- source commit: ${manifest.sourceCommit ?? 'unavailable'}`,
    `- benchmark commit: ${manifest.benchmarkCommit ?? 'in-repo suite'}`,
    `- failures: ${failures.length}`,
    ''
  ].join('\n');
  await writeFile(join(dir, 'report.md'), report, 'utf8');
  sums.push(`${sha256(Buffer.from(report, 'utf8'))}  report.md`);
  sums.sort();
  await writeFile(join(dir, 'sha256sums.txt'), `${sums.join('\n')}\n`, 'utf8');
  return Object.freeze({ dir, manifest, files: Object.freeze(Object.keys(files).concat(['report.md', 'sha256sums.txt'])) });
}

export async function verifyBenchmarkEvidence(dir) {
  const entries = (await readdir(dir, { recursive: true })).map(entry => entry.replaceAll('\\', '/'));
  const sumsRaw = await readFile(join(dir, 'sha256sums.txt'), 'utf8');
  const expected = new Map(sumsRaw.trim().split('\n').map(line => {
    const [digest, ...rest] = line.trim().split(/\s+/);
    return [rest.join(' '), digest];
  }));
  for (const [name, digest] of expected) {
    if (!entries.includes(name)) fail('BENCHMARK_EVIDENCE_INCOMPLETE', `evidence file missing: ${name}`);
    const body = await readFile(join(dir, name));
    if (sha256(body) !== digest) fail('BENCHMARK_EVIDENCE_TAMPERED', `evidence digest mismatch: ${name}`);
  }
  return true;
}
