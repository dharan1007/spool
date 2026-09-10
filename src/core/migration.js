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

function sortedViolations(groups) {
  return [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export class MigrationEngine {
  constructor({ chunkSize = 1000, sampleLimit = 10 } = {}) {
    this.chunkSize = chunkSize;
    this.sampleLimit = sampleLimit;
  }

  createAccumulator(mappingEntries, revision = 1, targetSchema = null) {
    const compiled = compileMapping(mappingEntries);
    const groups = new Map();
    let processedRows = 0;
    let validRows = 0;

    return Object.freeze({
      process: (row, rowIndex = processedRows) => {
        processedRows += 1;
        try {
          const transformed = compiled.mapRow(row);
          validateOutputRow(transformed, targetSchema);
          validRows += 1;
          return Object.freeze({ ok: true, row: transformed, revision });
        } catch (error) {
          groupViolation(groups, error, rowIndex, row, this.sampleLimit);
          return Object.freeze({ ok: false, code: error?.code ?? 'TRANSFORM_ERROR' });
        }
      },
      summary: () => {
        const violations = sortedViolations(groups);
        const invalidRows = violations.reduce((sum, group) => sum + group.count, 0);
        return {
          processedRows,
          totalRows: processedRows,
          validRows,
          invalidRows,
          outputRevision: revision,
          violations
        };
      }
    });
  }

  run(rows, mappingEntries, revision = 1, targetSchema = null) {
    const accumulator = this.createAccumulator(mappingEntries, revision, targetSchema);
    const output = [];
    const rowRevisions = [];
    for (let i = 0; i < rows.length; i++) {
      const result = accumulator.process(rows[i], i);
      if (result.ok) {
        output.push(result.row);
        rowRevisions.push(revision);
      }
    }
    const summary = accumulator.summary();
    return {
      ...summary,
      output,
      rowRevisions
    };
  }

  replayAndContinue({ allRows, mapping, revision, targetSchema = null }) {
    // Correctness-first replay: newest revision is applied to the complete source.
    return this.run(allRows, mapping, revision, targetSchema);
  }
}
