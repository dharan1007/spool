import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { planAutopilot } from '../src/core/autopilot.js';
import { CommandKernel } from '../src/core/command-kernel.js';
import { evaluateExpr } from '../src/core/transforms.js';
import { MemoryWorkspaceStore } from '../src/storage/memory.js';
import { PHASES } from '../src/core/state-machine.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { toolDefinitionForName } from '../src/webmcp/registry.js';

class ControlledRuntime {
  constructor() { this.startCalls = []; }
  async start(payload, handlers) { this.startCalls.push({ payload, handlers }); }
  async pause() {}
  async abort() {}
}

test('database-ready classifies timezone-less ISO timestamps as local_datetime instead of instant/date', () => {
  const sourceSchema = [{ name: 'created_at', type: 'string', nullable: false }];
  const rows = Array.from({ length: 20 }, (_, i) => ({
    created_at: `2026-09-${String((i % 9) + 1).padStart(2, '0')}T11:48:01.000`
  }));
  const plan = planAutopilot({ sourceSchema, rows, outcome: 'database_ready' });
  assert.equal(plan.needsAttention, false);
  assert.equal(plan.targetSchema[0].type, 'local_datetime');
  assert.equal(plan.mapping[0].expr.op, 'parse_local_datetime');
});

test('database-ready derives nullability from the full parsed source, not only the inference window', () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ created_at: i === 1200 ? '' : '2026-09-07T11:48:01.000' }));
  const plan = planAutopilot({
    sourceSchema: [{ name: 'created_at', type: 'string', nullable: false }],
    rows,
    outcome: 'database_ready'
  });
  assert.equal(plan.targetSchema[0].type, 'local_datetime');
  assert.equal(plan.targetSchema[0].nullable, true);
});

test('nullable typed casts preserve empty CSV cells as null instead of inventing zero or rejecting them', () => {
  assert.equal(evaluateExpr({ op: 'cast_number', value: { op: 'literal', value: '' } }, {}), null);
  assert.equal(evaluateExpr({ op: 'cast_boolean', value: { op: 'literal', value: '   ' } }, {}), null);
});

test('WebMCP target schema exposes local_datetime as the timezone-free temporal type', () => {
  const definition = toolDefinitionForName('define_target_schema');
  const types = definition.inputSchema.properties.fields.items.properties.type.enum;
  assert.ok(types.includes('local_datetime'));
});

test('preserve-contract keeps CSV values lossless as nullable strings regardless of sampled inference', () => {
  const plan = planAutopilot({
    sourceSchema: [
      { name: 'Created Date', type: 'date', nullable: false },
      { name: 'Amount', type: 'number', nullable: false }
    ],
    rows: [
      { 'Created Date': '2026-09-07T11:48:01.000', Amount: '10.50' },
      { 'Created Date': '', Amount: '' }
    ],
    outcome: 'preserve_contract'
  });
  assert.deepEqual(plan.targetSchema, [
    { name: 'Created Date', type: 'string', nullable: true },
    { name: 'Amount', type: 'string', nullable: true }
  ]);
  assert.deepEqual(plan.mapping.map(entry => entry.expr.op), ['copy', 'copy']);
});

test('Autopilot dry-run hard-stops before runtime when the proposed contract accepts zero preview rows', async () => {
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime });
  await kernel.initialize();
  const rows = Array.from({ length: 100 }, (_, i) => `${i + 1},not-a-date`);
  await kernel.loadSourceText(`id,created_at\n${rows.join('\n')}`, 'invalid-dates.csv');

  kernel.workspace.source.schema = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'created_at', type: 'date', nullable: false }
  ];

  const result = await kernel.invoke('run_autopilot', { outcome: 'clean_standardize' });
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, PHASES.SOURCE_READY);
  assert.equal(result.result.status, 'NEEDS_ATTENTION');
  assert.equal(runtime.startCalls.length, 0);
  assert.equal(kernel.snapshot().mission.status, 'NEEDS_ATTENTION');
  assert.equal(kernel.snapshot().mission.dryRun.validRows, 0);
  assert.equal(kernel.snapshot().mission.dryRun.invalidRows, 100);
});

test('Autopilot dry-run samples across the full source and blocks below the 95% acceptance floor', async () => {
  const runtime = new ControlledRuntime();
  const kernel = new CommandKernel({ store: new MemoryWorkspaceStore(), runtime });
  await kernel.initialize();
  const rows = Array.from({ length: 1000 }, (_, i) => `${i + 1},${i >= 500 && i < 560 ? 'not-a-date' : '2026-09-07'}`);
  await kernel.loadSourceText(`id,created_at\n${rows.join('\n')}`, 'late-drift.csv');
  kernel.workspace.source.schema = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'created_at', type: 'date', nullable: false }
  ];

  const result = await kernel.invoke('run_autopilot', { outcome: 'clean_standardize' });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'NEEDS_ATTENTION');
  assert.equal(result.result.reason, 'DRY_RUN_ACCEPTANCE_BELOW_THRESHOLD');
  assert.equal(runtime.startCalls.length, 0);
  assert.equal(kernel.snapshot().mission.dryRun.processedRows, 100);
  assert.equal(kernel.snapshot().mission.dryRun.assessment, 'BLOCK');
  assert.ok(kernel.snapshot().mission.dryRun.acceptanceRate < 0.95);
});

test('local command service honors its configured source ceiling above the 50 MiB browser parser default', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-large-limit-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'large.csv');
  const targetPath = join(targetRoot, 'large.db');
  const payload = 'x'.repeat(1000);
  const rowCount = 55_000;
  const csv = `id,payload\n${Array.from({ length: rowCount }, (_, i) => `${i + 1},${payload}`).join('\n')}\n`;
  assert.ok(Buffer.byteLength(csv) > 50 * 1024 * 1024);
  assert.ok(Buffer.byteLength(csv) < 64 * 1024 * 1024);
  await writeFile(sourcePath, csv);
  const db = new Database(targetPath);
  db.exec('CREATE TABLE target_rows (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT;');
  db.close();

  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    maxSourceBytes: 64 * 1024 * 1024,
    release: { version: '1.0.0-test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try {
    const request = {
      migrationId: 'mig_large_parser_limit',
      principal: 'operator:test',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'large.csv', path: sourcePath },
        targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'target_rows', path: targetPath, table: 'target_rows' },
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'payload', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'payload', expr: { op: 'copy', name: 'payload' } }
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
    'npm install -g github:dharan1007/spool#v1.0.0',
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