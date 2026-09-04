import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerMessageGate, processChunk } from '../src/runtime/worker-protocol.js';

const mapping = [{ target: 'n', expr: { op: 'cast_number', value: { op: 'field', name: 'n' } } }];

test('worker gate rejects wrong job, stale sequence and wrong revision', () => {
  const gate = new WorkerMessageGate({ jobId: 'j1', revision: 3 });
  assert.equal(gate.accept({ jobId: 'j1', revision: 3, seq: 1 }), true);
  assert.equal(gate.accept({ jobId: 'j1', revision: 3, seq: 1 }), false);
  assert.equal(gate.accept({ jobId: 'j2', revision: 3, seq: 2 }), false);
  assert.equal(gate.accept({ jobId: 'j1', revision: 2, seq: 2 }), false);
  assert.equal(gate.accept({ jobId: 'j1', revision: 3, seq: 2 }), true);
});

test('processChunk returns bounded violations and preserves absolute row index', () => {
  const result = processChunk({ rows: [{ n: '1' }, { n: 'x' }], mapping, revision: 1, startIndex: 40, sampleLimit: 2 });
  assert.equal(result.processedRows, 2);
  assert.equal(result.outputChunk.length, 1);
  assert.equal(result.violations[0].samples[0].rowIndex, 41);
});
