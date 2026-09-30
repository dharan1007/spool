import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { replicaIdentityKeyColumnsFromIndexRows } from '../src/connectors/postgres/cdc.js';

// Regression fixture for the replica-identity parsing defect fixed in
// describePostgresReplicaIdentity. The previous implementation aggregated key
// columns with array_agg() in SQL. PostgreSQL returns that as the `_name` array
// type (OID 1003), and node-postgres/pg-types registers OID 1003 with noParse,
// so the value arrives in JavaScript as a literal Postgres array string such
// as "{id}" — never a JS array. The old Array.isArray() guard then produced an
// empty column list and every REPLICA IDENTITY DEFAULT/INDEX table was refused
// with CDC_REPLICA_IDENTITY_UNUSABLE ("no usable key columns").

const NAME_ARRAY_OID = 1003; // _name, the type of array_agg(attname)

test('node-postgres leaves the _name array type unparsed (the actual failing representation)', () => {
  const parse = pg.types.getTypeParser(NAME_ARRAY_OID);
  const value = parse('{id}');
  assert.equal(typeof value, 'string', 'OID 1003 must arrive as a string, proving the wire representation');
  assert.equal(value, '{id}');
  assert.equal(Array.isArray(value), false, 'the value is NOT a JS array — this is the defect input');
  // Multi-column primary keys arrive as a single brace literal too.
  assert.equal(parse('{b,a}'), '{b,a}');
});

test('the old Array.isArray consumer collapses the real representation to zero usable key columns', () => {
  const wireValue = pg.types.getTypeParser(NAME_ARRAY_OID)('{id}');
  // Old consumer logic (cdc.js pre-fix): Array.isArray(selected?.columns) guard.
  const oldColumns = Array.isArray(wireValue) ? wireValue.map(String) : [];
  assert.deepEqual(oldColumns, [], 'old logic reports no key columns for a table that has a primary key');
});

test('replica identity key selection groups per-row catalog output for DEFAULT mode', () => {
  const rows = [
    { index: 41000, primary: true, replicaIdentity: false, column: 'id' }
  ];
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows })], ['id']);
});

test('replica identity key selection preserves composite primary key order (ordinality)', () => {
  const rows = [
    { index: 41001, primary: true, replicaIdentity: false, column: 'b' },
    { index: 41001, primary: true, replicaIdentity: false, column: 'a' },
    { index: 41002, primary: false, replicaIdentity: false, column: 'payload' }
  ];
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows })], ['b', 'a']);
});

test('replica identity key selection honors an explicit replica-identity index under INDEX mode', () => {
  const rows = [
    { index: 41010, primary: true, replicaIdentity: false, column: 'id' },
    { index: 41011, primary: false, replicaIdentity: true, column: 'tenant_id' },
    { index: 41011, primary: false, replicaIdentity: true, column: 'source_id' }
  ];
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'INDEX', rows })], ['tenant_id', 'source_id']);
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows })], ['id']);
});

test('replica identity key selection returns empty columns when no matching index exists', () => {
  const rows = [{ index: 41020, primary: false, replicaIdentity: false, column: 'payload' }];
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows })], []);
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'INDEX', rows })], []);
  assert.deepEqual([...replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows: [] })], []);
});

test('replica identity key selection fails closed on unknown mode or malformed rows', () => {
  assert.throws(
    () => replicaIdentityKeyColumnsFromIndexRows({ mode: 'NOTHING', rows: [] }),
    /CDC_REPLICA_IDENTITY_UNKNOWN/
  );
  assert.throws(
    () => replicaIdentityKeyColumnsFromIndexRows({ mode: 'DEFAULT', rows: null }),
    /CDC_REPLICA_IDENTITY_UNKNOWN/
  );
});
