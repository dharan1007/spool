import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, link } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform, release } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { createSpoolDaemon } from '../src/daemon/spoold.js';
import { markDisposableQualification } from '../src/platform/disposable-qualification.js';
import { PRODUCTION_POLICY } from '../src/platform/production-policy.js';

let assertions = 0;
let passed = true;
let disposableRowsWritten = 0;
let productionRowsWritten = 0;
const a = new Proxy(assert, { get(target, name) {
  const value = target[name];
  if (typeof value !== 'function') return value;
  return (...args) => {
    const result = value(...args);
    if (result instanceof Promise) return result.then(value => { assertions += 1; return value; });
    assertions += 1; return result;
  };
} });
function evidenceTest(name, fn) { test(name, async () => { try { await fn(); } catch (error) { passed = false; throw error; } }); }
const denial = error => error?.code === 'PRODUCTION_CAPABILITY_DENIED';
const token = 'policy-denial-0123456789abcdef0123456789abcdef';

async function fixture(qualification = false) {
  const root = await mkdtemp(join(tmpdir(), 'spool-policy-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const path = join(targetRoot, 'target.db');
  const source = join(sourceRoot, 'rows.csv');
  await writeFile(source, 'id,name\n1,Ada\n2,Lin\n');
  const db = new Database(path); db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT'); db.close();
  const options = { sourceRoot, targetRoot, statePath: join(root, 'state.db'), approvalSigningKey: 'policy-tests-0123456789abcdef', release: { version: PRODUCTION_POLICY.release, commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } };
  if (qualification) options.qualification = await markDisposableQualification(root);
  const service = await SpoolCommandService.create(options);
  const request = { migrationId: 'policy_test', principal: 'qualification:operator', planInput: {
    planRevision: 1, sourceRef: { connector: 'filesystem', connectionId: 's', resource: 'rows.csv', path: source },
    targetRef: { connector: 'sqlite', connectionId: 't', resource: 'rows', path, table: 'rows' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }, { target: 'name', expr: { op: 'field', name: 'name' } }],
    mappingRevision: 1, writeStrategy: { mode: 'insert', batchSize: 1 }, verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] }, capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
  } };
  return { root, path, options, request, service, async close() { service.close(); await rm(root, { recursive: true, force: true }); } };
}

evidenceTest('production permits only approved SQLite INSERT through the canonical lifecycle', async () => {
  const f = await fixture();
  try {
    a.equal(f.service.executionMode, 'PRODUCTION');
    a.equal((await f.service.inspect(f.request)).sourceRows, 2);
    await a.rejects(() => f.service.run(f.request), error => error.code === 'APPROVAL_REQUIRED');
    const approval = await f.service.approve(f.request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'production-proof' });
    const result = await f.service.run(f.request, { approval });
    a.equal(result.verification.status, 'VERIFIED');
    a.equal(result.receipt.record.counts.writtenRows, 2);
    a.equal(result.receipt.record.release.commitSha, f.options.release.commitSha);
    const db = new Database(f.path, { readonly: true });
    try {
      a.deepEqual(db.prepare('SELECT id,name FROM rows ORDER BY id').all(), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }]);
      a.equal(db.prepare('SELECT COUNT(*) AS n FROM __spool_batch_ledger').get().n, 2);
    } finally { db.close(); }
    productionRowsWritten += 2;
  } finally { await f.close(); }
});

