import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresCatalogIdentity, joinPostgresSnapshot } from '../src/connectors/postgres/database-source.js';

const table = (schema, name, primaryKey = ['id']) => ({
  schema,
  table: name,
  relkind: 'r',
  columns: [
    { name: 'id', type: 'integer', nullable: false, position: 1 },
    { name: 'name', type: 'text', nullable: true, position: 2 }
  ],
  primaryKey
});

test('catalog identity is deterministic and order-independent', () => {
  const first = postgresCatalogIdentity([table('public', 'b'), table('public', 'a'), table('sales', 'orders')]);
  const second = postgresCatalogIdentity([table('sales', 'orders'), table('public', 'a'), table('public', 'b')]);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('catalog identity changes when tables, columns or keys change', () => {
  const base = [table('public', 'orders')];
  const identity = postgresCatalogIdentity(base);
  assert.notEqual(postgresCatalogIdentity([]), identity);
  assert.notEqual(postgresCatalogIdentity([table('public', 'orders', [])]), identity);
  assert.notEqual(
    postgresCatalogIdentity([{ ...table('public', 'orders'), columns: [{ name: 'id', type: 'bigint', nullable: false, position: 1 }] }]),
    identity
  );
  assert.notEqual(postgresCatalogIdentity([table('public', 'orders2')]), identity);
});

test('catalog identity rejects malformed table material', () => {
  assert.throws(() => postgresCatalogIdentity('tables'), /INVALID_POSTGRES_DATABASE_SOURCE/);
  assert.throws(() => postgresCatalogIdentity([table('public', 'orders', ['missing'])]), /INVALID_POSTGRES_DATABASE_SOURCE/);
  assert.throws(() => postgresCatalogIdentity([{ ...table('public', 'orders'), columns: [] }]), /INVALID_POSTGRES_DATABASE_SOURCE/);
});

test('snapshot join rejects malformed tokens before touching the database', async () => {
  const neverQuery = { query: () => { throw new Error('must not query with a malformed token'); } };
  for (const token of [null, '', 'bogus', '00000003-00000001', 'zzzzzzzz-00000001-1', '00000003-00000001-1; DROP TABLE x']) {
    await assert.rejects(() => joinPostgresSnapshot(neverQuery, token), /INVALID_POSTGRES_SNAPSHOT_TOKEN/);
  }
  await assert.rejects(() => joinPostgresSnapshot(null, '00000003-00000001-1'), /INVALID_POSTGRES_DATABASE_SOURCE/);
});
