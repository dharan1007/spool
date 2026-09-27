import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecoveredTargetContent } from '../scripts/qualify/recovery-content.js';

const expectedRow = id => ({ id, payload: 'payload' + id });
function client(rows) {
  const seen = [];
  return { seen, async query(sql, args = []) {
    seen.push(sql);
    if (sql.startsWith('SELECT count(')) return { rows: [{ n: rows.length }] };
    if (sql.includes('ORDER BY')) return { rows: rows.filter(r => r.id > args[0]).slice(0, args[1]) };
    if (sql.startsWith('SELECT id FROM')) return { rows: rows.filter(r => r.id > args[0]).slice(0, 1) };
    return { rows: [] };
  } };
}
const valid = [1, 2, 3].map(expectedRow);
test('exact bounded target verification uses one repeatable-read transaction', async () => {
  const c = client(valid);
  const proof = await verifyRecoveredTargetContent({ client: c, table: 'crash_target', rowCount: 3, expectedRow, batchSize: 2 });
  assert.equal(proof.status, 'CONTENT_VERIFIED');
  assert.equal(proof.verifiedRows, 3);
  assert.match(proof.observedContentSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(c.seen[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(c.seen.at(-1), 'COMMIT');
});
test('corrupt content with correct count refuses verification and rolls back', async () => {
  const c = client([{ ...valid[0], payload: 'changed' }, ...valid.slice(1)]);
  await assert.rejects(verifyRecoveredTargetContent({ client: c, table: 'crash_target', rowCount: 3, expectedRow }), /mismatch/);
  assert.equal(c.seen.at(-1), 'ROLLBACK');
});
test('missing or duplicate rows refuse exact verification', async () => {
  for (const rows of [valid.slice(1), [valid[0], valid[0], valid[2]]]) {
    const c = client(rows);
    await assert.rejects(verifyRecoveredTargetContent({ client: c, table: 'crash_target', rowCount: 3, expectedRow }), /count differs|mismatch/);
    assert.equal(c.seen.at(-1), 'ROLLBACK');
  }
});
test('injected relation and unbounded proof reject without querying', async () => {
  for (const opts of [{ table: 'x;DROP TABLE' }, { table: 'safe', rowCount: 1000000 }]) {
    const c = client(valid);
    await assert.rejects(verifyRecoveredTargetContent({ client: c, table: 'crash_target', rowCount: 3, expectedRow, ...opts }), /Unsafe|1\.\.20000/);
    assert.equal(c.seen.length, 0);
  }
});