evidenceTest('production denies every experimental target before discovery, approval or mutation', async () => {
  const f = await fixture();
  try {
    a.throws(() => f.service.targetConnectors, denial);
    a.throws(() => f.service.sourceCoordinator, denial);
    await a.rejects(() => SpoolCommandService.create({ ...f.options, maxSourceBytes: 257 * 1024 * 1024 }), denial);
    await a.rejects(() => SpoolCommandService.create({ ...f.options, release: { ...f.options.release, version: 'unmatched' } }), error => error.code === 'RELEASE_IDENTITY_REQUIRED');
    for (const connector of ['postgres', 'mysql', 'mssql', 'unknown']) {
      const request = structuredClone(f.request); request.planInput.targetRef.connector = connector;
      request.qualification = { allowExperimental: true }; request.planInput.targetRef.assurance = 'C4';
      for (const method of ['inspect', 'plan', 'dryRun', 'approve', 'run', 'approveRepair', 'runRepair', 'beginCutover', 'commitCutover']) await a.rejects(() => f.service[method](request), denial);
    }
    for (const mode of ['upsert', 'replace', 'delete', 'truncate']) {
      const request = structuredClone(f.request); request.planInput.writeStrategy.mode = mode;
      await a.rejects(() => f.service.inspect(request), denial);
    }
    const bulk = structuredClone(f.request); bulk.planInput.writeStrategy.bulk = true;
    await a.rejects(() => f.service.inspect(bulk), denial);
    for (const method of ['approveRepair', 'runRepair', 'beginCutover', 'commitCutover']) await a.rejects(() => f.service[method](f.request), denial);
    await a.rejects(() => f.service.abortCutover('policy_test'), denial);
    await a.rejects(() => f.service.setSnapshotCdcBinding('policy_test', {}), denial);
    await a.rejects(() => f.service.updateCdcProgress('policy_test', {}), denial);
    a.equal(f.service.status('policy_test'), null);
    a.equal(existsSync(f.options.statePath + '.snapshots'), false);
    const db = new Database(f.path, { readonly: true });
    try { a.equal(db.prepare('SELECT COUNT(*) AS n FROM rows').get().n, 0); a.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='__spool_batch_ledger'").get().n, 0); }
    finally { db.close(); }
  } finally { await f.close(); }
});

evidenceTest('authenticated HTTP cannot opt into experiments or bypass a production service', async () => {
  const f = await fixture(); const daemon = createSpoolDaemon({ service: f.service, token });
  try {
    f.request.planInput.targetRef.connector = 'postgres';
    const address = await daemon.listen(0);
    for (const command of ['inspect', 'plan', 'approve', 'run', 'approve-repair', 'run-repair', 'begin-cutover', 'commit-cutover', 'abort-cutover']) {
      const result = await fetch(`http://127.0.0.1:${address.port}/v1/command`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, request: f.request, migrationId: 'policy_test', options: { qualification: await markDisposableQualification(f.root), allowExperimental: true } }) });
      a.equal(result.status, 422); a.equal((await result.json()).error.code, 'PRODUCTION_CAPABILITY_DENIED');
    }
    a.throws(() => createSpoolDaemon({ service: { run() {} }, token }), error => error.code === 'POLICY_INTEGRITY_FAILED');
  } finally { await daemon.close(); await f.close(); }
});

evidenceTest('released CLI denies production invocation despite test-mode environment names', async () => {
  const f = await fixture();
  try {
    f.request.planInput.targetRef.connector = 'postgres';
    const requestPath = join(f.root, 'request.json'); await writeFile(requestPath, JSON.stringify(f.request));
    const run = spawnSync(process.execPath, ['src/cli/spool.js', 'inspect', '--request', requestPath, '--source-root', f.options.sourceRoot, '--target-root', f.options.targetRoot, '--state', f.options.statePath], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SPOOL_ALLOW_EXPERIMENTAL: '1', SPOOL_APPROVAL_KEY: f.options.approvalSigningKey, SPOOL_COMMIT_SHA: f.options.release.commitSha }
    });
    a.equal(run.status, 1); a.equal(JSON.parse(run.stderr).error.code, 'PRODUCTION_CAPABILITY_DENIED');
  } finally { await f.close(); }
});

evidenceTest('affirmative marked qualification permits a real disposable SQLite lifecycle and rejects marker drift', async () => {
  const f = await fixture(true);
  try {
    a.equal(f.service.executionMode, 'DISPOSABLE_QUALIFICATION');
    a.equal((await f.service.inspect(f.request)).sourceRows, 2);
    const approval = await f.service.approve(f.request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'policy-proof' });
    const result = await f.service.run(f.request, { approval });
    a.equal(result.verification.status, 'VERIFIED'); a.equal(result.receipt.record.counts.writtenRows, 2);
    disposableRowsWritten += result.receipt.record.counts.writtenRows;
    await writeFile(join(f.root, '.spool-qualification.json'), '{}');
    await a.rejects(() => f.service.inspect(f.request), error => error.code === 'QUALIFICATION_ROOT_INVALID');
  } finally { await f.close(); }
});

