import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell } from '../src/core/csv.js';
import { evaluateExpr } from '../src/core/transforms.js';

const field = name => ({ op: 'field', name });
const castNumber = name => ({ op: 'cast_number', value: field(name) });
const parseDate = name => ({ op: 'parse_date', value: field(name) });

function spoolCode(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code;
  }
  return null;
}

test('locale-number corpus normalizes only unambiguous grouped formats', () => {
  assert.equal(evaluateExpr(castNumber('amount'), { amount: '$1,299.00' }), 1299);
  assert.equal(evaluateExpr(castNumber('amount'), { amount: '1.299,00 €' }), 1299);
  assert.equal(evaluateExpr(castNumber('amount'), { amount: '1299.50' }), 1299.5);
  assert.equal(spoolCode(() => evaluateExpr(castNumber('amount'), { amount: '1,299' })), 'AMBIGUOUS_NUMBER_FORMAT');
  assert.equal(spoolCode(() => evaluateExpr(castNumber('amount'), { amount: '1.299' })), 'AMBIGUOUS_NUMBER_FORMAT');
});

test('date corpus accepts explicit ISO and English textual dates but rejects numeric ambiguity', () => {
  assert.equal(evaluateExpr(parseDate('date'), { date: '2026-04-03' }), '2026-04-03T00:00:00.000Z');
  assert.equal(evaluateExpr(parseDate('date'), { date: '3 April 2026' }), '2026-04-03T00:00:00.000Z');
  assert.equal(evaluateExpr(parseDate('date'), { date: 'April 3, 2026' }), '2026-04-03T00:00:00.000Z');
  assert.equal(spoolCode(() => evaluateExpr(parseDate('date'), { date: '03/04/2026' })), 'AMBIGUOUS_DATE_FORMAT');
  assert.equal(spoolCode(() => evaluateExpr(parseDate('date'), { date: '04/03/2026' })), 'AMBIGUOUS_DATE_FORMAT');
  assert.equal(spoolCode(() => evaluateExpr(parseDate('date'), { date: '2026-02-30' })), 'INVALID_DATE');
});

test('CSV formula corpus neutralizes dangerous text without corrupting ordinary signed numbers', () => {
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('   =1+1'), "'   =1+1");
  assert.equal(escapeCsvCell('+cmd'), "'+cmd");
  assert.equal(escapeCsvCell('-42'), '-42');
  assert.equal(escapeCsvCell('+42.5'), '+42.5');
  assert.equal(escapeCsvCell('@alerts.example.com'), "'@alerts.example.com");
  assert.equal(escapeCsvCell('=SUM(A1,B1)'), '"\'=SUM(A1,B1)"');
});
