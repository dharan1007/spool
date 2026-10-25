import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQueryTarget } from '../src/connectors/bigquery/target.js';

// A deliberately strict fake of the BigQuery transaction boundary. This does
// not qualify Google Cloud BigQuery; it catches per-row autocommit regressions.
function atomicClient() {
  const state = { rows: [], ledger: new Map(), scriptCalls: 0, failAt: null };
  const client = {
    async query(sql, params = []) {
      if (/^(CREATE SCHEMA|CREATE TABLE|ALTER TABLE)/i.test(sql.trim())) return { rows: [] };
      if (/SELECT batch_identity/i.test(sql)) {
        const entry = state.ledger.get(params[0]);
        return { rows: entry ? [{ ...entry }] : [] };
      }
      if (!sql.startsWith('/* SPOOL_BIGQUERY_ATOMIC_V2 */')) {
        throw new Error('UNSAFE_AUTOCOMMIT_QUERY');
      }
      assert.match(sql, /BEGIN TRANSACTION;/);
      assert.match(sql, /DELETE FROM [^;]+ WHERE FALSE;/);
      assert.match(sql, /COMMIT TRANSACTION;/);
      assert.match(sql, /ROLLBACK TRANSACTION;/);
      state.scriptCalls++;
      const [id, replayId, expectedHash, expectedCount, migration, plan] = params;
      const [writeId, writeMigration, writePlan, rowCount, payloadHash, fence] = params.slice(-6);
      assert.equal(id, replayId);
      assert.equal(id, writeId);
      assert.equal(expectedHash, payloadHash);
      assert.equal(expectedCount, rowCount);
      assert.equal(migration, writeMigration);
      assert.equal(plan, writePlan);
      if (state.failAt === 'before-script') throw new Error('INJECTED_BEFORE_SCRIPT');
      const prior = state.ledger.get(id);
      if (prior) {
        if (prior.payload_hash !== payloadHash || prior.row_count !== rowCount ||
            prior.migration_id !== migration || prior.plan_id !== plan ||
            prior.commit_protocol !== 'SPOOL_ATOMIC_V2') throw new Error('SPOOL_LEDGER_CONFLICT');
        return { rows: [] };
      }
      const values = params.slice(6, -6);
      assert.equal(values.length, rowCount * 2);
      const tentative = state.rows.slice();
      for (let i = 0; i < rowCount; i++) {
        tentative.push({ id: values[2 * i], val: values[2 * i + 1] });
        if (state.failAt === 'mid-row-insert' && i === 0) throw new Error('INJECTED_MID_INSERT');
      }
      if (state.failAt === 'before-ledger') throw new Error('INJECTED_BEFORE_LEDGER');
      const proof = {
        batch_identity: id, migration_id: migration, plan_id: plan,
        row_count: rowCount, payload_hash: payloadHash, fencing_token: fence,
        commit_protocol: 'SPOOL_ATOMIC_V2', committed_at: new Date().toISOString()
      };
      if (state.failAt === 'before-commit') throw new Error('INJECTED_BEFORE_COMMIT');
      // Commit both surfaces at the same atomic boundary.
      state.rows = tentative;
      state.ledger.set(id, proof);
      if (state.failAt === 'after-commit-before-ack') throw new Error('INJECTED_AMBIGUOUS_ACK');
      return { rows: [] };
    }
  };
  return { client, state };
}

function createTarget(client) {
  return new BigQueryTarget({
    targetRef: { projectId: 'spool-project', datasetId: 'warehouse', tableId: 'events' },
    mockClient: client
  });
}

const input = {
  batchIdentity: 'atomic-batch-001', migrationId: 'migration-001',
  planId: 'plan-001', rows: [{ id: 1, val: 'alpha' }, { id: 2, val: 'beta' }]
};

test('BigQuery commitBatch: rollback all partially staged rows and ledger on interruption', async () => {
  for (const fault of ['before-script', 'mid-row-insert', 'before-ledger', 'before-commit']) {
    const { client, state } = atomicClient();
    const target = createTarget(client);
    state.failAt = fault;
    await assert.rejects(() => target.commitBatch(input), /INJECTED_/);
    assert.deepEqual(state.rows, [], fault + ' leaked target rows');
    assert.equal(state.ledger.size, 0, fault + ' leaked a ledger entry');
    state.failAt = null;
    const retry = await target.commitBatch(input);
    assert.equal(retry.status, 'COMMITTED_EXACT');
    assert.deepEqual(state.rows, input.rows);
    assert.equal(state.ledger.size, 1);
    const repeated = await target.commitBatch(input);
    assert.equal(repeated.status, 'COMMITTED_EXACT');
    assert.deepEqual(state.rows, input.rows);
  }
});

test('BigQuery commitBatch: ambiguous acknowledgement is reconciled without replaying target writes', async () => {
  const { client, state } = atomicClient();
  const target = createTarget(client);
  state.failAt = 'after-commit-before-ack';
  await assert.rejects(() => target.commitBatch(input), /INJECTED_AMBIGUOUS_ACK/);
  assert.deepEqual(state.rows, input.rows);
  assert.equal(state.ledger.size, 1);
  state.failAt = null;
  const recovered = await target.reconcileTargetCommit({
    batchIdentity: input.batchIdentity,
    payloadHash: target.describeBatch({ rows: input.rows }).payloadHash,
    rowCount: input.rows.length, migrationId: input.migrationId, planId: input.planId
  });
  assert.equal(recovered.status, 'COMMITTED_EXACT');
  const retried = await target.commitBatch(input);
  assert.equal(retried.status, 'COMMITTED_EXACT');
  assert.deepEqual(state.rows, input.rows);
});

test('BigQuery commitBatch: conflicting replay fails without changing target content', async () => {
  const { client, state } = atomicClient();
  const target = createTarget(client);
  await target.commitBatch(input);
  await assert.rejects(
    () => target.commitBatch({ ...input, rows: [{ id: 999, val: 'evil' }] }),
    /SPOOL_LEDGER_CONFLICT/
  );
  assert.deepEqual(state.rows, input.rows);
});

test('BigQuery commitBatch: duplicate concurrent submissions do not duplicate data', async () => {
  const { client, state } = atomicClient();
  const a = createTarget(client);
  const b = createTarget(client);
  const results = await Promise.all([a.commitBatch(input), b.commitBatch(input)]);
  assert.deepEqual(results.map(r => r.status), ['COMMITTED_EXACT', 'COMMITTED_EXACT']);
  assert.deepEqual(state.rows, input.rows);
  assert.equal(state.ledger.size, 1);
});

test('BigQuery reconcileTargetCommit: legacy ledger without atomic protocol is indeterminate', async () => {
  const { client, state } = atomicClient();
  state.ledger.set(input.batchIdentity, {
    batch_identity: input.batchIdentity, migration_id: input.migrationId,
    plan_id: input.planId, row_count: 2,
    payload_hash: 'legacy-hash', committed_at: new Date().toISOString()
  });
  const target = createTarget(client);
  const verdict = await target.reconcileTargetCommit({ batchIdentity: input.batchIdentity });
  assert.equal(verdict.status, 'INDETERMINATE');
  await assert.rejects(() => target.commitBatch(input), /SPOOL_LEDGER_CONFLICT/);
  assert.deepEqual(state.rows, []);
});
