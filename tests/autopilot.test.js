import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutopilot } from '../src/core/autopilot.js';

const sourceSchema = [
  { name: 'Customer ID', type: 'string', nullable: false },
  { name: 'monthly_fee', type: 'string', nullable: false },
  { name: 'joined', type: 'string', nullable: false },
  { name: 'is_active', type: 'string', nullable: false }
];

const rows = [
  { 'Customer ID': ' A-1 ', monthly_fee: '19.99', joined: '2026-01-02', is_active: 'true' },
  { 'Customer ID': ' A-2 ', monthly_fee: '29.99', joined: '2026-02-03', is_active: 'false' },
  { 'Customer ID': ' A-3 ', monthly_fee: 'bad', joined: 'bad-date', is_active: 'true' },
  ...Array.from({ length: 97 }, (_, i) => ({
    'Customer ID': ` A-${i + 4} `,
    monthly_fee: `${30 + i}.50`,
    joined: `2026-03-${String((i % 27) + 1).padStart(2, '0')}`,
    is_active: i % 2 ? 'true' : 'false'
  }))
];

test('database-ready planner normalizes names and promotes mostly parseable typed fields with evidence', () => {
  const plan = planAutopilot({ sourceSchema, rows, outcome: 'database_ready' });
  assert.equal(plan.needsAttention, false);
  assert.deepEqual(plan.targetSchema.map(field => field.name), ['customer_id', 'monthly_fee', 'joined', 'is_active']);
  assert.equal(plan.targetSchema.find(field => field.name === 'monthly_fee').type, 'number');
  assert.equal(plan.targetSchema.find(field => field.name === 'joined').type, 'date');
  assert.equal(plan.targetSchema.find(field => field.name === 'is_active').type, 'boolean');
  const feeEvidence = plan.evidence.find(item => item.sourceField === 'monthly_fee');
  assert.ok(feeEvidence.confidence >= 0.95);
  assert.equal(feeEvidence.decision, 'automatic');
  assert.ok(feeEvidence.successCount >= 99);
  assert.equal(plan.mapping.find(entry => entry.target === 'customer_id').expr.op, 'trim');
  assert.equal(plan.mapping.find(entry => entry.target === 'monthly_fee').expr.op, 'cast_number');
});

test('planner fails closed when normalized target names collide', () => {
  const plan = planAutopilot({
    sourceSchema: [
      { name: 'Customer ID', type: 'string', nullable: false },
      { name: 'customer-id', type: 'string', nullable: false }
    ],
    rows: [{ 'Customer ID': 'a', 'customer-id': 'b' }],
    outcome: 'database_ready'
  });
  assert.equal(plan.needsAttention, true);
  assert.equal(plan.ambiguities[0].code, 'TARGET_NAME_COLLISION');
  assert.deepEqual(plan.ambiguities[0].sourceFields.sort(), ['Customer ID', 'customer-id']);
  assert.equal(plan.targetSchema.length, 0);
  assert.equal(plan.mapping.length, 0);
});

test('clean-and-standardize keeps semantic string fields while trimming values', () => {
  const plan = planAutopilot({
    sourceSchema: [{ name: 'Full Name', type: 'string', nullable: false }],
    rows: [{ 'Full Name': ' Ada Lovelace ' }, { 'Full Name': ' Grace Hopper ' }],
    outcome: 'clean_standardize'
  });
  assert.equal(plan.needsAttention, false);
  assert.equal(plan.targetSchema[0].name, 'full_name');
  assert.equal(plan.targetSchema[0].type, 'string');
  assert.equal(plan.mapping[0].expr.op, 'trim');
});
