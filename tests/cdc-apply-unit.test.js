import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCdcBatchIdentity,
  createCdcTransactionIdentity,
  createRingBuffer,
  createCdcTransactionAssembler,
  iterateTransactionEvents,
  hashOrderedMutations
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
    // The finalized value is a handle: no materialized event array crosses
    // the memory/disk boundary. Streaming preserves arrival order.
    assert.equal(tx.memoryEvents.length <= 100, true);
    const streamed = [];
    for await (const event of iterateTransactionEvents(tx, { stagingDir: dir })) streamed.push(event);
    assert.equal(streamed.length, total);
    assert.equal(streamed[0].row.id, 1);
    assert.equal(streamed[99].row.id, 100);
    assert.equal(streamed[100].row.id, 101);
    assert.equal(streamed[total - 1].row.id, total);
    await assembler.discardStaged(9);
    assert.deepEqual(await assembler.listStaged(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CDC transaction identity binds the complete ordered transaction', () => {
  const base = {
    migrationId: 'mig-1', planId: 'sha256:' + '1'.repeat(64), sourceSnapshotId: 'sha256:' + '2'.repeat(64),
    mappingRevision: 1, targetIdentity: { connector: 'postgres', resource: 'public.t' },
    xid: 777, beginLsn: '0/16B6B00', commitLsn: '0/16B6C50',
    mutationCount: 3, payloadHash: 'sha256:' + '3'.repeat(64)
  };
  const first = createCdcTransactionIdentity(base);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, createCdcTransactionIdentity(structuredClone(base)));
  // Any transaction coordinate change aliases nothing.
  assert.notEqual(createCdcTransactionIdentity({ ...base, commitLsn: '0/16B6C60' }), first);
  assert.notEqual(createCdcTransactionIdentity({ ...base, xid: 778 }), first);
  assert.notEqual(createCdcTransactionIdentity({ ...base, mutationCount: 4 }), first);
  assert.notEqual(createCdcTransactionIdentity({ ...base, payloadHash: 'sha256:' + '4'.repeat(64) }), first);
  assert.throws(() => createCdcTransactionIdentity({ ...base, beginLsn: 'bogus' }), /INVALID_CDC_POSITION/);
});

test('ordered mutation hash binds order without buffering', async () => {
  const first = hashOrderedMutations([{ op: 'upsert', row: { id: 1 } }, { op: 'delete', key: { id: 2 } }]);
  assert.equal(first.mutationCount, 2);
  assert.match(first.payloadHash, /^sha256:[a-f0-9]{64}$/);
  // Order matters: swapped mutations hash differently.
  const swapped = hashOrderedMutations([{ op: 'delete', key: { id: 2 } }, { op: 'upsert', row: { id: 1 } }]);
  assert.notEqual(swapped.payloadHash, first.payloadHash);
  // Async iterables hash identically to arrays (streaming path equivalence).
  async function *gen() {
    yield { op: 'upsert', row: { id: 1 } };
    yield { op: 'delete', key: { id: 2 } };
  }
  const streamed = await hashOrderedMutations(gen());
  assert.equal(streamed.payloadHash, first.payloadHash);
  assert.equal(streamed.mutationCount, 2);
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

test('reconnect abandons the in-flight transaction and allows clean re-delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-reconnect-'));
  try {
    const assembler = createCdcTransactionAssembler({ maxInMemoryEvents: 2, stagingDir: dir });
    // First delivery: BEGIN + rows for a transaction interrupted by a
    // transport failure (only the first two rows got through before the
    // connection died; the third spilled to staging).
    await assembler.feed(change('begin', '0/100', { xid: 11 }));
    await assembler.feed(rowChange('insert', '0/110', 1, 'a'));
    await assembler.feed(rowChange('insert', '0/120', 2, 'b'));
    await assembler.feed(rowChange('insert', '0/130', 3, 'c'));
    assert.equal(await assembler.hasOpenTransaction(), true);
    // Reconnecting must discard the partial transaction INCLUDING its staged
    // spill: the durable watermark points BEFORE this transaction, so the
    // server will replay the whole thing from its BEGIN again.
    const abandoned = await assembler.abortOpenTransaction();
    assert.equal(abandoned.xid, 11);
    assert.equal(abandoned.spilled, true);
    assert.deepEqual(await assembler.listStaged(), []);
    assert.equal(await assembler.hasOpenTransaction(), false);
    // Clean replay from the watermark: one BEGIN, one COMMIT, no protocol
    // violation, no stale rows from the abandoned first delivery.
    await assembler.feed(change('begin', '0/100', { xid: 11 }));
    await assembler.feed(rowChange('insert', '0/110', 1, 'a'));
    await assembler.feed(rowChange('insert', '0/120', 2, 'b'));
    await assembler.feed(rowChange('insert', '0/130', 3, 'c'));
    const tx = await assembler.feed(change('commit', '0/140'));
    assert.equal(tx.xid, 11);
    assert.equal(tx.commitLsn, '0/140');
    assert.equal(tx.eventCount, 3);
    const streamed = [];
    for await (const event of iterateTransactionEvents(tx, { stagingDir: dir })) streamed.push(event);
    assert.deepEqual(streamed.map(event => event.row.id), [1, 2, 3]);
    // Aborting with nothing open is a no-op.
    assert.equal(await assembler.abortOpenTransaction(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('bounded ordered CDC hash rejects invalid budgets before consuming a source iterator', async () => {
  async function *mutations() { yield {op:'upsert',row:{id:1}}; }
  for (const value of [0,-1,1.5,Infinity]) {
    await assert.rejects(async () => hashOrderedMutations(mutations(), {maxMutations:value}), /INVALID_CDC_TRANSACTION/);
  }
});

test('bounded async CDC mutation hash stops exactly at first excess effect', async () => {
  const seen=[];
  async function *mutations() {
    for(let i=0;i<10;i++) { seen.push(i); yield {op:'upsert',row:{id:i}}; }
  }
  await assert.rejects(hashOrderedMutations(mutations(),{maxMutations:3}),/CDC_TRANSACTION_BUDGET_EXCEEDED/);
  assert.deepEqual(seen,[0,1,2,3]);
  assert.equal((await hashOrderedMutations((async function*(){yield {op:'upsert',row:{id:1}}})(),{maxMutations:1})).mutationCount,1);
});

test('bounded synchronous mutation hash refuses an oversized array immediately', () => {
  const stream=[{op:'upsert',row:{id:1}},{op:'upsert',row:{id:2}}];
  assert.throws(() => hashOrderedMutations(stream,{maxMutations:1}),/CDC_TRANSACTION_BUDGET_EXCEEDED/);
  assert.equal(hashOrderedMutations(stream,{maxMutations:2}).mutationCount,2);
});
