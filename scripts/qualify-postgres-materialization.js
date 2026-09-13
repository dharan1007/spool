#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import { createPostgresSourceRuntime } from '../src/connectors/postgres/source.js';
import { loadMaterializedSnapshot, streamMaterializedRows } from '../src/connectors/materialized-snapshot.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const rows = Number.parseInt(process.env.SPOOL_QUALIFICATION_ROWS ?? '300000', 10);
const payloadBytes = Number.parseInt(process.env.SPOOL_QUALIFICATION_PAYLOAD_BYTES ?? '1024', 10);
const maxRssBytes = Number.parseInt(process.env.SPOOL_QUALIFICATION_MAX_RSS_BYTES ?? String(512 * 1024 * 1024), 10);

if (!endpoint || !password) throw new Error('PostgreSQL qualification requires SPOOL_TEST_POSTGRES_ENDPOINT and SPOOL_TEST_PG_PASSWORD');
if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('SPOOL_QUALIFICATION_ROWS must be a positive integer');
if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 16 * 1024) throw new Error('SPOOL_QUALIFICATION_PAYLOAD_BYTES must be between 1 and 16384');
if (!Number.isSafeInteger(maxRssBytes) || maxRssBytes < 64 * 1024 * 1024) throw new Error('SPOOL_QUALIFICATION_MAX_RSS_BYTES is invalid');

const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const table = `spool_materialization_qualification_${process.pid}`;
const root = await mkdtemp(join(tmpdir(), 'spool-pg-qualification-'));
const broker = new CredentialBroker();

function sourceRef() {
  return {
    connector: 'postgres',
    connectionId: 'pg-large-source-qualification',
    resource: `public.${table}`,
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
}

async function client() {
  const url = new URL(endpoint);
  const pg = new Client({ host: url.hostname, port: Number(url.port || 5432), database, user, password, ssl: false });
  await pg.connect();
  return pg;
}

async function treeBytes(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path)) total += await treeBytes(join(path, name));
  return total;
}

let peakRssBytes = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 20);
sampler.unref();

let pg;
try {
  pg = await client();
  await pg.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
  await pg.query(
    `INSERT INTO public."${table}"(id,payload)
     SELECT value, repeat('x', $2::int)
     FROM generate_series(1, $1::int) AS value`,
    [rows, payloadBytes]
  );
  await pg.end();
  pg = null;

  const runtime = createPostgresSourceRuntime({ credentialBroker: broker, batchSize: 5000 });
  const materializeStarted = performance.now();
  const materialized = await runtime.materializeSnapshot(sourceRef(), {
    snapshotDir: root,
    chunkRows: 5000,
    maxChunkBytes: 16 * 1024 * 1024
  });
  const materializeMs = performance.now() - materializeStarted;

  assert.equal(materialized.snapshot.rowCount, rows, 'materialized row count must match source');
  assert.ok(materialized.snapshot.byteCount > 256 * 1024 * 1024, 'qualification dataset must exceed the former 256 MiB whole-source ceiling');

  const verifyStarted = performance.now();
  const verified = await loadMaterializedSnapshot({ snapshotDir: root, snapshotId: materialized.snapshot.snapshotId });
  const verifyMs = performance.now() - verifyStarted;

  let replayedRows = 0;
  const replayStarted = performance.now();
  for await (const item of streamMaterializedRows(verified)) {
    assert.equal(item.row.id, replayedRows + 1, 'replay order must remain deterministic');
    replayedRows += 1;
  }
  const replayMs = performance.now() - replayStarted;
  assert.equal(replayedRows, rows, 'replay must reproduce every materialized row');

  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  assert.ok(peakRssBytes <= maxRssBytes, `peak RSS ${peakRssBytes} exceeded qualification ceiling ${maxRssBytes}`);

  const diskBytes = await treeBytes(materialized.snapshotPath);
  const sourceBytes = materialized.snapshot.byteCount;
  const report = {
    schemaVersion: 1,
    qualification: 'postgres-materialized-source',
    rows,
    payloadBytesPerRow: payloadBytes,
    sourceBytes,
    sourceMiB: Number((sourceBytes / 1024 / 1024).toFixed(2)),
    chunks: materialized.snapshot.chunks.length,
    diskBytes,
    diskAmplification: Number((diskBytes / sourceBytes).toFixed(4)),
    peakRssBytes,
    peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(2)),
    materializeMs: Number(materializeMs.toFixed(2)),
    materializeMiBPerSecond: Number((sourceBytes / 1024 / 1024 / (materializeMs / 1000)).toFixed(2)),
    verifyMs: Number(verifyMs.toFixed(2)),
    verificationOverheadRatio: Number((verifyMs / materializeMs).toFixed(4)),
    replayMs: Number(replayMs.toFixed(2)),
    replayMiBPerSecond: Number((sourceBytes / 1024 / 1024 / (replayMs / 1000)).toFixed(2)),
    snapshotId: materialized.snapshot.snapshotId,
    maxRssBytes
  };
  console.log(`SPOOL_QUALIFICATION ${JSON.stringify(report)}`);
} finally {
  clearInterval(sampler);
  if (pg) await pg.end().catch(() => {});
  const cleanup = await client().catch(() => null);
  if (cleanup) {
    try { await cleanup.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); }
    finally { await cleanup.end(); }
  }
  await rm(root, { recursive: true, force: true });
}
