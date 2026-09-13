import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { comparePostgresLsn, createCdcCheckpointStore } from '../src/connectors/postgres/cdc.js';

test('PostgreSQL LSN comparison orders write-ahead positions', () => {
  assert.equal(comparePostgresLsn('0/16B6C50', '0/16B6C50'), 0);
  assert.equal(comparePostgresLsn('0/16B6C50', '0/16B6D00'), -1);
  assert.equal(comparePostgresLsn('0/16B6D00', '0/16B6C50'), 1);
  assert.equal(comparePostgresLsn('0/FFFFFFFE', '1/00000000'), -1);
  assert.equal(comparePostgresLsn('1/00000000', '0/FFFFFFFE'), 1);
  assert.throws(() => comparePostgresLsn('bogus', '0/1'), /INVALID_POSTGRES_LSN/);
  assert.throws(() => comparePostgresLsn('0/1', null), /INVALID_POSTGRES_LSN/);
});

test('CDC checkpoint store persists resume LSNs per slot across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-checkpoint-'));
  const path = join(dir, 'cdc.db');
  let store = createCdcCheckpointStore({ path });
  try {
    assert.equal(store.loadCheckpoint('orders_slot'), null);
    store.saveCheckpoint('orders_slot', '0/16B6C50');
    store.saveCheckpoint('orders_slot', '0/16B6D00');
    assert.equal(store.loadCheckpoint('orders_slot'), '0/16B6D00');
    store.saveCheckpoint('other_slot', '0/1000000');
    assert.equal(store.loadCheckpoint('other_slot'), '0/1000000');
    store.close();

    store = createCdcCheckpointStore({ path });
    assert.equal(store.loadCheckpoint('orders_slot'), '0/16B6D00');
    store.close();
  } finally {
    try { store.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('CDC checkpoint store rejects malformed slots and positions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-cdc-checkpoint-invalid-'));
  const store = createCdcCheckpointStore({ path: join(dir, 'cdc.db') });
  try {
    assert.throws(() => store.saveCheckpoint('HAS-DASH', '0/1'), /INVALID_POSTGRES_CDC_CONFIG/);
    assert.throws(() => store.saveCheckpoint('ok_slot', 'bogus'), /INVALID_POSTGRES_LSN/);
    assert.throws(() => store.loadCheckpoint('HAS-DASH'), /INVALID_POSTGRES_CDC_CONFIG/);
    assert.throws(() => createCdcCheckpointStore({}), /INVALID_CDC_CHECKPOINT_STORE/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
