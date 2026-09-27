import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCdcSerialPump } from '../src/connectors/postgres/cdc-serial-pump.js';

const code = readFileSync(new URL('../src/connectors/postgres/cdc.js', import.meta.url), 'utf8');
const begin = code.indexOf('export async function streamPostgresChanges(');
const end = code.indexOf('export function createCdcCheckpointStore(', begin);
assert.ok(begin >= 0 && end > begin, 'real CDC capture implementation is present');
const captureSource = code.slice(begin, end).replace(/^export /gm, '');

function makeCapture(events, { failAcknowledging = null } = {}) {
  let service;
  class FakeReplicationService {
    constructor() {
      this.listeners = new Map(); this.acknowledged = [];
      this.stopped = false; this.destroyed = false; service = this;
    }
    on(name, cb) { this.listeners.set(name, cb); }
    async subscribe() {
      for (const [lsn, kind] of events) this.listeners.get('data')(lsn, { tag: kind });
    }
    async acknowledge(lsn) {
      if (lsn === failAcknowledging) throw Object.assign(new Error('injected ACK failure'), { code: 'ACK_FAILED' });
      this.acknowledged.push(lsn);
    }
    async stop() { this.stopped = true; }
    async destroy() { this.destroyed = true; }
  }
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const capture = new Function(
    'requireDatabaseRef', 'requireSlotName', 'PUBLICATION_NAME', 'LSN',
    'parsePostgresEndpoint', 'LogicalReplicationService', 'PgoutputPlugin',
    'normalizeMessage', 'comparePostgresLsn', 'fail',
    'classifyCdcStreamError', 'createCdcSerialPump',
    captureSource + '\nreturn streamPostgresChanges;'
  )(
    ref => ref, slot => slot, /^[a-z_]+$/, /^0\/[0-9A-Fa-f]+$/,
    () => ({ host: 'localhost', port: 5432, sslMode: 'disable' }),
    FakeReplicationService, class {},
    (lsn, message) => ({ tag: message.tag, lsn }),
    (left, right) => Number.parseInt(left.split('/')[1], 16) - Number.parseInt(right.split('/')[1], 16),
    fail, error => { throw error; }, createCdcSerialPump
  );
  const run = extra => capture({
    ref: { endpoint: 'postgresql://127.0.0.1:5432?sslmode=disable', database: 'isolated', identity: { user: 'test' }, secretRef: { provider: 'env', key: 'ISOLATED_TEST' } },
    credentialBroker: { withSecret: async (_, fn) => fn('fake') },
    slotName: 'isolated_slot', publicationNames: ['isolated_pub'],
    startLsn: '0/0', untilLsn: '0/3', ...extra
  });
  return { run, getService: () => service };
}

const events = [['0/1', 'begin'], ['0/2', 'insert'], ['0/3', 'commit']];

test('slow durability callback cannot cause a later message to acknowledge first', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const harness = makeCapture(events);
  const observed = [];
  const running = harness.run({
    onChange: async change => {
      if (change.tag === 'begin') await gate;
      observed.push(change.tag);
    }
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(harness.getService().acknowledged, []);
  resume();
  const result = await running;
  assert.deepEqual(observed, ['begin', 'insert', 'commit']);
  assert.deepEqual(harness.getService().acknowledged, ['0/1', '0/2', '0/3']);
  assert.equal(result.acknowledgedLsn, '0/3');
  assert.equal(harness.getService().destroyed, true);
});

test('durability failure refuses subsequent messages and never ACKs their WAL positions', async () => {
  const harness = makeCapture(events);
  await assert.rejects(harness.run({
    onChange: async change => {
      if (change.tag === 'insert') throw Object.assign(new Error('injected apply failure'), { code: 'INJECTED_FAILURE' });
    }
  }), { code: 'INJECTED_FAILURE' });
  assert.deepEqual(harness.getService().acknowledged, ['0/1']);
  assert.equal(harness.getService().destroyed, true);
});

test('maximum message limit refuses incomplete source transaction before ACKing the boundary event', async () => {
  const harness = makeCapture(events);
  const delivered = [];
  await assert.rejects(harness.run({
    maxMessages: 2, onChange: async change => { delivered.push(change.tag); }
  }), { code: 'CDC_CAPTURE_BOUNDARY_INCOMPLETE' });
  assert.deepEqual(delivered, ['begin']);
  assert.deepEqual(harness.getService().acknowledged, ['0/1']);
});

test('LSN waterline is applied only on COMMIT, not to uncommitted row messages', async () => {
  const harness = makeCapture(events);
  const result = await harness.run({ untilLsn: '0/2' });
  assert.deepEqual(harness.getService().acknowledged, ['0/1', '0/2', '0/3']);
  assert.equal(result.acknowledgedLsn, '0/3');
});

test('transport ACK rejection cannot advance the reported commit LSN', async () => {
  const harness = makeCapture(events, { failAcknowledging: '0/3' });
  await assert.rejects(harness.run(), { code: 'ACK_FAILED' });
  assert.deepEqual(harness.getService().acknowledged, ['0/1', '0/2']);
});

test('callback queue bound refuses overflow without processing subsequent events', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const applied = [];
  const errors = [];
  const pump = createCdcSerialPump({
    maxPending: 2,
    handle: async (_, message) => { await gate; applied.push(message); },
    onFailure: error => errors.push(error)
  });
  assert.equal(pump.enqueue('0/1', 1), true);
  assert.equal(pump.enqueue('0/2', 2), true);
  assert.equal(pump.enqueue('0/3', 3), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'CDC_EVENT_BACKPRESSURE_EXCEEDED');
  release();
  await pump.drain();
  assert.deepEqual(applied, []);
  assert.deepEqual(pump.stats(), { accepting: false, pending: 0 });
});
