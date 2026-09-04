import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationEngine } from '../src/core/migration.js';

const mappingV1 = [
  { target: 'id', expr: { op: 'field', name: 'id' } },
  { target: 'value', expr: { op: 'cast_number', value: { op: 'field', name: 'value' } } }
];
const mappingV2 = [
  { target: 'id', expr: { op: 'field', name: 'id' } },
  { target: 'value', expr: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'value' } }, right: { op: 'literal', value: 10 } } }
];

test('engine groups row violations with bounded samples', () => {
  const rows = [{ id: 'a', value: '1' }, { id: 'b', value: 'x' }, { id: 'c', value: 'bad' }];
  const engine = new MigrationEngine({ sampleLimit: 1 });
  const result = engine.run(rows, mappingV1, 1);
  assert.equal(result.validRows, 1);
  assert.equal(result.invalidRows, 2);
  assert.equal(result.violations[0].count, 2);
  assert.equal(result.violations[0].samples.length, 1);
});

test('revision replay makes completed output equivalent to clean run of newest mapping', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), value: String(i + 1) }));
  const engine = new MigrationEngine({ chunkSize: 5 });
  const firstHalf = engine.run(rows.slice(0, 10), mappingV1, 1);
  const replayed = engine.replayAndContinue({ allRows: rows, prior: firstHalf, mapping: mappingV2, revision: 2 });
  const clean = engine.run(rows, mappingV2, 2);
  assert.deepEqual(replayed.output, clean.output);
  assert.equal(replayed.outputRevision, 2);
  assert.equal(new Set(replayed.rowRevisions).size, 1);
});

test('engine enforces target schema types instead of exporting structurally invalid rows', () => {
  const rows = [{ id: 'a', value: 'not-a-number' }, { id: 'b', value: '2' }];
  const looseMapping = [
    { target: 'id', expr: { op: 'field', name: 'id' } },
    { target: 'value', expr: { op: 'field', name: 'value' } }
  ];
  const targetSchema = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'value', type: 'number', nullable: false }
  ];
  const engine = new MigrationEngine();
  const result = engine.run(rows, looseMapping, 1, targetSchema);
  assert.equal(result.validRows, 0);
  assert.equal(result.invalidRows, 2);
  assert.equal(result.violations[0].code, 'TYPE_MISMATCH');
});
