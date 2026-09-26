import { fail } from '../../core/errors.js';

// A driver acknowledgment, affected-row count, and RETURNING evidence must
// agree exactly. PostgreSQL BEFORE triggers and DO NOTHING may silently
// suppress effects; a successful SQL statement alone is not an exact commit.
export function assertExactPostgresAffectedRows(result, expected, operation = 'insert') {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    fail('INVALID_BATCH_ROWS', 'Exact mutation proof requires a positive expected row count');
  }
  if (result?.rowCount !== expected) {
    fail('TARGET_COMMIT_UNPROVEN', `PostgreSQL ${operation} affected fewer or more rows than approved`, {
      operation, expected, actual: result?.rowCount ?? null
    });
  }
  return expected;
}

export function countExactPostgresUpserts(result, expected) {
  assertExactPostgresAffectedRows(result, expected, 'upsert');
  if (!Array.isArray(result.rows) || result.rows.length !== expected) {
    fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL upsert RETURNING evidence does not match approved cardinality', {
      expected, returned: Array.isArray(result.rows) ? result.rows.length : null
    });
  }
  let inserted = 0;
  let updated = 0;
  for (const row of result.rows) {
    if (row?.inserted === true) inserted += 1;
    else if (row?.inserted === false) updated += 1;
    else fail('TARGET_COMMIT_UNPROVEN', 'PostgreSQL upsert RETURNING classification is missing or ambiguous');
  }
  return Object.freeze({ inserted, updated });
}
