import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteSnapshotReader } from '../src/connectors/sqlite/source-readonly.js';

async function withSqlite(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-sqlite-readback-'));
  const path = join(dir, 'customer.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE customers(id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;' +
    'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), amount TEXT NOT NULL) STRICT;');
  db.prepare('INSERT INTO customers(id, name) VALUES (?,?)').run('0007','Ada');
  db.prepare('INSERT INTO orders(id, customer_id, amount) VALUES (?,?,?)').run(1,'0007','100.00');
  db.close();
  try { await callback({path,dir}); } finally { await rm(dir,{force:true,recursive:true}); }
}
test('opens true read-only snapshot against an existing file; never creates missing DB',async()=>{
  await withSqlite(async({path,dir})=>{
    assert.throws(()=>new SqliteSnapshotReader({path:join(dir,'not-present.db')}), /SQLITE_CANTOPEN|unable to open|does not exist/i);
    const reader=new SqliteSnapshotReader({path});
    assert.equal(reader.db.pragma('query_only',{simple:true}),1);
    assert.throws(()=>reader.db.exec('INSERT INTO customers(id,name) VALUES (\'0010\',\'Not allowed\')'),/readonly|read-only/i);
    reader.close();
  });
});
test('coherent multi-table WAL snapshot ignores later independent committed changes',async()=>{
  await withSqlite(async({path})=>{
    const reader = new SqliteSnapshotReader({path});
    const before=reader.digestTable('customers');
    assert.equal(before.rowCount,1);
    const writer=new Database(path);
    writer.exec("BEGIN IMMEDIATE; UPDATE customers SET name = 'Modified' WHERE id = '0007'; INSERT INTO customers VALUES ('0008','Lin'); INSERT INTO orders VALUES(2,'0008','20.00'); COMMIT;");
    writer.close();
    const orders=[...reader.iterateTable('orders')];
    const people=[...reader.iterateTable('customers')];
    assert.equal(orders.length,1);
    assert.equal(people.length,1);
    assert.equal(people[0].name,'Ada');
    assert.equal(orders[0].amount,'100.00');
    reader.close();
    const later=new SqliteSnapshotReader({path});
    assert.equal(later.digestTable('customers').rowCount,2);
    assert.equal(later.digestTable('orders').rowCount,2);
    later.close();
  });
});
test('live SQLite readback detects changed target value with equal row counts',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path});
    const input={table:'customers',keyColumns:['id'],expectedRows:[{id:'0007',name:'Ada'}]};
    assert.equal(reader.verifyExpectedRows(input).status,'VERIFIED');
    reader.close();
    const writer=new Database(path);
    writer.prepare('UPDATE customers SET name = ? WHERE id = ?').run('Wrong','0007');
    writer.close();
    const verify=new SqliteSnapshotReader({path});
    const result=verify.verifyExpectedRows(input);
    assert.equal(result.status,'MISMATCH');
    assert.equal(result.mismatched,1);assert.equal(result.expectedCount,1);
    assert.equal(result.rawRowsIncluded,false);
    assert.ok(!JSON.stringify(result).includes('Wrong'));
    assert.ok(!JSON.stringify(result).includes('Ada'));
    verify.close();
  });
});
test('missing expected row is MISMATCH rather than clean successful ledger',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path});
    const result=reader.verifyExpectedRows({table:'customers',keyColumns:['id'],expectedRows:[{id:'0009',name:'Nobody'}]});
    assert.equal(result.status,'MISMATCH');assert.equal(result.missing,1);reader.close();
  });
});
test('duplicate expected identities fail closed as INDETERMINATE without changes',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path});
    const row={id:'0007',name:'Ada'};
    const result=reader.verifyExpectedRows({table:'customers',keyColumns:['id'],expectedRows:[row,row]});
    assert.equal(result.status,'INDETERMINATE');assert.equal(result.indeterminate,1);reader.close();
  });
});
test('no expected evidence is NOT_VERIFIED and scope never claims entire database',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path});
    const result=reader.verifyExpectedRows({table:'customers',keyColumns:['id'],expectedRows:[]});
    assert.equal(result.status,'NOT_VERIFIED');
    assert.equal(result.actualTargetRowsOutsideExpectedUnknown,true);
    assert.equal(result.mutationAuthorized,false);
    reader.close();
  });
});
test('rejects unproven identity columns and non-base-table sources',async()=>{
  await withSqlite(async({path})=>{
    const db=new Database(path);
    db.exec("CREATE VIEW customer_view AS SELECT * FROM customers;");
    db.exec("CREATE TABLE loose (row TEXT, payload TEXT);");
    db.close();
    const reader=new SqliteSnapshotReader({path});
    assert.throws(()=>reader.table('customer_view'),/SQLITE_SOURCE_NOT_BASE_TABLE/);
    assert.throws(()=>reader.verifyExpectedRows({table:'loose',keyColumns:['row'],expectedRows:[]}),/SQLITE_READBACK_KEY_NOT_UNIQUE/);
    assert.throws(()=>reader.table('sqlite_master'),/SQLITE_SOURCE_SYSTEM_TABLE/);
    assert.throws(()=>[...reader.iterateTable('customers',{columns:['not_a_column']})],/SQLITE_SOURCE_COLUMN_INVALID/);
    reader.close();
  });
});
test('typed fidelity preserves integer, text leading zeros, blob bytes and NULL',async()=>{
  await withSqlite(async({path})=>{
    const db=new Database(path);
    db.exec('CREATE TABLE stuff(id INTEGER PRIMARY KEY, label TEXT, payload BLOB, note TEXT);');
    db.prepare('INSERT INTO stuff VALUES (?,?,?,?)').run(1,'0007',Buffer.from([0,255,128]),null);
    db.close();
    const reader=new SqliteSnapshotReader({path});
    const expected=[{id:1,label:'0007',payload:Buffer.from([0,255,128]),note:null}];
    assert.equal(reader.verifyExpectedRows({table:'stuff',keyColumns:['id'],expectedRows:expected}).status,'VERIFIED');
    const corrupted=[{id:1,label:'7',payload:Buffer.from([0,255,128]),note:null}];
    assert.equal(reader.verifyExpectedRows({table:'stuff',keyColumns:['id'],expectedRows:corrupted}).status,'MISMATCH');
    assert.equal([...reader.iterateTable('stuff')][0].id,1n);
    reader.close();
  });
});
test('composite UNIQUE key is accepted only when SQLite enforces it',async()=>{
  await withSqlite(async({path})=>{
    const db=new Database(path);
    db.exec('CREATE TABLE items(a TEXT NOT NULL, b TEXT NOT NULL, value TEXT, UNIQUE(a,b));');
    db.prepare('INSERT INTO items VALUES(?,?,?)').run('x','y','good');
    db.close();
    const reader=new SqliteSnapshotReader({path});
    const result=reader.verifyExpectedRows({table:'items',keyColumns:['b','a'],expectedRows:[{a:'x',b:'y',value:'good'}]});
    assert.equal(result.status,'VERIFIED');
    assert.equal(result.identityConstraint,'UNIQUE_INDEX');
    reader.close();
  });
});
test('bounded streaming halts when declared source ceiling is passed',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path,maxRows:1});
    const first=[...reader.iterateTable('customers')];
    assert.equal(first.length,1);
    const writer=new Database(path);writer.prepare('INSERT INTO customers VALUES(?,?)').run('0008','Lin');writer.close();
    reader.close();
    const limit=new SqliteSnapshotReader({path,maxRows:1});
    assert.throws(()=>[...limit.iterateTable('customers')],/SQLITE_SOURCE_LIMIT_EXCEEDED/);
    limit.close();
  });
});
test('reader rejects invalid projection identifiers and closes cleanly',async()=>{
  await withSqlite(async({path})=>{
    const reader=new SqliteSnapshotReader({path});
    assert.throws(()=>[...reader.iterateTable('customers',{columns:['id','id']})],/SQLITE_SOURCE_COLUMN_INVALID/);
    reader.close();
    reader.close();
    assert.throws(()=>reader.table('customers'),/SQLITE_SOURCE_CLOSED/);
  });
});
