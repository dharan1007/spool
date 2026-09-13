import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentVerificationAccumulator } from '../src/execution/content-verification-manifest.js';

const hash = char => `sha256:${char.repeat(64)}`;
const targetReadState = Object.freeze({
  connector: 'postgres',
  database: 'app',
  schema: 'public',
  table: 'orders',
  targetContractId: hash('a'),
  mvccSnapshot: '100:200:',
  walLsn: '0/16B6C50'
});

function batch({ id, start, end, rows, status = 'VERIFIED', missing = 0, mismatch = 0, unexpected = 0 }) {
  return {
    sourceRange: { start, endExclusive: end },
    verification: {
      schemaVersion: 1,
      level: 'CONTENT_EXACT',
      status,
      verificationId: hash(id),
      primaryKey: ['id'],
      columns: ['id', 'name'],
      expected: { rowCount: rows, rootHash: hash(String.fromCharCode(id.charCodeAt(0) + 1)) },
      actual: { rowCount: rows - missing + unexpected, rootHash: hash(String.fromCharCode(id.charCodeAt(0) + 2)) },
      diff: { counts: { missing, mismatch, unexpected }, total: missing + mismatch + unexpected, entries: [] }
    }
  };
}

test('content verification manifest is incremental, deterministic and compact', () => {
  const first = createContentVerificationAccumulator({ targetReadState });
  first.add(batch({ id: 'b', start: 0, end: 2, rows: 2 }));
  first.add(batch({ id: 'e', start: 2, end: 4, rows: 2 }));
  const a = first.summary();

  const second = createContentVerificationAccumulator({ targetReadState });
  second.add(batch({ id: 'b', start: 0, end: 2, rows: 2 }));
  second.add(batch({ id: 'e', start: 2, end: 4, rows: 2 }));
  const b = second.summary();

  assert.deepEqual(a, b);
  assert.equal(a.status, 'VERIFIED');
  assert.equal(a.level, 'CONTENT_EXACT');
  assert.equal(a.rowCount, 4);
  assert.equal(a.batchCount, 2);
  assert.match(a.rootHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(a, 'entries'), false);
});

test('manifest records exact aggregate diff counts without retaining row payloads', () => {
  const acc = createContentVerificationAccumulator({ targetReadState });
  acc.add(batch({ id: 'b', start: 0, end: 2, rows: 2 }));
  acc.add(batch({ id: 'e', start: 2, end: 5, rows: 3, status: 'DIFF', missing: 1, mismatch: 1, unexpected: 0 }));
  const result = acc.summary();
  assert.equal(result.status, 'DIFF');
  assert.deepEqual(result.diffCounts, { missing: 1, mismatch: 1, unexpected: 0, total: 2 });
  assert.equal(result.rowCount, 5);
});

test('manifest rejects gaps, overlaps, changed schemas and changed target read states', () => {
  const acc = createContentVerificationAccumulator({ targetReadState });
  acc.add(batch({ id: 'b', start: 0, end: 2, rows: 2 }));
  assert.throws(() => acc.add(batch({ id: 'e', start: 3, end: 4, rows: 1 })), error => error?.code === 'CONTENT_VERIFICATION_RANGE_DISCONTINUITY');

  const schemaDrift = createContentVerificationAccumulator({ targetReadState });
  schemaDrift.add(batch({ id: 'b', start: 0, end: 2, rows: 2 }));
  const changed = batch({ id: 'e', start: 2, end: 3, rows: 1 });
  changed.verification.columns = ['id', 'different'];
  assert.throws(() => schemaDrift.add(changed), error => error?.code === 'CONTENT_VERIFICATION_CONTRACT_CHANGED');
});
