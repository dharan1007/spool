import { createHash } from 'node:crypto';

// A count and an exact row-by-row comparison must observe the same target
// snapshot. This fixture is intentionally bounded: it verifies the kill
// scenario, not a full database of arbitrary size.
export async function verifyRecoveredTargetContent({ client, table, rowCount, expectedRow, batchSize = 1000 } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('PostgreSQL client is required');
  if (typeof table !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new TypeError('Unsafe verification table identifier');
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 20_000) throw new TypeError('Recovery proof rowCount must be 1..20000');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError('Recovery proof batchSize must be 1..1000');
  if (typeof expectedRow !== 'function') throw new TypeError('Independent expectedRow generator is required');

  const relation = `public."${table}"`;
  const digest = createHash('sha256');
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const countResult = await client.query(`SELECT count(*)::int AS n FROM ${relation}`);
    if (Number(countResult.rows?.[0]?.n) !== rowCount) throw new Error('Target row count differs from the generated source');
    let lastId = 0;
    while (lastId < rowCount) {
      const chunk = await client.query(`SELECT id, payload FROM ${relation} WHERE id > $1 ORDER BY id ASC LIMIT $2`, [lastId, batchSize]);
      if (!Array.isArray(chunk.rows) || chunk.rows.length === 0 || chunk.rows.length > batchSize) {
        throw new Error('Target row stream is missing or overlong');
      }
      for (const row of chunk.rows) {
        const id = lastId + 1;
        const expected = expectedRow(id);
        if (row.id !== id || !expected || expected.id !== id || row.payload !== expected.payload) {
          throw new Error(`Target content mismatch at source ordinal ${id}`);
        }
        digest.update(JSON.stringify([id, row.payload])).update('\n');
        lastId = id;
        if (lastId > rowCount) throw new Error('Target row stream has surplus rows');
      }
    }
    const extra = await client.query(`SELECT id FROM ${relation} WHERE id > $1 LIMIT 1`, [lastId]);
    if (!Array.isArray(extra.rows) || extra.rows.length !== 0) throw new Error('Target has unexpected rows after expected range');
    await client.query('COMMIT');
    return Object.freeze({ status: 'CONTENT_VERIFIED', verifiedRows: rowCount, observedContentSha256: `sha256:${digest.digest('hex')}`, isolation: 'REPEATABLE READ' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original failure wins */ }
    throw error;
  }
}
