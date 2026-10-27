// REST API v2 benchmark qualification.
//
// This benchmark measures THREE transport/store layers separately and reports
// each figure for exactly what it exercises. It does NOT measure migration
// execution throughput: a real engine run is a long, write-heavy lifecycle
// that is qualified by tests/api-v2.test.js and the per-connector suites,
// not by request-rate sampling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { EnterpriseRegistry } from '../src/enterprise/registry.js';
import { createEnterpriseOrchestrator } from '../src/enterprise/orchestrator.js';
import { createSpoolDaemonV2 } from '../src/daemon/spoold-v2.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

async function runBenchmark(label, { requests, concurrency, task }) {
  const latencies = [];
  let successful = 0;
  let failed = 0;
  const startedAt = process.hrtime.bigint();
  const queue = Array.from({ length: requests }, (_, index) => index);
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.pop();
      if (item === undefined) break;
      const t0 = performance.now();
      try {
        const ok = await task(item);
        if (ok) successful += 1; else failed += 1;
      } catch {
        failed += 1;
      }
      latencies.push(performance.now() - t0);
    }
  });
  await Promise.all(workers);
  const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
  latencies.sort((a, b) => a - b);
  const percentile = p => Number((latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? 0).toFixed(2));
  const result = {
    label,
    requests,
    concurrency,
    successful,
    failed,
    successRatePct: Number(((successful / requests) * 100).toFixed(2)),
    durableSeconds: Number(durationSec.toFixed(3)),
    requestsPerSecond: Math.round(requests / durationSec),
    latencyMs: { min: percentile(0), p50: percentile(50), p95: percentile(95), p99: percentile(99), max: percentile(100) }
  };
  console.log(`${label}: ${result.requestsPerSecond} req/s (auth layer, ${requests} reqs, x${concurrency}); p50=${result.latencyMs.p50}ms p95=${result.latencyMs.p95}ms p99=${result.latencyMs.p99}ms`);
  return result;
}

test('REST API v2 layered benchmark: transport probes, authenticated API and real registry reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spool-api-stress-'));
  t.after(() => { void rm(root, { recursive: true, force: true }); });
  const dirA = join(root, 'wsA');
  await mkdir(dirA);

  const registry = new EnterpriseRegistry({ path: join(root, 'enterprise.db') });
  t.after(() => registry.close());
  const org = registry.createOrganization('benchmark-org');
  const wsA = registry.createWorkspace({ organizationId: org.organizationId, name: 'Bench A', directory: dirA });
  registry.addMembership({ workspaceId: wsA.workspaceId, principalId: 'bench-principal', role: 'viewer' });

  const orchestrator = createEnterpriseOrchestrator({
    registry,
    approvalSigningKey: TOKEN,
    release: { version: '1.1.2', commitSha: COMMIT_SHA },
    maxSourceBytes: 256 * 1024 * 1024
  });
  const daemon = createSpoolDaemonV2({ orchestrator, registry, token: TOKEN });
  const address = await daemon.listen(0);
  const port = address.port;
  t.after(() => daemon.close());

  // Seed exactly one real migration record so reads hit real rows.
  let csv = 'customer_id,full_name,monthly_fee,joined_on,is_active\n';
  for (let i = 1; i <= 3; i += 1) csv += `${i}," Bench ${i} ",5,2024-06-01,true\n`;
  await writeFile(join(dirA, 'bench.csv'), csv, 'utf8');
  const targetA = join(dirA, 'bench.db');
  const seedDb = new Database(targetA);
  seedDb.exec('CREATE TABLE bench (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, monthly_fee REAL NOT NULL, joined_on TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;');
  seedDb.close();
  const created = await orchestrator.createMigration({
    workspaceId: wsA.workspaceId,
    name: 'bench record',
    principalId: 'bench-principal',
    sourcePath: join(dirA, 'bench.csv'),
    destination: {
      path: targetA,
      table: 'bench',
      targetSchema: [
        { name: 'customer_id', type: 'integer', nullable: false },
        { name: 'full_name', type: 'string', nullable: false },
        { name: 'monthly_fee', type: 'number', nullable: false },
        { name: 'joined_on', type: 'string', nullable: false },
        { name: 'is_active', type: 'integer', nullable: false }
      ]
    },
    mapping: [
      { target: 'customer_id', expr: { op: 'cast_number', value: { op: 'field', name: 'customer_id' } } },
      { target: 'full_name', expr: { op: 'trim', value: { op: 'field', name: 'full_name' }, multiline: true } },
      { target: 'monthly_fee', expr: { op: 'cast_number', value: { op: 'field', name: 'monthly_fee' } } },
      { target: 'joined_on', expr: { op: 'trim', value: { op: 'field', name: 'joined_on' } } },
      { target: 'is_active', expr: { op: 'cast_number', value: { op: 'field', name: 'is_active' } } }
    ],
    batchSize: 1000
  });

  const getRequest = (path, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers })
      .then(async res => ({ ok: res.status === 200, status: res.status, body: await res.json() }));

  // Layer 1: unauthenticated transport probes (no auth, no business logic).
  const transport = await runBenchmark('transport-probes', {
    requests: 300,
    concurrency: 30,
    task: async () => {
      const path = ['/v2/health', '/v2/ready'][Math.floor(Math.random() * 2)];
      return (await getRequest(path)).ok;
    }
  });

  // Layer 2: authenticated API surface (bearer auth + RBAC + history read).
  const authHeaders = { authorization: `Bearer ${TOKEN}` };
  const authenticated = await runBenchmark('authenticated-api-lists', {
    requests: 300,
    concurrency: 30,
    task: async () => {
      const res = await getRequest('/v2/migrations', authHeaders);
      return res.ok && res.body.result.items.length === 1;
    }
  });

  // Layer 3: orchestrator status reads through the real SQLite registry.
  const readHeaders = { 'x-api-key': 'unused' };
  void readHeaders;
  const registryReads = await runBenchmark('orchestrator-registry-reads', {
    requests: 300,
    concurrency: 30,
    task: async () => {
      const status = await orchestrator.status({ migrationId: created.migrationId, principalId: 'bench-principal' });
      return status.status === 'CREATED';
    }
  });

  assert.equal(transport.failed, 0);
  assert.equal(authenticated.failed, 0);
  assert.equal(registryReads.failed, 0);
  assert.ok(transport.requestsPerSecond > 50, `transport benchmark floor: ${transport.requestsPerSecond}`);
  assert.ok(authenticated.requestsPerSecond > 50, `authenticated benchmark floor: ${authenticated.requestsPerSecond}`);
  assert.ok(registryReads.requestsPerSecond > 50, `registry benchmark floor: ${registryReads.requestsPerSecond}`);

  const evidence = {
    test: 'REST_API_LAYERED_BENCHMARK',
    note: 'Transport and registry benchmarks only; migration EXECUTION throughput is qualified by real-engine suites, not request-rate sampling.',
    timestamp: new Date().toISOString(),
    benchmarks: [transport, authenticated, registryReads]
  };
  await writeFile(
    join(process.cwd(), '.console-evidence', 'api-stress-results.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8'
  );
});
