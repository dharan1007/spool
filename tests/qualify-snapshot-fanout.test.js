import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/qualify/postgres/database-source-load.js', import.meta.url), 'utf8');

async function qualifyMock(writers, { wrongJoined = false, missingLive = false } = {}) {
  const tables = new Map(), writes = [], readers = [];
  let exporterOpen = false;
  class Client {
    async connect() {}
    async end() {}
    async query(sql) {
      const table = /public\."([^"]+)"/.exec(sql)?.[1];
      if (sql.startsWith('DROP TABLE')) { tables.delete(table); return { rowCount: 0 }; }
      if (sql.startsWith('CREATE TABLE')) { tables.set(table, 0); return { rowCount: 0 }; }
      if (sql.includes('generate_series(1, 1000)')) { tables.set(table, 1000); return { rowCount: 1000 }; }
      if (sql.includes('VALUES (1000001')) {
        assert.equal(exporterOpen, true, 'post-export write happened after snapshot owner closed');
        tables.set(table, tables.get(table) + 1);
        writes.push(table);
        return { rowCount: 1 };
      }
      if (sql.startsWith('SELECT count(*)::int')) {
        return { rows: [{ c: missingLive && table === writes[0] ? 1000 : tables.get(table) }] };
      }
      throw new Error('Unexpected mock SQL: ' + sql);
    }
  }
  const fakeHash = () => ({ update() { return this; }, digest() { return 'abcdef0123456789'; } });
  const sourceRuntime = () => ({
    async withSnapshot(ref, read, opts) {
      assert.equal(exporterOpen, true, 'joined reader ran after export transaction ended');
      assert.equal(writes.length, writers * 2, 'read began before all post-export writes');
      assert.equal(opts.snapshotToken, 'snapshot-1');
      readers.push(ref.table);
      const count = wrongJoined && readers.length === 1 ? 1001 : 1000;
      return read({ async *batches() { yield { rows: Array(count) }; } });
    }
  });
  const executable = source.replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const qualify = new Function(
    'createHash', 'Client', 'CredentialBroker', 'discoverPostgresCatalog',
    'withExportedPostgresSnapshot', 'createPostgresSourceRuntime',
    executable + '\nreturn runDatabaseSourceLoad;'
  )(
    fakeHash, Client, class {},
    async () => ({ tableCount: tables.size, catalogId: 'catalog-1' }),
    async (_, callback) => {
      exporterOpen = true;
      try { return await callback({ exportedSnapshotId: 'snapshot-1', walLsn: '0/A' }); }
      finally { exporterOpen = false; }
    },
    sourceRuntime
  );
  let result, error;
  try {
    result = await qualify({
      profile: { writers }, seed: 'fixture', runId: 'fixture',
      evidenceWriter: { appendRaw() {} },
      pgConfig: { host: '127.0.0.1', port: 5432, database: 'isolated', user: 'test', password: 'test-only' }
    });
  } catch (caught) { error = caught; }
  return { result, error, writes, readers, remainingTables: tables.size };
}

test('all declared source readers join the exported snapshot, not two hardcoded tables', async () => {
  for (const writers of [2, 5]) {
    const { result, error, writes, readers, remainingTables } = await qualifyMock(writers);
    assert.equal(error, undefined);
    assert.equal(writes.length, writers * 2);
    assert.equal(new Set(readers).size, writers * 2);
    assert.equal(result.metrics.joinedReaders, writers);
    assert.equal(result.metrics.tablesRead, writers * 2);
    assert.equal(result.metrics.postExportWrites, writers * 2);
    assert.equal(result.metrics.totalRows, writers * 2000);
    assert.equal(remainingTables, 0);
  }
});
test('reader seeing post-export rows fails the shared-MVCC-snapshot qualification', async () => {
  const result = await qualifyMock(2, { wrongJoined: true });
  assert.match(result.error?.message ?? '', /Joined reader/);
  assert.equal(result.result, undefined);
  assert.equal(result.remainingTables, 0);
});
test('post-export write must be independently visible outside joined snapshot', async () => {
  const result = await qualifyMock(2, { missingLive: true });
  assert.match(result.error?.message ?? '', /not visible/);
  assert.equal(result.result, undefined);
  assert.equal(result.remainingTables, 0);
});
test('source code no longer substitutes a post-closure write for a concurrent snapshot test', () => {
  assert.doesNotMatch(source, /tables\.slice\(0, 2\)/);
  assert.match(source, /await Promise\.all\(Array\.from\(\{ length: profile\.writers \}/);
  assert.match(source, /postExportWrites: snapshotResult\.postExportWrites/);
});
