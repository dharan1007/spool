import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCdcTransactionAssembler,
  iterateTransactionEvents
} from '../src/connectors/postgres/cdc-apply.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('qualification must not administratively delete a dead worker lease after SIGKILL', async () => {
  const code = await source('scripts/qualify/postgres/crash-recovery.js');
  assert.doesNotMatch(
    code,
    /DELETE\s+FROM\s+spool_internal\.execution_leases/i,
    'qualification bypasses natural stale-lease recovery by deleting the lease directly'
  );
});

test('cutover crash matrix must exercise true process death, not graceful service.close substitution', async () => {
  const code = await source('tests/conformance/postgres-cutover-crash-matrix.test.js');
  assert.match(code, /(spawn|fork)\s*\(/, 'cutover crash matrix does not create a separate process');
  assert.match(code, /SIGKILL/, 'cutover crash matrix does not issue a hard kill');
  assert.doesNotMatch(
    code,
    /process-equivalent restart[\s\S]{0,500}?\.close\(\)/i,
    'graceful close is being labeled as process-equivalent crash'
  );
});

test('qualification checkpoint persistence must not use a single raw writeFile to the live checkpoint path', async () => {
  const code = await source('scripts/qualify/postgres/crash-recovery.js');
  assert.doesNotMatch(
    code,
    /save\s*\([^)]*\)\s*\{\s*await\s+writeFile\(checkpointPath\s*,/m,
    'qualification checkpoint writer can be torn/truncated and is not atomic'
  );
});

test('CDC spill preserves exact source ordering under aggressive spill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-redteam-order-'));
  const stagingDir = join(root, 'staging');
  try {
    const a = createCdcTransactionAssembler({
      maxInMemoryBytes: 1024,
      maxInMemoryEvents: 2,
      stagingDir
    });
    await a.feed({ tag: 'begin', xid: 77, lsn: '0/10' });
    for (let i = 1; i <= 12; i += 1) {
      await a.feed({ tag: 'insert', lsn: `0/${(0x10 + i).toString(16).toUpperCase()}`, relation: { schema: 'public', table: 't' }, row: { id: i, payload: 'x'.repeat(80) } });
    }
    const tx = await a.feed({ tag: 'commit', lsn: '0/40', commitEndLsn: '0/41' });
    const ids = [];
    for await (const e of iterateTransactionEvents(tx, { stagingDir })) ids.push(e.row.id);
    assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(tx.eventCount, 12);
    assert.ok(tx.spilled);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt staged CDC data fails closed rather than silently dropping rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-redteam-corrupt-spill-'));
  const stagingDir = join(root, 'staging');
  try {
    const a = createCdcTransactionAssembler({
      maxInMemoryBytes: 1024,
      maxInMemoryEvents: 1,
      stagingDir
    });
    await a.feed({ tag: 'begin', xid: 88, lsn: '0/10' });
    await a.feed({ tag: 'insert', lsn: '0/11', relation: { schema: 'public', table: 't' }, row: { id: 1 } });
    await a.feed({ tag: 'insert', lsn: '0/12', relation: { schema: 'public', table: 't' }, row: { id: 2 } });
    const tx = await a.feed({ tag: 'commit', lsn: '0/20', commitEndLsn: '0/21' });
    const spill = join(stagingDir, 'cdc-tx-88.jsonl');
    const original = await readFile(spill, 'utf8');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(spill, original + '{not-json}\n', 'utf8'));
    await assert.rejects(async () => {
      for await (const _ of iterateTransactionEvents(tx, { stagingDir })) {}
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CDC assembler rejects path-capable transaction ids before staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-redteam-xid-'));
  const stagingDir = join(root, 'staging');
  const outsideDir = join(root, 'outside');
  await mkdir(outsideDir, { recursive: true });
  try {
    const a = createCdcTransactionAssembler({
      maxInMemoryBytes: 1024,
      maxInMemoryEvents: 1,
      stagingDir
    });
    await assert.rejects(
      async () => {
        await a.feed({ tag: 'begin', xid: '../../../outside/pwn', lsn: '0/10' });
        await a.feed({ tag: 'insert', lsn: '0/11', relation: { schema: 'public', table: 't' }, row: { id: 1 } });
        await a.feed({ tag: 'insert', lsn: '0/12', relation: { schema: 'public', table: 't' }, row: { id: 2 } });
      },
      /CDC_PROTOCOL_VIOLATION|INVALID_CDC_TRANSACTION|xid/i,
      'non-integer xid reached filesystem staging instead of failing at the protocol boundary'
    );

    const escaped = resolve(stagingDir, 'cdc-tx-../../../outside/pwn.jsonl');
    assert.ok(
      escaped.startsWith(resolve(stagingDir) + sep),
      `staging path escaped the staging root: ${escaped}`
    );
    await assert.rejects(stat(join(outsideDir, 'pwn.jsonl')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('CDC COMMITTED_EXACT must prove every upsert in each SQL piece affected one row', async () => {
  const code = await source('src/connectors/postgres/target.js');
  const start = code.indexOf('async commitCdcTransaction(');
  const end = code.indexOf('async truncateTarget(', start);
  assert.ok(start >= 0 && end > start, 'commitCdcTransaction source was not found');
  const cdc = code.slice(start, end);
  assert.match(
    cdc,
    /written\.rowCount\s*!==\s*piece\.length|inserted\s*\+\s*updated\s*!==\s*piece\.length/,
    'COMMITTED_EXACT does not prove every row in each CDC upsert SQL piece produced an exact effect'
  );
  assert.doesNotMatch(
    cdc,
    /inserted\s*\+\s*updated\s*<\s*1/,
    'at-least-one affected row is insufficient evidence for a multi-row COMMITTED_EXACT transaction'
  );
});

test('target-contract proof cache must not act as a 10-second correctness bypass', async () => {
  const code = await source('src/connectors/postgres/target.js');
  assert.doesNotMatch(
    code,
    /CONTRACT_CACHE_TTL_MS\s*=\s*10_000[\s\S]{0,2500}?Date\.now\(\)\s*-\s*cached\.at\s*<\s*CONTRACT_CACHE_TTL_MS\)\s*return/,
    'mutations may trust a stale target schema/trigger/rule contract for 10 seconds'
  );
});
