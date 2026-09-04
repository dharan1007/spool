import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoCsv, demoTargetSchema, demoMapping, mirrorPlanFromSourceSchema } from '../src/core/demo.js';
import { parseCsv } from '../src/core/csv.js';
import { MigrationEngine } from '../src/core/migration.js';

test('demo generator creates requested cardinality with realistic dirty rows', () => {
  const parsed = parseCsv(createDemoCsv(2500));
  assert.equal(parsed.rows.length, 2500);
  assert.ok(parsed.rows.some(row => row.monthly_fee === 'unknown'));
  assert.ok(parsed.rows.some(row => row.joined === 'bad-date'));
});

test('demo mapping produces typed target rows and clusters dirty-data violations', () => {
  const rows = parseCsv(createDemoCsv(2500)).rows;
  const result = new MigrationEngine().run(rows, demoMapping(), 1, demoTargetSchema());
  assert.ok(result.validRows > 2400);
  assert.ok(result.invalidRows > 0);
  assert.ok(result.violations.some(v => ['INVALID_NUMBER', 'INVALID_DATE'].includes(v.code)));
  assert.equal(typeof result.output[0].monthly_fee_cents, 'number');
});

test('mirror plan inserts required casts for inferred non-string source types', () => {
  const source = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
    { name: 'joined', type: 'date', nullable: false },
    { name: 'name', type: 'string', nullable: true }
  ];
  const plan = mirrorPlanFromSourceSchema(source);
  assert.deepEqual(plan.targetSchema.map(f => f.type), ['integer', 'boolean', 'date', 'string']);
  assert.deepEqual(plan.mapping.map(m => m.expr.op), ['cast_number', 'cast_boolean', 'parse_date', 'trim']);
});

import { starterMappingForTarget } from '../src/core/demo.js';

test('starter mapping matches exact source names and leaves renamed targets explicitly unresolved', () => {
  const sourceSchema = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'full_name', type: 'string', nullable: false },
    { name: 'joined', type: 'date', nullable: true }
  ];
  const targetSchema = [
    { name: 'id', type: 'number', nullable: false },
    { name: 'display_name', type: 'string', nullable: false },
    { name: 'joined', type: 'date', nullable: true }
  ];

  const mapping = starterMappingForTarget(targetSchema, sourceSchema);

  assert.deepEqual(mapping[0], { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } });
  assert.deepEqual(mapping[1], { target: 'display_name', expr: { op: 'literal', value: null } });
  assert.deepEqual(mapping[2], { target: 'joined', expr: { op: 'parse_date', value: { op: 'field', name: 'joined' } } });
});
