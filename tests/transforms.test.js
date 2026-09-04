import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpr, evaluateExpr, compileMapping } from '../src/core/transforms.js';

test('typed transform IR evaluates nested numeric operation', () => {
  const expr = { op: 'round', value: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'fee' } }, right: { op: 'literal', value: 100 } } };
  validateExpr(expr);
  assert.equal(evaluateExpr(expr, { fee: '19.99' }), 1999);
});

test('enum_map reports unmapped values instead of silently coercing', () => {
  const expr = { op: 'enum_map', value: { op: 'field', name: 'country' }, map: { India: 'IN' } };
  assert.throws(() => evaluateExpr(expr, { country: 'Atlantis' }), /UNMAPPED_ENUM/);
});

test('regex_replace rejects unsafe patterns', () => {
  const expr = { op: 'regex_replace', value: { op: 'field', name: 'x' }, pattern: '(a+)+$', replacement: '' };
  assert.throws(() => validateExpr(expr), /UNSAFE_REGEX/);
});

test('compileMapping validates target uniqueness and returns deterministic mapper', () => {
  const mapping = compileMapping([
    { target: 'id', expr: { op: 'trim', value: { op: 'field', name: 'cust_id' } } },
    { target: 'fee_cents', expr: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'fee' } }, right: { op: 'literal', value: 100 } } }
  ]);
  assert.deepEqual(mapping.mapRow({ cust_id: ' A1 ', fee: '2.5' }), { id: 'A1', fee_cents: 250 });
});
