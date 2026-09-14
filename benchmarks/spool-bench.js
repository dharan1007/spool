import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { verifyContentProjection } from '../src/execution/content-verification.js';
import { merkleProof, merkleRoot, verifyMerkleProof } from '../src/execution/merkle.js';
import { createRepairPlan } from '../src/execution/repair-plan.js';
import { MigrationRunner } from '../src/execution/migration-runner.js';
import { SqliteTarget } from '../src/connectors/sqlite/target.js';
import { LeaseStore } from '../src/execution/lease-store.js';

const HASH = value => `sha256:${value.repeat(64).slice(0, 64)}`;
const pad64 = value => BigInt(value).toString(16).padStart(64, '0');

function contentRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `name-${index + 1}` }));
}

function benchContentVerification(sizes) {
  return sizes.map(size => {
    const rows = contentRows(size);
    const reversed = [...rows].reverse();
    const started = performance.now();
    const proof = verifyContentProjection({ expectedRows: rows, actualRows: reversed, primaryKey: ['id'], columns: ['id', 'name'] });
    const elapsedMs = performance.now() - started;
    if (proof.status !== 'VERIFIED') throw new Error('SPOOL-Bench content verification must verify identical projections');
    return {
      rows: size,
      verifyMs: Number(elapsedMs.toFixed(2)),
      verifyRowsPerSecond: Math.round(size / (elapsedMs / 1000)),
      rootHash: proof.expected.rootHash,
      merkleRoot: proof.expected.merkleRoot
    };
  });
}

function benchMerkle(sizes) {
  return sizes.map(size => {
    const leaves = contentRows(size).map(row => ({ keyId: `sha256:${pad64(row.id)}`, rowHash: `sha256:${pad64(row.id * 7)}` }));
    const started = performance.now();
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, leaves[Math.floor(size / 2)].keyId);
    const verified = verifyMerkleProof(proof);
    const elapsedMs = performance.now() - started;
    if (!verified || proof.root !== root) throw new Error('SPOOL-Bench merkle proof must verify against its root');
    return {
      leaves: size,
      rootProveVerifyMs: Number(elapsedMs.toFixed(2)),
      leavesPerSecond: Math.round(size / (elapsedMs / 1000)),
      root
    };
  });
}

function benchRepairPlan(missingCounts) {
  return missingCounts.map(missing => {
    const expected = contentRows(missing + 10);
    const actual = expected.slice(0, 10);
    const started = performance.now();
    const proof = verifyContentProjection({ expectedRows: expected, actualRows: actual, primaryKey: ['id'], columns: ['id', 'name'] });
    const plan = createRepairPlan({
      migrationId: 'spool_bench_repair',
      planId: HASH('1'),
      sourceSnapshotId: HASH('2'),
      targetIdentity: { connector: 'postgres', connectionId: 'bench', resource: 'public.rows', secretRef: { provider: 'env', key: 'SPOOL_BENCH_DUMMY' } },
      targetContractId: HASH('3'),
      verification: proof
    });
    const elapsedMs = performance.now() - started;
    if (plan.operations.length !== missing) throw new Error('SPOOL-Bench repair plan must cover every missing row');
    return {
      missingRows: missing,
      operations: plan.operations.length,
      planMs: Number(elapsedMs.toFixed(2)),
      repairPlanId: plan.repairPlanId
    };
  });
}

async function benchSqliteEndToEnd(sizes) {
  const results = [];
  for (const size of sizes) {
    const dir = await mkdtemp(join(tmpdir(), 'spool-bench-sqlite-'));
    const path = join(dir, 'bench.db');
    const setup = new Database(path);
    setup.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
    setup.close();
    // The lease store lives in the target database file: the fenced target
    // reads its lease from its own database.
    const leases = new LeaseStore({ path });
    const resource = 'sqlite:bench';
    const lease = leases.acquire({ resource, owner: 'spool-bench', ttlMs: 60_000, nowMs: Date.now() });
    const target = new SqliteTarget({ path, table: 'rows', requireFencing: true, fenceResource: resource });
    const checkpoints = new Map();
    const runner = new MigrationRunner({
      target,
      checkpointStore: { load: () => null, save: checkpoint => { checkpoints.set(checkpoint.nextOffset, checkpoint); } }
    });
    const batchSize = 1000;
    const started = performance.now();
    for (let start = 0; start < size; start += batchSize) {
      const endExclusive = Math.min(size, start + batchSize);
      const rows = [];
      for (let id = start + 1; id <= endExclusive; id += 1) rows.push({ id, name: `name-${id}` });
      runner.runBatch({
        migrationId: 'spool_bench_sqlite',
        planId: HASH('1'),
        sourceSnapshotId: HASH('2'),
        mappingRevision: 1,
        sourceRange: { start, endExclusive },
        targetIdentity: { connector: 'sqlite', connectionId: 'bench', resource: 'rows' },
        rows,
        fencingToken: lease.fencingToken,
        nowMs: Date.now()
      });
    }
    const elapsedMs = performance.now() - started;
    const check = new Database(path, { readonly: true });
    const count = Number(check.prepare('SELECT COUNT(*) AS n FROM rows').get().n);
    check.close();
    target.close();
    leases.close();
    await rm(dir, { recursive: true, force: true });
    if (count !== size) throw new Error('SPOOL-Bench SQLite run must persist every row');
    results.push({
      rows: size,
      writeMs: Number(elapsedMs.toFixed(2)),
      writeRowsPerSecond: Math.round(size / (elapsedMs / 1000))
    });
  }
  return results;
}

export async function runSpoolBench({ contentSizes = [1_000, 10_000], merkleSizes = [1_000, 10_000], repairMissing = [10, 100], sqliteSizes = [1_000, 10_000] } = {}) {
  return Object.freeze({
    contentVerification: Object.freeze(benchContentVerification(contentSizes)),
    merkle: Object.freeze(benchMerkle(merkleSizes)),
    repairPlan: Object.freeze(benchRepairPlan(repairMissing)),
    sqliteEndToEnd: Object.freeze(await benchSqliteEndToEnd(sqliteSizes))
  });
}