evidenceTest('qualification rejects missing opt-in, a different run binding and filesystem aliases', async () => {
  const f = await fixture(true);
  const other = await mkdtemp(join(tmpdir(), 'spool-policy-outside-'));
  try {
    for (const qualification of [
      { ...f.options.qualification, allowExperimental: false },
      { ...f.options.qualification, runId: '00000000-0000-4000-8000-000000000000' },
      { ...f.options.qualification, root: other }
    ]) await a.rejects(() => SpoolCommandService.create({ ...f.options, qualification }), error => error.code === 'QUALIFICATION_ROOT_INVALID');
    const outsideSource = join(other, 'outside.csv'); await writeFile(outsideSource, 'id,name\n3,Outside\n');
    const alias = join(f.options.sourceRoot, 'alias.csv'); await link(outsideSource, alias);
    const request = structuredClone(f.request); request.planInput.sourceRef.path = alias;
    await a.rejects(() => f.service.inspect(request), error => error.code === 'QUALIFICATION_ROOT_INVALID');
  } finally { await f.close(); await rm(other, { recursive: true, force: true }); }
});

evidenceTest('run-bound qualification is checked again before each real target batch', async () => {
  const f = await fixture(true);
  try {
    const approval = await f.service.approve(f.request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'drift-proof' });
    const store = f.service.runs.checkpointStore.bind(f.service.runs);
    f.service.runs.checkpointStore = migrationId => {
      const original = store(migrationId);
      return { ...original, async save(value) {
        await original.save(value);
        await writeFile(join(f.root, '.spool-qualification.json'), '{}');
      } };
    };
    await a.rejects(() => f.service.run(f.request, { approval }), error => error.code === 'QUALIFICATION_ROOT_INVALID');
    const db = new Database(f.path, { readonly: true });
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM rows').get().n;
      a.equal(count, 1); disposableRowsWritten += count;
      a.equal(db.prepare('SELECT COUNT(*) AS n FROM __spool_batch_ledger').get().n, 1);
    } finally { db.close(); }
    a.equal(f.service.status('policy_test').status, 'FAILED');
    a.throws(() => f.service.receipt('policy_test'), error => error.code === 'RECEIPT_NOT_AVAILABLE');
  } finally { await f.close(); }
});

evidenceTest('missing, corrupt, changed or version-stale packaged policy fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-policy-package-'));
  try {
    await mkdir(join(root, 'src', 'platform'), { recursive: true }); await mkdir(join(root, 'src', 'core')); await mkdir(join(root, 'capabilities'));
    for (const path of ['src/platform/production-policy.js', 'src/core/errors.js', 'capabilities/matrix.json', 'package.json']) await copyFile(path, join(root, path));
    const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', 'const {verifyProductionPolicy}=await import(process.env.POLICY_TEST_MODULE); verifyProductionPolicy();'], { cwd: root, encoding: 'utf8', env: { ...process.env, POLICY_TEST_MODULE: pathToFileURL(join(root, 'src/platform/production-policy.js')).href } });
    a.equal(invoke().status, 0);
    const original = await readFile(join(root, 'capabilities/matrix.json'));
    for (const bytes of ['{bad JSON', original.toString().replace('EXPERIMENTAL', 'PRODUCTION')]) {
      await writeFile(join(root, 'capabilities/matrix.json'), bytes);
      const run = invoke(); a.equal(run.status, 1); a.match(run.stderr, /POLICY_INTEGRITY_FAILED/);
    }
    await rm(join(root, 'capabilities/matrix.json'));
    a.equal(invoke().status, 1);
    await writeFile(join(root, 'capabilities/matrix.json'), original);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.version = 'stale'; await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    const stale = invoke(); a.equal(stale.status, 1); a.match(stale.stderr, /POLICY_INTEGRITY_FAILED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

after(() => {
  if (!passed || assertions === 0) return;
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) return;
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  process.stdout.write('SPOOL_EVIDENCE_JSON=' + JSON.stringify({ surface: 'production_denial', status: 'PASS', commitSha, actualExecution: true, assertions, device: { platform: platform(), os: release(), node: process.version }, workload: { targetsDenied: 4, disposableRowsWritten, productionTargetRowsWritten: productionRowsWritten } }) + '\n');
});
