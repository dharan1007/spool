import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeBenchmarkEvidence, verifyBenchmarkEvidence } from '../benchmarks/evidence.js';

test('benchmark evidence writes the immutable layout with verifiable hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-bench-evidence-'));
  try {
    const written = await writeBenchmarkEvidence({
      resultsDir: root,
      suite: 'SPOOL-Bench',
      suiteVersion: 1,
      sourceCommit: 'a'.repeat(40),
      benchmarkCommit: null,
      competitor: null,
      metrics: { rows: 100, rowsPerSecond: 1000 },
      failures: [],
      comparison: null,
      now: new Date('2026-09-14T00:00:00.000Z')
    });
    assert.equal(await verifyBenchmarkEvidence(written.dir), true);
    const manifest = JSON.parse(await readFile(join(written.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.suite, 'SPOOL-Bench');
    assert.equal(manifest.sourceCommit, 'a'.repeat(40));
    assert.equal(manifest.environment.node, process.version);
    assert.equal(manifest.environment.platform, process.platform);
    const comparison = JSON.parse(await readFile(join(written.dir, 'comparison.json'), 'utf8'));
    assert.equal(comparison.comparable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('benchmark evidence verification detects tampering and missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-bench-evidence-tamper-'));
  try {
    const written = await writeBenchmarkEvidence({
      resultsDir: root,
      suite: 'SPOOL-Bench',
      suiteVersion: 1,
      sourceCommit: 'b'.repeat(40),
      metrics: { rows: 10 },
      now: new Date('2026-09-14T00:00:00.000Z')
    });
    assert.equal(await verifyBenchmarkEvidence(written.dir), true);
    const { writeFile, rm: remove } = await import('node:fs/promises');
    await writeFile(join(written.dir, 'metrics.json'), '{"rows":999}\n');
    await assert.rejects(() => verifyBenchmarkEvidence(written.dir), /BENCHMARK_EVIDENCE_TAMPERED/);
    await remove(join(written.dir, 'metrics.json'));
    await assert.rejects(() => verifyBenchmarkEvidence(written.dir), /BENCHMARK_EVIDENCE_(TAMPERED|INCOMPLETE)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('benchmark evidence requires suite identity and metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-bench-evidence-invalid-'));
  try {
    await assert.rejects(() => writeBenchmarkEvidence({ resultsDir: root, suiteVersion: 1, metrics: {} }), /INVALID_BENCHMARK_EVIDENCE/);
    await assert.rejects(() => writeBenchmarkEvidence({ resultsDir: root, suite: 'x', suiteVersion: 0, metrics: {} }), /INVALID_BENCHMARK_EVIDENCE/);
    await assert.rejects(() => writeBenchmarkEvidence({ resultsDir: root, suite: 'x', suiteVersion: 1 }), /INVALID_BENCHMARK_EVIDENCE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
