import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { parsePostgresEndpoint } from '../../../src/connectors/postgres/connection.js';
import { PostgresTarget, acquirePostgresLease } from '../../../src/connectors/postgres/target.js';
import {
  createCdcTransactionAssembler,
  createCdcTransactionIdentity,
  iterateTransactionEvents,
  hashOrderedMutations
} from '../../../src/connectors/postgres/cdc-apply.js';

// Large-transaction qualification through the REAL SPOOL CDC staging path:
// synthetic source transactions of profile-declared sizes stream through
// createCdcTransactionAssembler (bounded memory + durable spill), then stream
// back out via iterateTransactionEvents and commit atomically through
// PostgresTarget.commitCdcTransaction. Recorded per size: event count,
// transaction bytes, spill bytes, peak RSS delta, streaming-apply duration,
// target commit duration. Sizes derive from profile.largeTransactionRows —
// no silent cap, no downscale.
export async function runLargeTransactions({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.largeTransactions';
  const sizes = [1, 100, 10000, 100000, 1000000].filter(n => n <= profile.largeTransactionRows);
  const effectiveConfig = { largeTransactionRows: profile.largeTransactionRows };
  const table = `qualify_large_tx_${runId.replaceAll('-', '_').toLowerCase()}`;
  const stagingRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-large-tx-'));
  const broker = new CredentialBroker();
  broker.withSecret = async (ref, fn) => fn(pgConfig.password);
  const targetRef = {
    connector: 'postgres', connectionId: 'pg-large-tx', resource: `public.${table}`,
    endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`,
    database: pgConfig.database, schema: 'public', table,
    identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' }
  };
  const failures = [];
  const results = [];
  let client = null;

  const lsn = n => `0/${n.toString(16).toUpperCase()}`;
  const rss = () => process.memoryUsage().rss;

  try {
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.end(); client = null;

    const parsed = parsePostgresEndpoint(targetRef.endpoint);
    const resource = `postgres:${parsed.endpoint}:${pgConfig.database}:public.${table}`;
    const lease = await acquirePostgresLease({ targetRef, credentialBroker: broker, resource, owner: `large-tx-${runId}`, ttlMs: 600_000 });
    const target = new PostgresTarget({ targetRef, credentialBroker: broker, requireFencing: true, fenceResource: resource, fenceOwner: `large-tx-${runId}` });

    let xidBase = 500000;
    for (const size of sizes) {
      const xid = xidBase += 1;
      const stagingDir = join(stagingRoot, `tx-${size}`);
      const assembler = createCdcTransactionAssembler({ maxInMemoryBytes: 1024 * 1024, maxInMemoryEvents: 5000, stagingDir });
      const memBefore = rss();
      const feedStart = process.hrtime.bigint();
      await assembler.feed({ tag: 'begin', lsn: lsn(0x1000), xid });
      let txBytes = 0;
      for (let i = 1; i <= size; i += 1) {
        const change = { tag: 'insert', lsn: lsn(0x1000 + i), schema: 'public', table, row: { id: i, payload: `payload-${seed}-${i}` } };
        txBytes += Buffer.byteLength(JSON.stringify(change), 'utf8');
        await assembler.feed(change);
        if (i % 100000 === 0) {
          evidenceWriter.appendRaw({ scenario, event: 'large_tx_progress', size, fed: i, rssBytes: rss() });
          if (globalThis.gc) globalThis.gc();
        }
      }
      const tx = await assembler.feed({ tag: 'commit', lsn: lsn(0x1000 + size + 1) });
      const feedMs = Number(process.hrtime.bigint() - feedStart) / 1e6;
      const memAfterFeed = rss();

      // Pass 1: streaming ordered hash (O(1) memory even for spilled txns).
      const hashStart = process.hrtime.bigint();
      let streamed = 0;
      const counter = (async function *() {
        for await (const event of iterateTransactionEvents(tx, { stagingDir })) {
          streamed += 1;
          yield { op: event.tag === 'delete' ? 'delete' : 'upsert', row: event.row, key: event.key };
        }
      })();
      const hashed = await hashOrderedMutations(counter);
      const hashMs = Number(process.hrtime.bigint() - hashStart) / 1e6;

      // Pass 2: streaming atomic apply through the production target path.
      const applyStart = process.hrtime.bigint();
      const applier = (async function *() {
        for await (const event of iterateTransactionEvents(tx, { stagingDir })) {
          yield { op: 'upsert', row: { id: event.row.id, payload: event.row.payload } };
        }
      })();
      const identity = createCdcTransactionIdentity({
        migrationId: `large-tx-${runId}`, planId: `sha256:${'1'.repeat(64)}`,
        sourceSnapshotId: `sha256:${'2'.repeat(64)}`, mappingRevision: 1, targetIdentity: targetRef,
        xid, beginLsn: lsn(0x1000), commitLsn: lsn(0x1000 + size + 1),
        mutationCount: hashed.mutationCount, payloadHash: hashed.payloadHash
      });
      const committed = await target.commitCdcTransaction({
        migrationId: `large-tx-${runId}`, planId: `sha256:${'1'.repeat(64)}`,
        sourceSnapshotId: `sha256:${'2'.repeat(64)}`, mappingRevision: 1,
        fencingToken: lease.fencingToken, transactionIdentity: identity,
        xid, beginLsn: lsn(0x1000), commitLsn: lsn(0x1000 + size + 1),
        mutationCount: hashed.mutationCount, payloadHash: hashed.payloadHash,
        primaryKey: ['id'], mutations: applier
      });
      const applyMs = Number(process.hrtime.bigint() - applyStart) / 1e6;
      const memAfterApply = rss();
      await assembler.discardStaged(xid);

      const verify = await (async () => {
        const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
        await c.connect();
        try {
          const count = await c.query(`SELECT count(*)::int AS c FROM public."${table}"`);
          await c.query(`TRUNCATE public."${table}"`);
          return count.rows[0].c;
        } finally { await c.end(); }
      })();

      if (streamed !== size || hashed.mutationCount !== size) {
        failures.push({ scenario, code: 'LARGE_TX_COUNT_MISMATCH', message: `size ${size}: streamed ${streamed}, hashed ${hashed.mutationCount}`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      }
      if (verify !== size) {
        failures.push({ scenario, code: 'LARGE_TX_TARGET_MISMATCH', message: `size ${size}: target holds ${verify} rows`, expected: false, classification: 'CORRECTNESS', timestamp: new Date().toISOString() });
      }
      const record = {
        size, eventCount: tx.eventCount, spilled: tx.spilled,
        txBytes, spillBytes: tx.stagedBytes ?? 0,
        feedMs, hashMs, applyMs,
        memFeedDeltaBytes: memAfterFeed - memBefore,
        memApplyDeltaBytes: memAfterApply - memAfterFeed,
        rssPeakBytes: Math.max(memAfterFeed, memAfterApply),
        inserted: committed.inserted, targetRows: verify,
        memoryBoundRespected: (memAfterFeed - memBefore) < Math.max(txBytes, 1)
      };
      results.push(record);
      evidenceWriter.appendRaw({ scenario, event: 'large_tx', ...record });
    }
    const largestTransaction = sizes.length ? Math.max(...sizes) : 0;
    return { metrics: { scenario, requestedConfig: { largeTransactionRows: profile.largeTransactionRows }, effectiveConfig, results, largestTransaction, sizes }, failures };
  } finally {
    try { if (client) await client.end(); } catch {}
    try { await rm(stagingRoot, { recursive: true, force: true }); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect(); await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); await c.end();
    } catch {}
  }
}
