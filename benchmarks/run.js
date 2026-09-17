import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createDemoCsv, demoMapping, demoTargetSchema } from '../src/core/demo.js';
import { parseCsv } from '../src/core/csv.js';
import { MigrationEngine } from '../src/core/migration.js';
import { PHASES } from '../src/core/state-machine.js';
import { toolNamesForPhase, toolDefinitionForName } from '../src/webmcp/registry.js';
import { runSpoolBench } from './spool-bench.js';
import { writeBenchmarkEvidence } from './evidence.js';
import { generateSigningKeyPair, signCanonical, verifyCanonical } from '../src/platform/signing.js';
import { sha256Bytes, sha256CanonicalList } from '../src/platform/artifact-root.js';

const sizes = [1_000, 10_000, 50_000];
const migration = [];
for (const size of sizes) {
  const csv = createDemoCsv(size);
  const parseStart = performance.now();
  const parsed = parseCsv(csv);
  const parseMs = performance.now() - parseStart;
  const engine = new MigrationEngine();
  const runStart = performance.now();
  const result = engine.run(parsed.rows, demoMapping(), 1, demoTargetSchema());
  const runMs = performance.now() - runStart;
  migration.push({
    rows: size,
    parseMs: Number(parseMs.toFixed(2)),
    transformMs: Number(runMs.toFixed(2)),
    transformRowsPerSecond: Math.round(size / (runMs / 1000)),
    validRows: result.validRows,
    invalidRows: result.invalidRows
  });
}

const phases = [PHASES.EMPTY, PHASES.SOURCE_READY, PHASES.TARGET_READY, PHASES.MAPPING_DRAFT, PHASES.MAPPING_VALID, PHASES.RUNNING, PHASES.PAUSED, PHASES.COMPLETE];
const allNames = [...new Set(phases.flatMap(toolNamesForPhase))].sort();
const baselineBytes = Buffer.byteLength(JSON.stringify(allNames.map(toolDefinitionForName)));
const temporal = phases.map(phase => {
  const names = toolNamesForPhase(phase);
  return { phase, toolCount: names.length, serializedDefinitionBytes: Buffer.byteLength(JSON.stringify(names.map(toolDefinitionForName))) };
});
const averageTools = temporal.reduce((s, x) => s + x.toolCount, 0) / temporal.length;
const averageBytes = temporal.reduce((s, x) => s + x.serializedDefinitionBytes, 0) / temporal.length;

const signingIterations = 2_000;
const { privateKey, publicKey } = generateSigningKeyPair();
const signingPayload = { product: 'SPOOL', schemaVersion: 1, domain: 'release-parity-v1', version: '1.1.1', commit: 'a'.repeat(40), artifactRootSha256: 'b'.repeat(64) };
const signingStart = performance.now();
const signed = [];
for (let i = 0; i < signingIterations; i++) signed.push(signCanonical('release-parity-v1', { ...signingPayload, nonce: i }, privateKey));
const signingMs = performance.now() - signingStart;
const verifyStart = performance.now();
for (let i = 0; i < signingIterations; i++) verifyCanonical('release-parity-v1', { ...signingPayload, nonce: i }, signed[i].signature, publicKey);
const verifyMs = performance.now() - verifyStart;
const canonicalStart = performance.now();
const canonicalIterations = 10_000;
for (let i = 0; i < canonicalIterations; i++) sha256CanonicalList('release-parity-v1', Buffer.from(`block-${i}`));
const canonicalMs = performance.now() - canonicalStart;

const releaseIntegrity = Object.freeze({
  envelopeSignsPerSecond: Math.round(signingIterations / (signingMs / 1000)),
  envelopeVerificationsPerSecond: Math.round(signingIterations / (verifyMs / 1000)),
  canonicalListHashesPerSecond: Math.round(canonicalIterations / (canonicalMs / 1000))
});

const report = {
  suite: 'SPOOL-Bench',
  suiteVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  migration,
  temporalWebMcp: {
    baselinePermanentToolCount: allNames.length,
    baselineSerializedDefinitionBytes: baselineBytes,
    averageActiveToolCount: Number(averageTools.toFixed(2)),
    averageSerializedDefinitionBytes: Math.round(averageBytes),
    averageToolCountReductionPct: Number(((1 - averageTools / allNames.length) * 100).toFixed(1)),
    averageDefinitionByteReductionPct: Number(((1 - averageBytes / baselineBytes) * 100).toFixed(1)),
    phases: temporal
  },
  releaseIntegrity,
  ...(await runSpoolBench()),
  caveat: 'These are local deterministic engine and serialized-schema measurements, not universal LLM success-rate claims.'
};

