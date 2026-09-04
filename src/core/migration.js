import { compileMapping } from './transforms.js';
import { validateOutputRow } from './schema.js';

function groupViolation(groups, error, rowIndex, row, sampleLimit) {
  const code = error?.code || String(error?.message || 'TRANSFORM_ERROR').split(':')[0] || 'TRANSFORM_ERROR';
  const key = code;
  let group = groups.get(key);
  if (!group) {
    group = { code, count: 0, message: error?.message || String(error), samples: [] };
    groups.set(key, group);
  }
  group.count += 1;
  if (group.samples.length < sampleLimit) group.samples.push({ rowIndex, row: structuredClone(row) });
}

export class MigrationEngine {
  constructor({ chunkSize = 1000, sampleLimit = 10 } = {}) {
    this.chunkSize = chunkSize;
    this.sampleLimit = sampleLimit;
  }

  run(rows, mappingEntries, revision = 1, targetSchema = null) {
    const compiled = compileMapping(mappingEntries);
    const output = [];
    const rowRevisions = [];
    const groups = new Map();
    for (let i = 0; i < rows.length; i++) {
      try {
        const transformed = compiled.mapRow(rows[i]);
        validateOutputRow(transformed, targetSchema);
        output.push(transformed);
        rowRevisions.push(revision);
      } catch (error) {
        groupViolation(groups, error, i, rows[i], this.sampleLimit);
      }
    }
    const invalidRows = [...groups.values()].reduce((sum, group) => sum + group.count, 0);
    return {
      processedRows: rows.length,
      totalRows: rows.length,
      validRows: output.length,
      invalidRows,
      output,
      rowRevisions,
      outputRevision: revision,
      violations: [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    };
  }

  replayAndContinue({ allRows, mapping, revision, targetSchema = null }) {
    // Correctness-first replay: newest revision is applied to the complete source.
    return this.run(allRows, mapping, revision, targetSchema);
  }
}
