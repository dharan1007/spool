import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { createRepairApproval } from '../src/platform/repair-approval.js';

const PLAN_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SNAPSHOT_ID = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REPAIR_PLAN_ID = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function requestFor(sourcePath, targetPath, migrationId) {
  return {
    migrationId,
    principal: 'operator:repair-refusal',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: sourcePath },
      targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'rows', path: targetPath, table: 'rows' },
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: [
        { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
        { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }
      ],
      mappingRevision: 1,
      writeStrategy: { mode: 'insert', batchSize: 2 },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
      }
    }
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-repair-refusal-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-repair-test', commitSha: '5123456789abcdef0123456789abcdef01234567' }
  });
  return { dir, sourcePath, targetPath, service };
}

function seedFailedRun(service, migrationId) {
  service.runs.start({
    migrationId, planId: PLAN_ID, sourceSnapshotId: SNAPSHOT_ID,
    targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'rows' },
    startedAt: '2026-09-13T00:00:00.000Z'
  });
  service.runs.verificationFailed({ migrationId, verification: { status: 'DIFF' } });
  service.runs.saveVerificationBatch({
    migrationId, ordinal: 0, sourceRange: { start: 0, endExclusive: 2 },
    verification: { status: 'DIFF' },
    repair: { schemaVersion: 1, repairPlanId: REPAIR_PLAN_ID, operations: [] }
  });
}

test('repair approval requires a failed run and refuses completed runs', async () => {
  const f = await fixture();
  try {
    const missing = requestFor(f.sourcePath, f.targetPath, 'repair_unknown_run');
    await assert.rejects(
      () => f.service.approveRepair(missing, { repairPlanIds: [REPAIR_PLAN_ID], expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'n1' }),
      error => error?.code === 'REPAIR_NOT_REQUIRED'
    );

    const request = requestFor(f.sourcePath, f.targetPath, 'repair_completed_run');
    const approval = await f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'complete-then-repair' });
    const result = await f.service.run(request, { approval });
    assert.equal(result.status, 'COMPLETE');
    await assert.rejects(
      () => f.service.approveRepair(request, { repairPlanIds: [REPAIR_PLAN_ID], expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'n2' }),
      error => error?.code === 'REPAIR_NOT_REQUIRED'
    );
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('repair execution requires a separately-authorized repair approval', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'repair_no_approval');
    seedFailedRun(f.service, 'repair_no_approval');
    await assert.rejects(
      () => f.service.runRepair(request, {}),
      error => error?.code === 'REPAIR_APPROVAL_REQUIRED'
    );
    assert.equal(f.service.status('repair_no_approval').status, 'VERIFICATION_FAILED');
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a migration approval can never authorize repair execution', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'repair_migration_approval');
    seedFailedRun(f.service, 'repair_migration_approval');
    const migrationApproval = await f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'migration-approval-repair' });
    await assert.rejects(
      () => f.service.runRepair(request, { repairApproval: migrationApproval }),
      error => error?.code === 'INVALID_REPAIR_APPROVAL'
    );
    const run = f.service.status('repair_migration_approval');
    assert.equal(run.status, 'VERIFICATION_FAILED');
    assert.equal(run.repair, null);
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('repair execution fails closed when the target connector cannot execute fenced repair', async () => {
  const f = await fixture();
  try {
    const request = requestFor(f.sourcePath, f.targetPath, 'repair_unsupported_target');
    seedFailedRun(f.service, 'repair_unsupported_target');
    const inspected = await f.service.inspect(request);
    const plan = await f.service.plan(request);
    const repairApproval = createRepairApproval({
      migrationId: 'repair_unsupported_target',
      repairPlanIds: [REPAIR_PLAN_ID],
      planId: plan.planId,
      sourceSnapshotId: inspected.sourceSnapshotId,
      targetIdentity: plan.targetRef,
      targetContractId: inspected.targetContractId,
      effects: ['sqlite:apply_repair', 'sqlite:read_after_write_verify'],
      principal: 'operator:repair-refusal',
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'sqlite-repair'
    }, { signingKey: '0123456789abcdef0123456789abcdef' });
    await assert.rejects(
      () => f.service.runRepair(request, { repairApproval }),
      error => error?.code === 'REPAIR_CAPABILITY_REQUIRED'
    );
    assert.equal(f.service.status('repair_unsupported_target').status, 'VERIFICATION_FAILED');
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
