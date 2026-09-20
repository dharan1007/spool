import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCdcBatchIdentity,
  createRingBuffer,
  createCdcTransactionAssembler
} from '../src/connectors/postgres/cdc-apply.js';

function change(tag, lsn, extra = {}) {
  return Object.freeze({ tag, lsn, ...extra });
}

function rowChange(tag, lsn, id, payload) {
  return change(tag, lsn, { schema: 'public', table: 't', row: { id, payload }, key: { id }, old: tag === 'delete' || tag === 'update' ? { id, payload: `old-${id}` } : null });
}

test('CDC batch identity is deterministic and content-bound', () => {
  const base = {
    migrationId: 'mig-1', planId: 'sha256:' + '1'.repeat(64), sourceSnapshotId: 'sha256:' + '2'.repeat(64),
    mappingRevision: 1, targetIdentity: { connector: 'postgres', resource: 'public.t' },
    xid: 777, commitLsn: '0/16B6C50', payloadHash: 'sha256:' + '3'.repeat(64), rowCount: 2
  };
  const first = createCdcBatchIdentity(base);
  const second = createCdcBatchIdentity(structuredClone(base));
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  // Different commit LSN -> different identity (no cross-transaction aliasing).
  assert.notEqual(createCdcBatchIdentity({ ...base, commitLsn: '0/16B6C60' }), first);
  // Different content -> different identity (conflict, not silent reuse).
  assert.notEqual(createCdcBatchIdentity({ ...base, rowCount: 3 }), first);
  assert.throws(() => createCdcBatchIdentity({ ...base, commitLsn: 'bogus' }), /INVALID_CDC_POSITION/);
  assert.throws(() => createCdcBatchIdentity({ ...base, xid: -1 }), /INVALID_CDC_BATCH/);
});

test('ring buffer bounds history and allows zero retention', () => {
  const ring = createRingBuffer(3);
  for (let i = 0; i < 10; i++) ring.push({ i });
  assert.equal(ring.size(), 3);
  assert.deepEqual(ring.values().map(v => v.i), [7, 8, 9]);
  const empty = createRingBuffer(0);
  empty.push({ i: 1 });
  assert.equal(empty.size(), 0);
  assert.deepEqual(empty.values(), []);
  assert.throws(() => createRingBuffer(-1), /INVALID_CDC_BUFFER/);
});

test('assembler completes transactions in commit order', async () => {
  const assembler = createCdcTransactionAssembler();
  assert.equal(await assembler.feed(change('begin', '0/100', { xid: 1 })), null);
  assert.equal(await assembler.feed(rowChange('insert', '0/110', 1, 'a')), null);
  assert.equal(await assembler.feed(rowChange('insert', '0/120', 2, 'b')), null);
  const tx = await assembler.feed(change('commit', '0/130'));
  assert.ok(tx);
  assert.equal(tx.xid, 1);
  assert.equal(tx.commitLsn, '0/130');
  assert.equal(tx.eventCount, 2);
  assert.equal(tx.spilled, false);
  assert.equal(await assembler.finish(), null);
});

test('assembler rejects backward commit LSN', async () => {
  const assembler = createCdcTransactionAssembler();
  await assembler.feed(change('begin', '0/100', { xid: 1 }));
  await assembler.feed(change('commit', '0/200'));
  await assembler.feed(change('begin', '0/150', { xid: 2 }));
  await assert.rejects(assembler.feed(change('commit', '0/150')), /CDC_ORDER_VIOLATION/);
});

test('assembler rejects row events outside a transaction and nested begins', async () => {
  const assembler = createCdcTransactionAssembler();
  await assert.rejects(assembler.feed(rowChange('insert', '0/100', 1, 'a')), /CDC_PROTOCOL_VIOLATION/);
  await assembler.feed(change('begin', '0/100', { xid: 1 }));
  await assert.rejects(assembler.feed(change('begin', '0/110', { xid: 1 })), /CDC_PROTOCOL_VIOLATION/);
});

test('assembler refuses to silently drop an uncommitted tail', async () => {
  const assembler = createCdcTransactionAssembler();
  await assembler.feed(change('begin', '0/100', { xid: 1 }));
  await assembler.feed(rowChange('insert', '0/110', 1, 'a'));
  await assert.rejects(assembler.finish(), /CDC_TRANSACTION_INCOMPLETE/);
});

test('assembler spills oversized transactions to disk and preserves order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-spill-'));
  try {
    const assembler = createCdcTransactionAssembler({ maxInMemoryBytes: 1024 * 1024, maxInMemoryEvents: 100, stagingDir: dir });
    await assembler.feed(change('begin', '0/100', { xid: 9 }));
    const total = 500;
    for (let i = 1; i <= total; i++) {
      await assembler.feed(rowChange('insert', `0/${(0x200 + i).toString(16).toUpperCase()}`, i, `payload-${i}`));
    }
    const tx = await assembler.feed(change('commit', '0/FFFF'));
    assert.ok(tx);
    assert.equal(tx.spilled, true);
    assert.equal(tx.eventCount, total);
    // Arrival order preserved across the memory/disk boundary.
    assert.equal(tx.events[0].row.id, 1);
    assert.equal(tx.events[99].row.id, 100);
    assert.equal(tx.events[100].row.id, 101);
    assert.equal(tx.events[total - 1].row.id, total);
    await assembler.discardStaged(9);
    assert.deepEqual(await assembler.listStaged(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('staged transactions are listed for crash discard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-crash-'));
  try {
    const assembler = createCdcTransactionAssembler({ maxInMemoryEvents: 2, stagingDir: dir });
    await assembler.feed(change('begin', '0/100', { xid: 5 }));
    await assembler.feed(rowChange('insert', '0/110', 1, 'a'));
    await assembler.feed(rowChange('insert', '0/120', 2, 'b'));
    await assembler.feed(rowChange('insert', '0/130', 3, 'c'));
    assert.deepEqual(await assembler.listStaged(), [5]);
    // A fresh assembler after a crash sees the leftover staging and can
    // discard it; the watermark protocol re-delivers the events.
    const restarted = createCdcTransactionAssembler({ maxInMemoryEvents: 2, stagingDir: dir });
    assert.deepEqual(await restarted.listStaged(), [5]);
    await restarted.discardStaged(5);
    assert.deepEqual(await restarted.listStaged(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
