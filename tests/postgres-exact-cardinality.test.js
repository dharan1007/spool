import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExactPostgresAffectedRows,
  countExactPostgresUpserts
} from '../src/connectors/postgres/exact-cardinality.js';

const unproven = fn => assert.throws(fn, e => e.code === 'TARGET_COMMIT_UNPROVEN');

test('insert requires exact PostgreSQL affected-row count, not SQL success alone', () => {
  assert.equal(assertExactPostgresAffectedRows({ rowCount: 3 }, 3), 3);
  unproven(() => assertExactPostgresAffectedRows({ rowCount: 2 }, 3));
  unproven(() => assertExactPostgresAffectedRows({ rowCount: 4 }, 3));
  unproven(() => assertExactPostgresAffectedRows({ rowCount: null }, 3));
  unproven(() => assertExactPostgresAffectedRows(undefined, 3));
  assert.throws(() => assertExactPostgresAffectedRows({ rowCount: 0 }, 0), e => e.code === 'INVALID_BATCH_ROWS');
});

test('upsert requires per-piece row count and RETURNING array consistency', () => {
  assert.deepEqual(countExactPostgresUpserts({ rowCount: 3, rows: [
    { inserted: true }, { inserted: false }, { inserted: true }
  ] }, 3), { inserted: 2, updated: 1 });
  unproven(() => countExactPostgresUpserts({ rowCount: 1, rows: [{ inserted: true }] }, 2));
  unproven(() => countExactPostgresUpserts({ rowCount: 2, rows: [{ inserted: true }] }, 2));
  unproven(() => countExactPostgresUpserts({ rowCount: 2, rows: [] }, 2));
  unproven(() => countExactPostgresUpserts({ rowCount: 2 }, 2));
  unproven(() => countExactPostgresUpserts({ rowCount: 2, rows: [
    { inserted: true }, { inserted: 'false' }
  ] }, 2));
});

test('a trigger-suppressed row cannot produce a complete exact upsert proof', () => {
  const returned = { rowCount: 1, rows: [{ inserted: true }] };
  unproven(() => countExactPostgresUpserts(returned, 2));
});

test('a DO NOTHING conflict cannot silently count as an applied source mutation', () => {
  const returned = { rowCount: 0, rows: [] };
  unproven(() => countExactPostgresUpserts(returned, 1));
});
