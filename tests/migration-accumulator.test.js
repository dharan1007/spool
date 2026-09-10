import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationEngine } from '../src/core/migration.js';

const mapping = [
  { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
  { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
];
const schema = [
  { name: 'id', type: 'number', nullable: false },
  { name: 'name', type: 'string', nullable: false }
];
const rows = [
  { id: '1', name: ' Ada ' },
  { id: 'bad', name: 'Lin' },
  { id: '3', name: '' },
  { id: '4', name: 'Grace' }
];

test('bounded accumulator matches run counts and violation ordering without retaining successful rows', () => {
  const engine = new MigrationEngine({ sampleLimit: 2 });
  const expected = engine.run(rows, mapping, 7, schema);
  const acc = engine.createAccumulator(mapping, 7, schema);
  const accepted = [];
  rows.forEach((row, i) => {
    const result = acc.process(row, i + 100);
    if (result.ok) accepted.push(result.row);
  });
  const summary = acc.summary();
  assert.equal(summary.processedRows, expected.processedRows);
  assert.equal(summary.validRows, expected.validRows);
  assert.equal(summary.invalidRows, expected.invalidRows);
  assert.deepEqual(summary.violations.map(({ code, count, message }) => ({ code, count, message })), expected.violations.map(({ code, count, message }) => ({ code, count, message })));
  assert.deepEqual(accepted, expected.output);
  assert.equal(Object.hasOwn(summary, 'output'), false);
  assert.equal(Object.hasOwn(summary, 'rowRevisions'), false);
  assert.ok(summary.violations.flatMap(v => v.samples).every(sample => sample.rowIndex >= 100));
});

test('bounded accumulator compiles mapping once and accepts explicit source row indices', () => {
  const acc = new MigrationEngine({ sampleLimit: 1 }).createAccumulator(mapping, 2, schema);
  assert.equal(acc.process(rows[0], 41).ok, true);
  assert.equal(acc.process(rows[1], 42).ok, false);
  assert.equal(acc.process(rows[2], 43).ok, false);
  const summary = acc.summary();
  assert.equal(summary.processedRows, 3);
  assert.equal(summary.validRows, 1);
  assert.equal(summary.invalidRows, 2);
  assert.ok(summary.violations.every(v => v.samples.length <= 1));
  assert.ok(summary.violations.flatMap(v => v.samples).every(sample => [42, 43].includes(sample.rowIndex)));
});