await writeFile(new URL('./latest.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  '# SPOOL Benchmarks',
  '',
  `Generated: ${report.generatedAt}`,
  'Suite: SPOOL-Bench v1',
  '',
  '## Deterministic migration engine',
  '',
  '| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |',
  '|---:|---:|---:|---:|---:|---:|',
  ...migration.map(x => `| ${x.rows.toLocaleString()} | ${x.parseMs} ms | ${x.transformMs} ms | ${x.transformRowsPerSecond.toLocaleString()} | ${x.validRows.toLocaleString()} | ${x.invalidRows.toLocaleString()} |`),
  '',
  '## Content verification (exact row-hash projection)',
  '',
  '| Rows | Verify | Rows/sec |',
  '|---:|---:|---:|',
  ...report.contentVerification.map(x => `| ${x.rows.toLocaleString()} | ${x.verifyMs} ms | ${x.verifyRowsPerSecond.toLocaleString()} |`),
  '',
  '## Merkle trees (root + inclusion proof + verify)',
  '',
  '| Leaves | Root/prove/verify | Leaves/sec |',
  '|---:|---:|---:|',
  ...report.merkle.map(x => `| ${x.leaves.toLocaleString()} | ${x.rootProveVerifyMs} ms | ${x.leavesPerSecond.toLocaleString()} |`),
  '',
  '## Repair plans (DIFF evidence to hash-bound operations)',
  '',
  '| Missing rows | Operations | Plan build |',
  '|---:|---:|---:|',
  ...report.repairPlan.map(x => `| ${x.missingRows.toLocaleString()} | ${x.operations.toLocaleString()} | ${x.planMs} ms |`),
  '',
  '## SQLite end-to-end (fenced ledger-backed batches)',
  '',
  '| Rows | Write | Rows/sec |',
  '|---:|---:|---:|',
  ...report.sqliteEndToEnd.map(x => `| ${x.rows.toLocaleString()} | ${x.writeMs} ms | ${x.writeRowsPerSecond.toLocaleString()} |`),
  '',
  '## Release integrity (signed envelope + canonical evidence)',
  '',
  '| Operation | Ops/sec |',
  '|---:|---:|',
  `| Signed envelope creation | ${report.releaseIntegrity.envelopeSignsPerSecond.toLocaleString()} |`,
  `| Signed envelope verification | ${report.releaseIntegrity.envelopeVerificationsPerSecond.toLocaleString()} |`,
  `| Canonical evidence list hashing | ${report.releaseIntegrity.canonicalListHashesPerSecond.toLocaleString()} |`,
  '',
  '## Temporal WebMCP surface',
  '',
  `A permanent surface across the measured phases contains **${allNames.length} tools** / **${baselineBytes.toLocaleString()} serialized definition bytes**. SPOOL exposes **${report.temporalWebMcp.averageActiveToolCount} tools** / **${report.temporalWebMcp.averageSerializedDefinitionBytes.toLocaleString()} bytes on average**, reducing active tool count by **${report.temporalWebMcp.averageToolCountReductionPct}%** and serialized definition bytes by **${report.temporalWebMcp.averageDefinitionByteReductionPct}%** for this tool set.`,
  '',
  '| Phase | Active tools | Definition bytes |',
  '|---|---:|---:|',
  ...temporal.map(x => `| ${x.phase} | ${x.toolCount} | ${x.serializedDefinitionBytes.toLocaleString()} |`),
  '',
  '> These are local deterministic engine and serialized-schema measurements. They are not claims about universal model success rate, tokenization, or browser-agent performance.',
  ''
];
await writeFile(new URL('../docs/BENCHMARKS.md', import.meta.url), `${lines.join('\n')}`);
const evidence = await writeBenchmarkEvidence({
  suite: report.suite,
  suiteVersion: report.suiteVersion,
  metrics: report,
  failures: []
});
console.log(JSON.stringify(report, null, 2));
console.log(`benchmark evidence: ${evidence.dir}`);
