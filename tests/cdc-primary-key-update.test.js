import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCdcTransaction } from '../src/connectors/postgres/cdc-apply.js';

const PLAN_ID = 'sha256:' + '1'.repeat(64);
const SNAPSHOT_ID = 'sha256:' + '2'.repeat(64);
const TARGET_CONTRACT_ID = 'sha256:' + '3'.repeat(64);

function plan() {
  return {
    planId: PLAN_ID,
    mappingRevision: 1,
    targetRef: {
      connector: 'postgres',
      connectionId: 'cdc-pk-test',
      resource: 'public.dst',
      schema: 'public',
      table: 'dst'
    },
    mapping: [
      { target: 'id', expr: { op: 'field', name: 'id' } },
      { target: 'payload', expr: { op: 'field', name: 'payload' } }
    ],
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'payload', type: 'string', nullable: false }
    ]
  };
}

function transaction(change, xid = 101) {
  return {
    xid,
    beginLsn: '0/100',
    commitLsn: '0/200',
    eventCount: 1,
    spilled: false,
    memoryEvents: [change]
  };
}

function update({ row, key = null, old = null }) {
  return {
    tag: 'update',
    lsn: '0/180',
    schema: 'public',
    table: 'src',
    row,
    key,
    old
  };
}

function capturingTarget() {
  const calls = [];
  return {
    calls,
    async commitCdcTransaction(input) {
      const mutations = [];
      for await (const mutation of input.mutations) mutations.push(mutation);
      assert.equal(mutations.length, input.mutationCount, 'hash pass and apply pass must agree on mutation count');
      calls.push({ ...input, mutations });
      return {
        transactionIdentity: input.transactionIdentity,
        inserted: 0,
        updated: mutations.filter(m => m.op === 'upsert').length,
        deleted: mutations.filter(m => m.op === 'delete').length,
        skippedMissing: 0,
        alreadyCommitted: false
      };
    }
  };
}

async function apply(change) {
  const target = capturingTarget();
  const result = await applyCdcTransaction({
    target,
    migration: {
      migrationId: 'cdc-pk-update-test',
      sourceSnapshotId: SNAPSHOT_ID
    },
    plan: plan(),
    targetContractId: TARGET_CONTRACT_ID,
    fencingToken: 7,
    transaction: transaction(change),
    primaryKey: ['id'],
    sourceTable: { schema: 'public', table: 'src' }
  });
  assert.equal(target.calls.length, 1);
  return { result, call: target.calls[0] };
}

test('pgoutput K update that changes mapped primary key deletes old key then upserts new row atomically', async () => {
  const { result, call } = await apply(update({
    row: { id: 2, payload: 'new' },
    key: { id: 1 }
  }));

  assert.equal(call.mutationCount, 2);
  assert.deepEqual(call.mutations, [
    {
      op: 'delete',
      key: { id: 1 },
      expectedRowHash: null,
      precondition: 'key-only'
    },
    {
      op: 'upsert',
      row: { id: 2, payload: 'new' }
    }
  ]);
  assert.equal(result.deleted, 1);
  assert.equal(result.updated, 1);
});

test('REPLICA IDENTITY FULL update that changes mapped primary key carries a full-row delete precondition', async () => {
  const { call } = await apply(update({
    row: { id: 2, payload: 'new' },
    old: { id: 1, payload: 'old' }
  }));

  assert.equal(call.mutationCount, 2);
  assert.equal(call.mutations[0].op, 'delete');
  assert.deepEqual(call.mutations[0].key, { id: 1 });
  assert.equal(call.mutations[0].precondition, 'full-row');
  assert.match(call.mutations[0].expectedRowHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(call.mutations[1], {
    op: 'upsert',
    row: { id: 2, payload: 'new' }
  });
});

test('ordinary update without K/O old image remains a single upsert', async () => {
  const { call } = await apply(update({
    row: { id: 1, payload: 'changed' }
  }));

  assert.equal(call.mutationCount, 1);
  assert.deepEqual(call.mutations, [
    {
      op: 'upsert',
      row: { id: 1, payload: 'changed' }
    }
  ]);
});

test('old key image equal to mapped new key does not emit a redundant delete', async () => {
  const { call } = await apply(update({
    row: { id: 1, payload: 'changed' },
    key: { id: 1 }
  }));

  assert.equal(call.mutationCount, 1);
  assert.equal(call.mutations[0].op, 'upsert');
});
