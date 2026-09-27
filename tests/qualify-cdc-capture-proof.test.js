import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCdcCapture, compareCaptureLsn } from '../scripts/qualify/postgres/cdc-capture-proof.js';

const event = (tag, lsn, extra = {}) => ({ tag, lsn, ...extra });
const tx = (start, row, commit, end) => [
  event('begin', start),
  event('insert', row),
  event('commit', commit, { commitEndLsn: end })
];

test('concurrent long transaction with old row LSN is not a false replay', () => {
  const proof = auditCdcCapture(tx('0/10','0/12','0/31','0/33'), { priorCheckpointLsn: '0/30' });
  assert.deepEqual(proof, { checkpointLsn: '0/33', commits: 1, rowEvents: 1 });
});

test('cursor records end of complete commit, not earlier row or record start LSN', () => {
  const proof = auditCdcCapture(tx('0/60','0/61','0/64','0/66'));
  assert.equal(proof.checkpointLsn, '0/66');
});

test('cross-window commit regression is rejected against prior durable end cursor', () => {
  assert.throws(() => auditCdcCapture(tx('0/10','0/11','0/1F','0/21'), {
    priorCheckpointLsn: '0/20'
  }), { code: 'CDC_RESTART_REPLAY' });
});

test('commit end cannot precede its own WAL record', () => {
  assert.throws(() => auditCdcCapture(tx('0/10','0/11','0/21','0/20')), {
    code: 'CDC_CAPTURE_INVALID'
  });
});

test('within-transaction row WAL record order remains monotonic', () => {
  assert.throws(() => auditCdcCapture([
    event('begin','0/10'), event('insert','0/13'), event('update','0/12'),
    event('commit','0/20')
  ]), { code: 'CDC_STREAM_ORDER_VIOLATION' });
});

test('row mutation outside begin/commit is never accepted', () => {
  assert.throws(() => auditCdcCapture([event('delete','0/10')]), {
    code: 'CDC_CAPTURE_INCOMPLETE'
  });
});

test('truncated open transaction is not a successful capture', () => {
  assert.throws(() => auditCdcCapture([
    event('begin','0/10'), event('insert','0/11')
  ]), { code: 'CDC_CAPTURE_INCOMPLETE' });
});

test('nested begin, orphan commit, and no-commit capture fail closed', () => {
  assert.throws(() => auditCdcCapture([
    event('begin','0/10'), event('begin','0/11')
  ]), { code: 'CDC_CAPTURE_INCOMPLETE' });
  assert.throws(() => auditCdcCapture([event('commit','0/21')]), {
    code: 'CDC_CAPTURE_INCOMPLETE'
  });
  assert.throws(() => auditCdcCapture([], { priorCheckpointLsn: '0/20' }), {
    code: 'CDC_CAPTURE_INCOMPLETE'
  });
});

test('transient relation metadata does not break complete transaction auditing', () => {
  const proof = auditCdcCapture([
    event('relation','0/10'), event('begin','0/11'),
    event('relation','0/12'), event('insert','0/13'),
    event('commit','0/14')
  ]);
  assert.equal(proof.commits,1);
  assert.equal(proof.rowEvents,1);
});

test('64-bit LSN comparisons do not truncate to JavaScript floating precision', () => {
  assert.equal(compareCaptureLsn('FFFFFFFF/FFFFFFFF','FFFFFFFF/FFFFFFFE'),1);
  assert.equal(compareCaptureLsn('00000001/0','0/FFFFFFFF'),1);
  assert.equal(compareCaptureLsn('ABCDEF00/00000002','ABCDEF00/00000002'),0);
  assert.throws(()=>compareCaptureLsn('0/not-a-lsn','0/1'), { code:'INVALID_POSTGRES_LSN' });
});
