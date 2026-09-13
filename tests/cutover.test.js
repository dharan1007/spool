import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

function requestFor(sourcePath, targetPath, migrationId, mapping = null) {
  return {
    migrationId,
    principal: 'operator:cutover',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'rows.csv', path: sourcePath },
      targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'rows', path: targetPath, table: 'rows' },
      targetSchema: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false }
      ],
      mapping: mapping ?? [
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
  const dir = await mkdtemp(join(tmpdir(), 'spool-cutover-'));
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
  const options = {
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir: join(dir, 'snapshots'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-cutover-test', commitSha: '7123456789abcdef0123456789abcdef01234567' }
  };
  const service = await SpoolCommandService.create(options);
  return { dir, sourcePath, targetPath, options, service };
}

async function completeMigration(service, sourcePath, targetPath, migrationId) {
  const request = requestFor(sourcePath, targetPath, migrationId);
  const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: `cutover-${migrationId}` });
  const result = await service.run(request, { approval });
  assert.equal(result.status, 'COMPLETE');
  return { request, receipt: result.receipt };
}

test('cutover arms on the recorded receipt and commits with fenced contract evidence', async () => {
  const f = await fixture();
  try {
    const { request, receipt } = await completeMigration(f.service, f.sourcePath, f.targetPath, 'cutover_happy');
    await assert.rejects(
      () => f.service.beginCutover(request, { receipt: { receiptId: receipt.receiptId, record: { ...receipt.record, migrationId: 'other' } } }),
      error => error?.code === 'CUTOVER_RECEIPT_MISMATCH'
    );
    const armed = await f.service.beginCutover(request, { receipt });
    assert.equal(armed.status, 'ARMED');
    assert.equal(armed.receiptKind, 'migration');
    assert.equal(armed.receiptId, receipt.receiptId);
    assert.equal(armed.targetContractId, receipt.record.targetContractId);

    const committed = await f.service.commitCutover(request);
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(committed.commitEvidence.fenced, true);
    assert.equal(typeof committed.commitEvidence.fencingToken, 'number');
    assert.match(committed.commitEvidence.leaseResource, /^sqlite:/);
    assert.equal(committed.commitEvidence.targetContractId, receipt.record.targetContractId);

    await assert.rejects(() => f.service.run(request, {}), error => error?.code === 'CUTOVER_ALREADY_COMMITTED');
    await assert.rejects(
      () => f.service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'frozen' }),
      error => error?.code === 'CUTOVER_ALREADY_COMMITTED'
    );
    await assert.rejects(
      () => f.service.abortCutover('cutover_happy', { reason: 'too late' }),
      error => error?.code === 'CUTOVER_ALREADY_COMMITTED'
    );
    assert.equal(f.service.cutover('cutover_happy').status, 'COMMITTED');
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('cutover aborts with a reason, re-arms and survives restart', async () => {
  const f = await fixture();
  try {
    const { request, receipt } = await completeMigration(f.service, f.sourcePath, f.targetPath, 'cutover_abort');
    await f.service.beginCutover(request, { receipt });
    const aborted = await f.service.abortCutover('cutover_abort', { reason: 'deploy window moved' });
    assert.equal(aborted.status, 'ABORTED');
    assert.equal(aborted.abortReason, 'deploy window moved');
    await assert.rejects(() => f.service.commitCutover(request), error => error?.code === 'CUTOVER_NOT_ARMED');

    await f.service.beginCutover(request, { receipt });
    const committed = await f.service.commitCutover(request);
    assert.equal(committed.status, 'COMMITTED');

    f.service.close();
    const reopened = await SpoolCommandService.create(f.options);
    try {
      assert.equal(reopened.cutover('cutover_abort').status, 'COMMITTED');
    } finally {
      reopened.close();
    }
    f.service = await SpoolCommandService.create(f.options);
  } finally {
    try { f.service.close(); } catch {}
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('cutover commit refuses changed plans and changed target contracts', async () => {
  const f = await fixture();
  try {
    const { request, receipt } = await completeMigration(f.service, f.sourcePath, f.targetPath, 'cutover_drift');
    await f.service.beginCutover(request, { receipt });

    const changedBatch = requestFor(f.sourcePath, f.targetPath, 'cutover_drift');
    changedBatch.planInput.writeStrategy = { mode: 'insert', batchSize: 4 };
    await assert.rejects(
      () => f.service.commitCutover(changedBatch),
      error => error?.code === 'CUTOVER_PLAN_CHANGED'
    );

    const db = new Database(f.targetPath);
    db.exec('ALTER TABLE rows ADD COLUMN nick TEXT;');
    db.close();
    await assert.rejects(
      () => f.service.commitCutover(request),
      error => error?.code === 'CUTOVER_CONTRACT_CHANGED'
    );
    assert.equal(f.service.cutover('cutover_drift').status, 'ARMED');
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('cutover arms on a recorded repair receipt for repaired runs', async () => {
  const f = await fixture();
  const migrationId = 'cutover_repaired';
  try {
    const repairReceipt = {
      receiptId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      record: {
        migrationId,
        planId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sourceSnapshotId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'rows' },
        targetContractId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      }
    };
    f.service.runs.start({
      migrationId, planId: repairReceipt.record.planId, sourceSnapshotId: repairReceipt.record.sourceSnapshotId,
      targetIdentity: repairReceipt.record.targetIdentity, startedAt: '2026-09-13T00:00:00.000Z'
    });
    f.service.runs.completeRepair({
      migrationId,
      repair: { repairPlanIds: [], receipt: repairReceipt },
      completedAt: '2026-09-13T00:01:00.000Z'
    });
    const request = requestFor(f.sourcePath, f.targetPath, migrationId);
    const armed = await f.service.beginCutover(request, { receipt: repairReceipt });
    assert.equal(armed.status, 'ARMED');
    assert.equal(armed.receiptKind, 'repair');
  } finally {
    f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
