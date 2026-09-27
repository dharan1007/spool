import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdcFeedbackQueue } from '../src/connectors/postgres/cdc-apply.js';
import { readFileSync } from 'node:fs';

test('queued heartbeat feedback never regresses after a newer committed ACK', async () => {
  const sent = [];
  const feedback = createCdcFeedbackQueue({
    initialLsn: '0/10', acknowledge: async lsn => { sent.push(lsn); return true; }
  });
  assert.deepEqual(await Promise.all([feedback.send('0/30'), feedback.send('0/20')]), ['0/30', '0/30']);
  assert.deepEqual(sent, ['0/30', '0/30']);
  assert.equal(feedback.lastSent(), '0/30');
});

test('heartbeat position is resolved only after the preceding ACK finishes', async () => {
  const sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const feedback = createCdcFeedbackQueue({
    acknowledge: async lsn => { if (lsn === '0/20') await gate; sent.push(lsn); return true; }
  });
  let durable = '0/10';
  const commit = feedback.send('0/20');
  const heartbeat = feedback.send(() => durable);
  durable = '0/30';
  release();
  assert.equal(await commit, '0/20');
  assert.equal(await heartbeat, '0/30');
  assert.deepEqual(sent, ['0/20', '0/30']);
});

test('driver refusal fails the caller and never advances the documented ACK cursor', async () => {
  let refuse = true;
  const feedback = createCdcFeedbackQueue({
    initialLsn: '0/10', acknowledge: async () => !refuse
  });
  await assert.rejects(feedback.send('0/20'), { code: 'CDC_ACK_FAILED' });
  assert.equal(feedback.lastSent(), '0/10');
  refuse = false;
  assert.equal(await feedback.send('0/15'), '0/15');
  assert.equal(feedback.lastSent(), '0/15');
});

test('driver exceptions are not swallowed by queue recovery', async () => {
  let failNext = true;
  const feedback = createCdcFeedbackQueue({
    acknowledge: async () => {
      if (failNext) { failNext = false; throw Object.assign(new Error('socket closed'), {code:'SOCKET_CLOSED'}); }
      return true;
    }
  });
  await assert.rejects(feedback.send('0/11'), {code:'SOCKET_CLOSED'});
  assert.equal(feedback.lastSent(),null);
  assert.equal(await feedback.send('0/12'),'0/12');
});

test('feedback rejects malformed positions and permanently closes when requested', async () => {
  const feedback = createCdcFeedbackQueue({
    acknowledge: async () => true, initialLsn:'0/0'
  });
  await assert.rejects(feedback.send('not-a-position'), {code:'INVALID_CDC_POSITION'});
  feedback.close();
  await assert.rejects(feedback.send('0/10'), {code:'CDC_FEEDBACK_CLOSED'});
  assert.equal(feedback.lastSent(),'0/0');
});

test('keepalive feedback can only reference a durable cursor, not a volatile receive cursor',async () => {
  const sent = [];
  const feedback=createCdcFeedbackQueue({
    initialLsn:'0/10',acknowledge:async lsn=>{sent.push(lsn);return true;}
  });
  const receivedLsn='0/FFFF';
  const lastPersistedLsn='0/20';
  await feedback.send(()=>lastPersistedLsn);
  assert.equal(receivedLsn,'0/FFFF');
  assert.deepEqual(sent,['0/20']);
});


test('real CDC applier sends all transaction and heartbeat feedback through the durable scheduler', () => {
  const source=readFileSync(new URL('../src/connectors/postgres/cdc-apply.js',import.meta.url),'utf8');
  assert.match(source,/const feedback = createCdcFeedbackQueue/);
  assert.match(source,/serverAck\.last \?\? fromLsn \?\? '0\/0'/);
  assert.match(source,/const sentPosition = await feedback\.send/);
  assert.ok(source.includes('auto: false, timeoutSeconds: 0'));
});
