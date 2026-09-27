import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = readFileSync(new URL('../scripts/qualify/postgres/cdc-production-lifecycle.js', import.meta.url), 'utf8');
const start = file.indexOf('  async function writerTask(');
const end = file.indexOf('\n  try {\n    const setup =', start);
assert.ok(start >= 0 && end > start, 'executable qualification writer must exist');
const writerBody = file.slice(start, end);

async function executeOneWriterOperation({ worker = 0, failSql = null } = {}) {
  const queries = [];
  let closed = false;
  let ticks = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (failSql && sql.includes(failSql)) throw new Error('injected source transaction fault');
      return { rowCount: 1 };
    },
    async end() { closed = true; }
  };
  const fakeDate = { now() { return ticks++ === 0 ? 0 : 2; } };
  const createWriter = new Function('admin', 'rowCount', 'sourceTable', 'Date', 'setTimeout',
    writerBody + '\nreturn writerTask;'
  );
  const writer = createWriter(async () => client, 100, 'qualification_source', fakeDate,
    () => Promise.resolve());
  let result;
  let error;
  try { result = await writer(worker, 1); } catch (caught) { error = caught; }
  return { queries, closed, result, error };
}

test('each seeded insert is committed as one actual PostgreSQL transaction', async () => {
  const observed = await executeOneWriterOperation();
  assert.deepEqual(observed.queries.map(query => query.split(' ')[0]),
    ['BEGIN', 'INSERT', 'COMMIT']);
  assert.deepEqual({ ops: observed.result.ops, transactions: observed.result.transactions },
    { ops: 1, transactions: 1 });
  assert.equal(observed.closed, true);
});
test('CDC delete-plus-reinsert is one atomic source transaction', async () => {
  const observed = await executeOneWriterOperation({ worker: 7 }); // (7*13) % 100 = 91
  assert.deepEqual(observed.queries.map(query => query.split(' ')[0]),
    ['BEGIN', 'DELETE', 'INSERT', 'COMMIT']);
  assert.equal(observed.result.transactions, 1);
  assert.equal(observed.closed, true);
});
test('failure after delete rolls back both effects, never counts a committed transaction', async () => {
  const observed = await executeOneWriterOperation({ worker: 7, failSql: 'INSERT' });
  assert.deepEqual(observed.queries.map(query => query.split(' ')[0]),
    ['BEGIN', 'DELETE', 'INSERT', 'ROLLBACK']);
  assert.match(observed.error?.message ?? '', /injected source transaction fault/);
  assert.equal(observed.closed, true);
});
test('qualification reports actual source commits, not loop-count approximations', () => {
  assert.ok(file.includes('committedSourceTransactions !== totalOps'));
  assert.ok(file.includes('event: \'writers_quiesced\', totalOps, committedSourceTransactions'));
  assert.ok(!file.includes('transactions += 1;\n          await new Promise'));
});
