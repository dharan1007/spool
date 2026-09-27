import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresMetadataCacheKey } from '../src/connectors/postgres/metadata-cache-key.js';

const baseline = Object.freeze({
  endpoint: 'postgresql://127.0.0.1:5432/?sslmode=disable',
  database: 'spooltest',
  schema: 'public', table: 'data',
  identity: { user: 'writer' }, secretRef: { provider: 'env', key: 'POSTGRES_TEST_PASSWORD' }
});
test('metadata bootstrap cache is scoped to target and credential identity', () => {
  const key = postgresMetadataCacheKey(baseline);
  assert.equal(key, postgresMetadataCacheKey(structuredClone(baseline)));
  const changes = [
    { endpoint: 'postgresql://127.0.0.2:5432/?sslmode=disable' },
    { database: 'other' }, { schema: 'audit' }, { table: 'other' },
    { identity: { user: 'different_writer' } },
    { secretRef: { provider: 'env', key: 'ROTATED_SECRET_REF' } }
  ];
  for (const change of changes) {
    assert.notEqual(postgresMetadataCacheKey({ ...baseline, ...change }), key, JSON.stringify(change));
  }
  assert.equal(key.includes('supersecret'), false);
});
test('cache key serialization is unambiguous across dotted identifiers', () => {
  const a = { ...baseline, database: 'db.a', schema: 'public', table: 'row' };
  const b = { ...baseline, database: 'db', schema: 'a.public', table: 'row' };
  assert.notEqual(postgresMetadataCacheKey(a), postgresMetadataCacheKey(b));
});
test('missing/malformed identity refuses to share a cache entry', () => {
  for (const ref of [null, [], {}, { ...baseline, endpoint: '' }, { ...baseline, identity: {} }, { ...baseline, secretRef: {} }, { ...baseline, table: 'bad\0table' }]) {
    assert.throws(() => postgresMetadataCacheKey(ref), /targetRef|identity/);
  }
});
