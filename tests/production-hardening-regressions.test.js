import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { buildAutopilotPlan } from '../src/core/autopilot.js';
import { CommandKernel } from '../src/core/command-kernel.js';
import { MemoryWorkspaceStore } from '../src/storage/memory-store.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseTag = `v${packageJson.version}`;

function kernelWithWorkspace() {
  const workspaceStore = new MemoryWorkspaceStore();
  const kernel = new CommandKernel({ workspaceStore });
  return { kernel, workspaceStore };
}

test('database-ready classifies timezone-less ISO timestamps as local_datetime instead of instant/date', () => {
  const source = {
    schema: [
      { name: 'created_at', type: 'string', nullable: false, confidence: 1 }
    ],
    sampleRows: [
      { created_at: '2026-09-07T11:48:01.000' },
      { created_at: '2026-09-07T12:49:02.125' },
      { created_at: '2026-09-08T09:01:03.999' }
    ]
  };
  const plan = buildAutopilotPlan(source, { objective: 'database_ready' });
  assert.equal(plan.targetSchema[0].type, 'local_datetime');
  assert.equal(plan.mapping[0].expr.op, 'parse_local_datetime');
});

test('database-ready derives nullability from the full parsed source, not only the inference window', () => {
  const rows = [];
  for (let i = 0; i < 1000; i += 1) rows.push({ count: String(i + 1) });
  rows.push({ count: '' });
  const source = {
    schema: [{ name: 'count', type: 'integer', nullable: false, confidence: 1 }],
    sampleRows: rows
  };
  const plan = buildAutopilotPlan(source, { objective: 'database_ready' });
  assert.equal(plan.targetSchema[0].nullable, true);
});

test('nullable typed casts preserve empty CSV cells as null instead of inventing zero or rejecting them', async () => {
  const { kernel } = kernelWithWorkspace();
  await kernel.execute('load_demo', { rows: 1 });
  kernel.workspace.source = {
    filename: 'nullable.csv',
    bytes: 20,
    fingerprint: 'sha256:test',
    schema: [{ name: 'count', type: 'integer', nullable: true, confidence: 1 }],
    rows: [{ count: '' }]
  };
  const result = await kernel.execute('run_autopilot', { objective: 'database_ready' });
  assert.notEqual(result.mission?.status, 'NEEDS_ATTENTION');
});

test('WebMCP target schema exposes local_datetime as the timezone-free temporal type', async () => {
  const source = await readFile(new URL('../src/webmcp.js', import.meta.url), 'utf8');
  assert.match(source, /local_datetime/);
});

test('preserve-contract keeps CSV values lossless as nullable strings regardless of sampled inference', () => {
  const source = {
    schema: [
      { name: 'id', type: 'integer', nullable: false, confidence: 1 },
      { name: 'created_at', type: 'date', nullable: false, confidence: 1 }
    ],
    sampleRows: [
      { id: '001', created_at: '2026-09-07T11:48:01.000' },
      { id: '', created_at: '' }
    ]
  };
  const plan = buildAutopilotPlan(source, { objective: 'preserve_contract' });
  assert.deepEqual(plan.targetSchema, [
    { name: 'id', type: 'string', nullable: true },
    { name: 'created_at', type: 'string', nullable: true }
  ]);
  assert.deepEqual(plan.mapping.map(item => item.expr.op), ['copy', 'copy']);
});

test('Autopilot dry-run hard-stops before runtime when the proposed contract accepts zero preview rows', async () => {
  const { kernel } = kernelWithWorkspace();
  kernel.workspace = {
    version: 1,
    phase: 'SOURCE_READY',
    source: {
      filename: 'bad.csv',
      bytes: 100,
      fingerprint: 'sha256:bad',
      schema: [{ name: 'amount', type: 'string', nullable: false, confidence: 1 }],
      rows: Array.from({ length: 20 }, (_, index) => ({ amount: `not-a-number-${index}` }))
    },
    targetSchema: null,
    mapping: null,
    mappingRevision: 0,
    currentJob: null,
    checkpoint: null,
    output: null,
    violations: [],
    mission: null,
    storageEstimate: null
  };
  const result = await kernel.execute('run_autopilot', { objective: 'database_ready' });
  assert.equal(result.mission.status, 'NEEDS_ATTENTION');
  assert.equal(result.mission.ambiguity.code, 'DRY_RUN_ZERO_ACCEPTANCE');
  assert.equal(kernel.workspace.phase, 'SOURCE_READY');
  assert.equal(kernel.runtime.running, false);
});

test('Autopilot dry-run samples across the full source and blocks below the 95% acceptance floor', async () => {
  const { kernel } = kernelWithWorkspace();
  const rows = Array.from({ length: 200 }, (_, index) => ({ value: index < 180 ? String(index) : `bad-${index}` }));
  kernel.workspace = {
    version: 1,
    phase: 'SOURCE_READY',
    source: {
      filename: 'mixed.csv',
      bytes: 1000,
      fingerprint: 'sha256:mixed',
      schema: [{ name: 'value', type: 'integer', nullable: false, confidence: 0.9 }],
      rows
    },
    targetSchema: null,
    mapping: null,
    mappingRevision: 0,
    currentJob: null,
    checkpoint: null,
    output: null,
    violations: [],
    mission: null,
    storageEstimate: null
  };
  const result = await kernel.execute('run_autopilot', { objective: 'database_ready' });
  assert.equal(result.mission.status, 'NEEDS_ATTENTION');
  assert.equal(result.mission.ambiguity.code, 'DRY_RUN_ACCEPTANCE_BELOW_THRESHOLD');
  assert.equal(kernel.workspace.phase, 'SOURCE_READY');
});

test('local command service honors its configured source ceiling above the 50 MiB browser parser default', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-large-source-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'large.csv');
  const targetPath = join(targetRoot, 'large.db');
  const rowCount = 55_000;
  const payload = 'x'.repeat(1000);
  let csv = 'id,payload\n';
  for (let i = 0; i < rowCount; i += 1) csv += `${i},${payload}\n`;
  await writeFile(sourcePath, csv, 'utf8');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE large (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    maxSourceBytes: 64 * 1024 * 1024,
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.0.0-test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try {
    const request = {
      migrationId: 'large_source_001',
      principal: 'operator:test',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'large.csv', path: sourcePath },
        targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'large', path: targetPath, table: 'large' },
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'payload', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'payload', expr: { op: 'copy', value: { op: 'field', name: 'payload' } } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: 1000 },
        verification: { checks: ['row_accounting', 'ledger_complete'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
      }
    };
    const inspected = await service.inspect(request);
    assert.equal(inspected.sourceRows, rowCount);
    assert.equal(inspected.maxSourceBytes, 64 * 1024 * 1024);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('strict production CSP has no inline style attributes in the application render source', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\sstyle\s*=\s*["']/i);
});

test('deployed Local Runner page contains a complete copyable CLI path for real device use', async () => {
  const surface = await readFile(new URL('../src/product-surface.js', import.meta.url), 'utf8');
  for (const required of [
    `npm install -g github:dharan1007/spool#${releaseTag}`,
    'spool --help',
    'SPOOL_APPROVAL_KEY',
    'spool inspect',
    'spool dry-run',
    'spool approve',
    'spool run',
    'spool verify',
    'spool receipt',
    'migration.json'
  ]) assert.match(surface, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Hobby deployment surface does not advertise paid commercial transactions', async () => {
  const surface = await readFile(new URL('../src/product-surface.js', import.meta.url), 'utf8');
  assert.doesNotMatch(surface, /Pay for a migration|Launch test range|Request a Migration Assessment/);
});
