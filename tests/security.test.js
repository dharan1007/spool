import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell, toCsv, parseCsv } from '../src/core/csv.js';
import { validateExpr } from '../src/core/transforms.js';

test('CSV export neutralizes spreadsheet formulas', () => {
  for (const value of ['=SUM(A1:A2)', '+cmd', '-2+3', '@IMPORTXML']) {
    assert.match(escapeCsvCell(value), /^'/);
  }
});

test('CSV parser rejects oversized cells', () => {
  assert.throws(() => parseCsv(`a\n${'x'.repeat(1025)}`, { maxCellLength: 1024 }), /CELL_TOO_LARGE/);
});

test('transform IR rejects unknown operators and excessive depth', () => {
  assert.throws(() => validateExpr({ op: 'eval', value: 'alert(1)' }), /UNKNOWN_OPERATOR/);
  let expr = { op: 'field', name: 'x' };
  for (let i = 0; i < 30; i++) expr = { op: 'trim', value: expr };
  assert.throws(() => validateExpr(expr, { maxDepth: 12 }), /EXPR_TOO_DEEP/);
});

test('CSV serializer has stable headers and no prototype keys', () => {
  const csv = toCsv([{ safe: 'x', __proto__: 'bad' }], ['safe']);
  assert.equal(csv, 'safe\r\nx');
});
