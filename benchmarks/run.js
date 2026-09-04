import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createDemoCsv, demoMapping, demoTargetSchema } from '../src/core/demo.js';
import { parseCsv } from '../src/core/csv.js';
import { MigrationEngine } from '../src/core/migration.js';
import { PHASES } from '../src/core/state-machine.js';
import { toolNamesForPhase, toolDefinitionForName } from '../src/webmcp/registry.js';

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

const report = {
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
  caveat: 'These are local deterministic engine and serialized-schema measurements, not universal LLM success-rate claims.'
};

await writeFile(new URL('./latest.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
const md = `# SPOOL Benchmarks\n\nGenerated: ${report.generatedAt}\n\n## Deterministic migration engine\n\n| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |\n|---:|---:|---:|---:|---:|---:|\n${migration.map(x => `| ${x.rows.toLocaleString()} | ${x.parseMs} ms | ${x.transformMs} ms | ${x.transformRowsPerSecond.toLocaleString()} | ${x.validRows.toLocaleString()} | ${x.invalidRows.toLocaleString()} |`).join('\n')}\n\n## Temporal WebMCP surface\n\nA permanent surface across the measured phases contains **${allNames.length} tools** / **${baselineBytes.toLocaleString()} serialized definition bytes**. SPOOL exposes **${report.temporalWebMcp.averageActiveToolCount} tools** / **${report.temporalWebMcp.averageSerializedDefinitionBytes.toLocaleString()} bytes on average**, reducing active tool count by **${report.temporalWebMcp.averageToolCountReductionPct}%** and serialized definition bytes by **${report.temporalWebMcp.averageDefinitionByteReductionPct}%** for this tool set.\n\n| Phase | Active tools | Definition bytes |\n|---|---:|---:|\n${temporal.map(x => `| ${x.phase} | ${x.toolCount} | ${x.serializedDefinitionBytes.toLocaleString()} |`).join('\n')}\n\n> These are local deterministic engine and serialized-schema measurements. They are not claims about universal model success rate, tokenization, or browser-agent performance.\n`;
await writeFile(new URL('../docs/BENCHMARKS.md', import.meta.url), md);
console.log(JSON.stringify(report, null, 2));
