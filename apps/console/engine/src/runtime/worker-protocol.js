import { compileMapping } from '../core/transforms.js';
import { validateOutputRow } from '../core/schema.js';

export class WorkerMessageGate {
  constructor({ jobId, revision }) {
    this.jobId = jobId;
    this.revision = revision;
    this.lastSeq = 0;
  }
  accept(message) {
    if (!message || message.jobId !== this.jobId || message.revision !== this.revision) return false;
    if (!Number.isInteger(message.seq) || message.seq <= this.lastSeq) return false;
    this.lastSeq = message.seq;
    return true;
  }
}

export function processChunk({ rows, mapping, revision, targetSchema = null, startIndex = 0, sampleLimit = 10 }) {
  const compiled = compileMapping(mapping);
  const outputChunk = [];
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    try {
      const transformed = compiled.mapRow(rows[i]);
      validateOutputRow(transformed, targetSchema);
      outputChunk.push(transformed);
    } catch (error) {
      const code = error?.code || String(error?.message || 'TRANSFORM_ERROR').split(':')[0] || 'TRANSFORM_ERROR';
      let group = groups.get(code);
      if (!group) {
        group = { code, count: 0, message: error?.message || String(error), samples: [] };
        groups.set(code, group);
      }
      group.count++;
      if (group.samples.length < sampleLimit) group.samples.push({ rowIndex: startIndex + i, row: structuredClone(rows[i]) });
    }
  }
  return {
    processedRows: rows.length,
    validRows: outputChunk.length,
    invalidRows: rows.length - outputChunk.length,
    outputChunk,
    violations: [...groups.values()],
    revision
  };
}
