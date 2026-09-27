import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../scripts/qualify/postgres/cdc-soak.js', import.meta.url), 'utf8');
const start = code.indexOf('  async function writePlan(chunk) {');
const end = code.indexOf('  // Streaming-ordering invariant:', start);
assert.ok(start >= 0 && end > start, 'production CDC qualification writer is present');
const functionBody = code.slice(start, end);

async function exercise(kind, { workers = 1, fault = null, chunk = 0 } = {}) {
  const sessions = [];
  class Client {
    constructor() { this.calls = []; this.closed = false; sessions.push(this); }
    async connect() {}
    async query(sql) {
      this.calls.push(sql);
      if (fault && sql.includes(fault)) throw new Error('injected PostgreSQL failure');
      return { rowCount: 1 };
    }
    async end() { this.closed = true; }
  }
  const fn = new Function(
    'Client', 'pgConfig', 'writers', 'opsPerChunk', 'opMix', 'WRITER_BASE',
    'WRITER_STRIDE', 'MULTI_OFFSET', 'table', 'opEvents', 'sleep', 'writerPaceMs',
    functionBody + '\nreturn writePlan;'
  )(
    Client, { host: '127.0.0.1', port: 5432, database: 'isolated', user: 'test', password: 'fixture' },
    workers, 100, () => kind, 100_000_000, 20_000_000, 10_000_000,
    'q_cdc_test', value => value === 'insert' ? 1 : 2, () => Promise.resolve(), 0
  );
  let result, error;
  try { result = await fn(chunk); } catch (caught) { error = caught; }
  return { result, error, sessions };
}

test('seven-day CDC workload is generated in bounded windows, not preallocated arrays', () => {
  assert.match(code, /const CHUNK_WINDOW_MS = 30_000/);
  assert.match(code, /const opsPerChunk = 100/);
  assert.doesNotMatch(code, /const plans =|plans\[chunk\]/);
  assert.match(code, /const observedSoakMs = Number\(process\.hrtime\.bigint\(\) - soakStart\)/);
  assert.match(code, /CDC_SOAK_UNDER_EXECUTED/);
  const chunks = Math.ceil(7 * 86400 * 1000 / 30000);
  assert.equal(chunks, 20160);
  const maxOpIndex = chunks * 100 - 1;
  const lastId = 100_000_000 + 49 * 20_000_000 + maxOpIndex + 1 + 10_000_000;
  assert.ok(lastId < 2_147_483_647);
});

for (const kind of ['insert', 'update', 'delete', 'multi']) {
  test('real source mutations and counted CDC effects: ' + kind, async () => {
    const { result, error, sessions } = await exercise(kind);
    assert.equal(error, undefined);
    assert.equal(result.operations, 100);
    assert.equal(result.inserted, 100);
    assert.equal(result.attempted, kind === 'insert' ? 100 : 200);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].closed, true);
    const log = sessions[0].calls.map(query => query.split(' ')[0]);
    if (kind === 'insert') assert.deepEqual(log.slice(0, 1), ['INSERT']);
    else assert.deepEqual(log.slice(0, 4), ['BEGIN', 'INSERT', kind === 'delete' ? 'DELETE' : 'UPDATE', 'COMMIT']);
    assert.equal(log.some(sql => sql.includes(';')), false, 'node-postgres parameterized multi-statements forbidden');
  });
}

test('concurrent fault rolls back incomplete transaction and awaits every worker shutdown', async () => {
  const { result, error, sessions } = await exercise('multi', { workers: 2, fault: 'UPDATE' });
  assert.equal(result, undefined);
  assert.match(error?.message ?? '', /injected PostgreSQL failure/);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(client => client.closed));
  assert.ok(sessions.every(client => client.calls.includes('ROLLBACK')));
  assert.ok(sessions.every(client => !client.calls.includes('COMMIT')));
});

test('identifier-space exhaustion fails instead of aliasing another writer or marker', async () => {
  const { result, error, sessions } = await exercise('insert', { chunk: 100000 });
  assert.equal(result, undefined);
  assert.match(error?.message ?? '', /exhausted/);
  assert.ok(sessions.every(client => client.closed));
});

test('a driver exception cannot be silently counted as completed qualification evidence', () => {
  assert.doesNotMatch(functionBody, /catch\s*\{\s*\}/);
  assert.match(functionBody, /if \(insertedRow\.rowCount|if \(added\.rowCount/);
  assert.match(code, /CDC_ACTUAL_EVENT_COUNT_MISMATCH/);
});
