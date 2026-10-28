#!/usr/bin/env node
import { fork, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, statfs, stat, readdir, realpath, appendFile, open } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve, sep } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';
import { markDisposableQualification } from '../src/platform/disposable-qualification.js';
import { secureSnapshotPath, verifySnapshotPrivacy } from '../src/connectors/snapshot-permissions.js';
import { sha256Canonical } from '../src/platform/canonical-json.js';
import { LeaseStore } from '../src/execution/lease-store.js';
import { createBoundApproval } from '../src/platform/approval.js';
import { readResourceSummary } from '../src/platform/measurement-evidence.js';

const MiB = 1024 * 1024;
const LIMIT = 256 * MiB;
const SELF = fileURLToPath(import.meta.url);
const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let assertions = 0;
let measurementRootsFile = null;
const measurementRoots = [];
function check(value, message) { if (!value) throw new Error(message); assertions++; }
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function reserve(path) {
  const disk = await statfs(path, { bigint: true });
  const free = disk.bavail * disk.bsize;
  check(free >= 10n * 1024n ** 3n, `SQLite qualifier requires >=10 GiB free: ${free} bytes available`);
  return String(free);
}
const nameFor = (id, last = false) => `User-${String(id).padStart(8, '0')}-` + 'x'.repeat(last ? 992 : 1000);

async function generate(path) {
  const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const closed = once(stream, 'close');
  const write = async bytes => { if (!stream.write(bytes)) await once(stream, 'drain'); };
  try {
    await write('id,name\n');
    for (let id = 1; id <= 262144; id++) {
      const value = id % 10000 === 0 ? 'BAD_____' : String(id).padStart(8, '0');
      await write(`${value},${nameFor(id, id === 262144)}\n`);
    }
  } finally { stream.end(); await closed; }
  check((await stat(path)).size === LIMIT, 'Generated source must be exactly 256 MiB');
}

function request(ctx, batchSize = 10000) {
  return { migrationId: ctx.id, principal: 'operator:sqlite-qualification', planInput: {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'source.csv', path: ctx.source },
    targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'rows', path: ctx.target, table: 'rows' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
      { target: 'name', expr: { op: 'trim', value: { op: 'field', name: 'name' } } }],
    mappingRevision: 1, writeStrategy: { mode: 'insert', batchSize },
    verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] },
    capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
  } };
}

async function serviceFor(ctx) {
  check(ctx.commitSha === sha(), 'Child source SHA changed');
  const root = await realpath(ctx.root);
  const marker = JSON.parse(await readFile(join(root, '.spool-qualification.json'), 'utf8'));
  check(marker.root === root && marker.runId === ctx.qualification.runId && marker.purpose === 'spool-disposable-qualification-v1', 'Disposable identity marker mismatch');
  for (const path of [ctx.source, ctx.target, ctx.state, ctx.snapshots]) check(resolve(path).startsWith(root + sep), 'Fixture path escaped disposable root');
  const service = await SpoolCommandService.create({ qualification: ctx.qualification, sourceRoot: root, targetRoot: root,
    statePath: ctx.state, snapshotDir: ctx.snapshots, approvalSigningKey: ctx.key,
    release: { version: ctx.version, commitSha: ctx.commitSha } });
  check(service.executionMode === 'DISPOSABLE_QUALIFICATION', 'Fault injection requires explicit disposable mode');
  return service;
}

async function child(ctxPath, mode) {
  const ctx = JSON.parse(await readFile(ctxPath, 'utf8'));
  const service = await serviceFor(ctx);
  let heapPeak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, 100);
  const began = performance.now();
  let newestFence = 0;
  try {
    const input = request(ctx, mode === 'sustain' ? 10000 : 2);
    const approval = JSON.parse(await readFile(ctx.approval, 'utf8'));
    if (mode.startsWith('kill_') || mode === 'restart') {
      const registry = service.targetConnectors;
      const registration = registry.registrations.get('target:sqlite');
      registry.registrations.set('target:sqlite', { ...registration, factory: async args => {
        const runtime = await registration.factory(args);
        const create = runtime.createExecution.bind(runtime);
        runtime.createExecution = async args2 => {
          const execution = await create(args2);
          execution.leaseTtlMs = 1000; // Explicit disposable fault configuration only.
          const renew = execution.renewLease.bind(execution);
          execution.renewLease = (...values) => {
            const lease = renew(...values); newestFence = Math.max(newestFence, lease.fencingToken); return lease;
          };
          if (mode === 'kill_before_target_commit') {
            const openTarget = execution.openTarget.bind(execution);
            execution.openTarget = () => {
              const target = openTarget();
              target.commitBatch = async () => {
                process.send({ barrier: mode, checkpoint: 0 });
                await new Promise(() => {});
              };
              return target;
            };
          }
          return execution;
        };
        return runtime;
      } });
      if (mode === 'kill_before_checkpoint' || mode === 'kill_after_checkpoint') {
      const original = service.runs.checkpointStore.bind(service.runs);
      service.runs.checkpointStore = id => {
        const store = original(id);
        return { load: store.load, save: async checkpoint => {
          if (mode === 'kill_after_checkpoint') await store.save(checkpoint);
          process.send({ barrier: mode, checkpoint: checkpoint.nextOffset });
          await new Promise(() => {}); // Parent forcibly terminates this exact child.
        } };
      };
      }
    }
    const result = await service.run(input, { approval });
    check(result.status === 'COMPLETE' && result.verification.status === 'VERIFIED', 'Run did not verify');
    const counts = result.receipt.record.counts;
    const rows = mode === 'sustain' ? 262144 : 5;
    const rejected = mode === 'sustain' ? 26 : 0;
    check(counts.sourceRows === rows && counts.writtenRows === rows - rejected && counts.rejectedRows === rejected && counts.filteredRows === 0, 'Receipt accounting differs from independent corpus');
    check(result.receipt.receiptId === sha256Canonical('spool-migration-receipt-v1', result.receipt.record), 'Receipt integrity failed');
    check(result.receipt.record.release.commitSha === ctx.commitSha, 'Receipt SHA mismatch');
    const altered = structuredClone(result.receipt.record); altered.counts.writtenRows--;
    check(result.receipt.receiptId !== sha256Canonical('spool-migration-receipt-v1', altered), 'Receipt tampering was not detected');
    await writeFile(join(ctx.root, 'receipt.json'), JSON.stringify(result.receipt, null, 2));
    const db = new Database(ctx.target, { readonly: true });
    try {
      check(db.prepare('SELECT count(*) AS n FROM rows').get().n === rows - rejected, 'Actual target cardinality mismatch');
      check(db.prepare('SELECT count(*) AS n FROM __spool_batch_ledger').get().n === Math.ceil(rows / input.planInput.writeStrategy.batchSize), 'Actual atomic ledger cardinality mismatch');
      if (mode === 'sustain') {
        let expected = 1;
        for (const row of db.prepare('SELECT id,name FROM rows ORDER BY id').iterate()) {
          while (expected % 10000 === 0) expected++;
          check(row.id === expected && row.name === nameFor(expected, expected === 262144), 'Actual target content differs from deterministic source');
          expected++;
        }
        check(expected === 262145, 'Target content verification ended early');
      }
    } finally { db.close(); }
    check((await service.run(input, { approval })).receipt.receiptId === result.receipt.receiptId, 'Idempotent retry changed terminal receipt');
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    const usage = process.resourceUsage();
    process.send({ done: true, assertions, counts, receiptId: result.receipt.receiptId, newestFence,
      metrics: { wallMs: performance.now() - began, sampledNodeHeapPeakBytes: heapPeak, osReportedNodeMaxRssKiB: usage.maxRSS,
        userCpuMicroseconds: usage.userCPUTime, systemCpuMicroseconds: usage.systemCPUTime } });
  } finally { clearInterval(timer); service.close(); }
}

async function fixture(id, large, identity) {
  await reserve(tmpdir());
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-release-'));
  const qualification = await markDisposableQualification(root);
  await secureSnapshotPath(root, { directory: true });
  if (measurementRootsFile) {
    measurementRoots.push(root);
    await writeFile(measurementRootsFile, JSON.stringify(measurementRoots));
  }
  const ctx = { root, qualification, id, ...identity, key: randomBytes(32).toString('hex'), source: join(root, 'source.csv'),
    target: join(root, 'target.db'), state: join(root, 'state.db'), snapshots: join(root, 'snapshots'), approval: join(root, 'approval.json') };
  if (large) await generate(ctx.source);
  else await writeFile(ctx.source, id === 'bounded_full' ? 'id,name\n' + Array.from({ length: 5 }, (_, i) => `${i + 1},${'x'.repeat(16384)}\n`).join('') : 'id,name\n1,Ada\n2,Lin\n3,Sam\n4,Maya\n5,Lee\n');
  const db = new Database(ctx.target); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;'); db.close();
  const service = await serviceFor(ctx);
  try {
    const input = request(ctx, large ? 10000 : 2);
    const inspected = await service.inspect(input);
    check(inspected.sourceRows === (large ? 262144 : 5), 'Inspection row count mismatch');
    check(inspected.sourceBytes === (await stat(ctx.source)).size, 'Inspection byte count mismatch');
    const dry = await service.dryRun(input);
    check(dry.validRows === (large ? 262118 : 5) && dry.invalidRows === (large ? 26 : 0), 'Dry-run differs from deterministic corpus');
    const approval = await service.approve(input, { expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: qualification.runId });
    await writeFile(ctx.approval, JSON.stringify(approval));
    const files = await readdir(join(ctx.snapshots, id));
    check(files.length === 1, 'Expected one immutable snapshot');
    await verifySnapshotPrivacy(join(ctx.snapshots, id, files[0]));
    ctx.snapshot = join(ctx.snapshots, id, files[0]);
    ctx.sourceSha256 = await digest(ctx.source);
    check(await digest(join(ctx.snapshots, id, files[0])) === ctx.sourceSha256, 'Snapshot content differs from source');
  } finally { service.close(); }
  ctx.path = join(root, 'context.json');
  await writeFile(ctx.path, JSON.stringify(ctx));
  return ctx;
}

function disposableExecutionHook(service, hook) {
  check(service.executionMode === 'DISPOSABLE_QUALIFICATION', 'Fault hook attempted outside marked qualification');
  const registry = service.targetConnectors;
  const registration = registry.registrations.get('target:sqlite');
  registry.registrations.set('target:sqlite', { ...registration, factory: async args => {
    const runtime = await registration.factory(args);
    const create = runtime.createExecution.bind(runtime);
    runtime.createExecution = async args2 => {
      const execution = await create(args2); hook(execution); return execution;
    };
    return runtime;
  } });
}

function targetCounts(ctx) {
  const db = new Database(ctx.target, { readonly: true });
  try {
    const rows = db.prepare('SELECT count(*) AS n FROM rows').get().n;
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE name='__spool_batch_ledger'").get();
    const ledger = exists ? db.prepare('SELECT count(*) AS n FROM __spool_batch_ledger').get().n : 0;
    return { rows, ledger };
  } finally { db.close(); }
}

async function faultCases(identity, report, persist) {
  const cases = ['source_changed', 'principal_changed', 'nonce_tamper', 'effects_tamper', 'signature_tamper',
    'approval_expired', 'schema_drift', 'between_batch_schema', 'wal_busy', 'stale_fence', 'bounded_full', 'cap_plus_one'];
  for (const id of cases) {
    const ctx = await fixture(id, false, identity);
    const service = await serviceFor(ctx);
    let blocker = null;
    let takeover = null;
    let observed = null;
    let expected = ['APPROVAL_SIGNATURE_INVALID'];
    let expectedRows = 0;
    let expectedLedger = 0;
    const input = request(ctx, 2);
    let approval = JSON.parse(await readFile(ctx.approval, 'utf8'));
    try {
      if (id === 'source_changed') { await appendFile(ctx.source, '6,Changed\n'); expected = ['SOURCE_CHANGED']; }
      if (id === 'principal_changed') { input.principal = 'operator:another'; expected = ['APPROVAL_BINDING_MISMATCH']; }
      if (id === 'nonce_tamper') approval.record.nonce += '-tampered';
      if (id === 'effects_tamper') approval.record.effects.push('sqlite:delete_rows');
      if (id === 'signature_tamper') approval.signature = 'hmac-sha256:' + '0'.repeat(64);
      if (id === 'approval_expired') {
        approval = createBoundApproval({ ...approval.record, expiresAt: '2000-01-01T00:00:00.000Z' }, { signingKey: ctx.key });
        expected = ['APPROVAL_EXPIRED'];
      }
      if (id === 'schema_drift') {
        const db = new Database(ctx.target); db.exec('CREATE INDEX changed_contract ON rows(name)'); db.close();
        expected = ['APPROVAL_BINDING_MISMATCH'];
      }
      if (id === 'wal_busy') {
        blocker = new Database(ctx.target); check(blocker.pragma('journal_mode', { simple: true }) === 'wal', 'Lock fixture must use actual WAL');
        blocker.exec('BEGIN IMMEDIATE'); expected = ['SQLITE_BUSY'];
      }
      if (['between_batch_schema', 'stale_fence', 'bounded_full'].includes(id)) {
        disposableExecutionHook(service, execution => {
          if (id === 'stale_fence') execution.leaseTtlMs = 50;
          const openTarget = execution.openTarget.bind(execution);
          execution.openTarget = () => {
            const target = openTarget();
            if (id === 'bounded_full') target.db.pragma('max_page_count = ' + target.db.pragma('page_count', { simple: true }));
            const commit = target.commitBatch.bind(target);
            let committed = 0;
            target.commitBatch = async batch => {
              if (id === 'stale_fence') {
                takeover = new LeaseStore({ path: ctx.target });
                let held = false;
                try { takeover.acquire({ resource: execution.leaseResource, owner: 'concurrent-disposable', ttlMs: 5000 }); }
                catch (error) { held = error.code === 'LEASE_HELD'; }
                check(held, 'Concurrent owner bypassed live lease');
                while (Date.now() <= execution.lease.expiresAtMs) await new Promise(resolve => setTimeout(resolve, 10));
                const lease = takeover.acquire({ resource: execution.leaseResource, owner: 'concurrent-disposable', ttlMs: 5000 });
                check(lease.fencingToken > batch.fencingToken, 'Takeover did not advance fence');
              }
              const result = commit(batch);
              if (id === 'between_batch_schema' && committed++ === 0) {
                const external = new Database(ctx.target); external.exec('CREATE INDEX between_batch_contract ON rows(name)'); external.close();
              }
              return result;
            };
            return target;
          };
        });
        expected = [id === 'between_batch_schema' ? 'TARGET_CONTRACT_CHANGED' : id === 'stale_fence' ? 'STALE_FENCE' : 'SQLITE_FULL'];
        if (id === 'between_batch_schema') { expectedRows = 2; expectedLedger = 1; }
      }
      if (id === 'cap_plus_one') {
        const file = await open(ctx.source, 'r+'); await file.truncate(LIMIT + 1); await file.close(); expected = ['SOURCE_TOO_LARGE'];
      }
      try {
        if (id === 'cap_plus_one') await service.inspect(input);
        else await service.run(input, { approval });
      } catch (error) { observed = { code: error.code, message: error.message }; }
      check(observed && expected.includes(observed.code), `${id}: expected ${expected}, observed ${JSON.stringify(observed)}`);
      if (blocker) { blocker.exec('ROLLBACK'); blocker.close(); blocker = null; }
      const counts = targetCounts(ctx);
      check(counts.rows === expectedRows && counts.ledger === expectedLedger, id + ': failed operation left wrong actual target/ledger accounting');
      check(service.runs.get(ctx.id)?.status !== 'COMPLETE', id + ': failed operation reported COMPLETE');
      report.entries.push({ case: id, root: ctx.root, status: 'PASS', observed, actualTarget: counts }); await persist();
    } finally {
      if (blocker) { blocker.exec('ROLLBACK'); blocker.close(); }
      if (takeover) takeover.close();
      service.close();
    }
  }
}

async function launch(ctx, mode, evidence, { expectedErrors = null, beforeKill = null } = {}) {
  const log = createWriteStream(join(evidence, ctx.id + '-' + mode + '.log'), { flags: 'wx' });
  const child = fork(SELF, ['--child', ctx.path, mode], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let proof = null;
  let barrier = null;
  let failure = null;
  let callbackError = null;
  const timeout = setTimeout(() => { callbackError = new Error('Native qualification child exceeded ten minutes'); child.kill('SIGKILL'); }, 600000);
  child.on('message', value => {
    if (value.done) proof = value;
    if (value.failure) failure = value.failure;
    if (value.barrier) {
      barrier = value;
      Promise.resolve(beforeKill ? beforeKill(value) : null)
        .catch(error => { callbackError = error; })
        .finally(() => child.kill('SIGKILL'));
    }
  });
  const [code, signal] = await once(child, 'close');
  clearTimeout(timeout);
  log.end(); await once(log, 'finish');
  if (callbackError) throw callbackError;
  if (mode.startsWith('kill_')) check(barrier && signal === 'SIGKILL', 'OS-level kill did not occur at the commit/checkpoint barrier');
  else if (expectedErrors) check(code === 1 && expectedErrors.includes(failure?.code), `Expected native failure ${expectedErrors}, observed ${JSON.stringify(failure)}`);
  else check(code === 0 && proof?.done, `Native child failed (${code}/${signal}); see retained log`);
  if (proof) assertions += proof.assertions;
  return { mode, code, signal, proof, barrier, failure };
}

async function interruptedSnapshot(large, identity, evidence) {
  const ctx = { ...large, ...identity, id: 'snapshot_interrupted', target: join(large.root, 'interrupt-target.db'),
    state: join(large.root, 'interrupt-state.db'), path: join(large.root, 'interrupt-context.json') };
  const db = new Database(ctx.target); db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,name TEXT NOT NULL) STRICT'); db.close();
  await writeFile(ctx.path, JSON.stringify(ctx));
  const log = createWriteStream(join(evidence, 'snapshot-interrupted.log'), { flags: 'wx' });
  const child = fork(SELF, ['--snapshot-child', ctx.path], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const closed = once(child, 'close');
  let partial = null;
  try {
    const until = Date.now() + 30000;
    const dir = join(ctx.snapshots, ctx.id);
    while (Date.now() < until && !partial) {
      let files = [];
      try { files = await readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of files.filter(value => value.endsWith('.tmp'))) {
        const path = join(dir, name); const size = (await stat(path)).size;
        if (size > 0 && size < LIMIT) { partial = { path, observedBytesBeforeKill: size }; break; }
      }
      if (!partial) await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { child.kill('SIGKILL'); }
  const [, signal] = await closed;
  log.end(); await once(log, 'finish');
  check(partial && signal === 'SIGKILL', 'Did not kill a real partially written source snapshot');
  await verifySnapshotPrivacy(partial.path);
  check(targetCounts(ctx).rows === 0 && targetCounts(ctx).ledger === 0, 'Interrupted snapshot mutated target');
  const service = await serviceFor(ctx);
  try {
    const inspected = await service.inspect(request(ctx));
    check(inspected.sourceRows === 262144 && inspected.sourceBytes === LIMIT, 'Snapshot recovery accepted incomplete bytes');
    const files = (await readdir(join(ctx.snapshots, ctx.id))).filter(name => name.endsWith('.csv'));
    check(files.length === 1, 'Interrupted snapshot recovery did not produce exactly one bound snapshot');
    check(await digest(join(ctx.snapshots, ctx.id, files[0])) === large.sourceSha256, 'Recovered snapshot content identity mismatch');
  } finally { service.close(); }
  return { case: 'interrupted_snapshot', status: 'PASS', root: ctx.root, partial, signal };
}

async function parent() {
  const identity = { commitSha: sha(), version: JSON.parse(await readFile('package.json', 'utf8')).version };
  check(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), 'Source must be immutable during SQLite qualification');
  const root = resolve(process.env.SPOOL_QUALIFICATION_EVIDENCE_ROOT || join(process.cwd(), '..', 'evidence'));
  check(!root.startsWith(resolve('.') + sep), 'Evidence must be external');
  const evidence = join(root, 'sqlite-attempts', identity.commitSha, String(Date.now()));
  await mkdir(evidence, { recursive: true });
  const report = { ...identity, status: 'BLOCKED', hardware: { node: process.version, platform: process.platform, cpu: cpus()[0].model, ramBytes: totalmem() }, entries: [] };
  const persist = () => writeFile(join(evidence, 'attempt.json'), JSON.stringify({ ...report, assertions }, null, 2));
  measurementRootsFile = join(evidence, 'measurement-roots.json');
  await writeFile(measurementRootsFile, '[]');
  const measurementPath = join(evidence, 'resource-summary.json');
  const python = process.env.SPOOL_BROWSER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const monitorLog = createWriteStream(join(evidence, 'measurement.log'), { flags: 'wx' });
  const monitor = spawn(python, ['scripts/measure-local-process.py', String(process.pid), measurementRootsFile, measurementPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  monitor.stdout.pipe(monitorLog, { end: false }); monitor.stderr.pipe(monitorLog, { end: false });
  const monitorClosed = once(monitor, 'close');
  const started = performance.now();
  try {
    const large = await fixture('sustained_256mib', true, identity);
    if (process.platform === 'win32') {
      const privacy = JSON.parse(execFileSync(python, ['scripts/verify-snapshot-access.py', large.snapshot], { encoding: 'utf8' }));
      check(privacy.ownerRead && privacy.restrictedUsersTokenRead === false && privacy.win32Error === 5, 'Independent OS token snapshot privacy failed');
      report.entries.push({ case: 'windows_snapshot_native_access', status: 'PASS', privacy }); await persist();
    }
    report.entries.push({ case: 'exact_256mib', root: large.root, sourceSha256: large.sourceSha256, sourceBytes: (await stat(large.source)).size, execution: await launch(large, 'sustain', evidence) });
    await persist();
    for (const mode of ['kill_before_target_commit', 'kill_before_checkpoint', 'kill_after_checkpoint']) {
      const ctx = await fixture(mode, false, identity);
      const killed = await launch(ctx, mode, evidence);
      const db = new Database(ctx.target, { readonly: true });
      const lease = db.prepare('SELECT expires_at_ms,fencing_token FROM spool_execution_leases').get();
      check(db.prepare('SELECT count(*) AS n FROM rows').get().n === (mode === 'kill_before_target_commit' ? 0 : 2), 'Killed child target commit cardinality differs from barrier');
      check(db.prepare('SELECT count(*) AS n FROM __spool_batch_ledger').get().n === (mode === 'kill_before_target_commit' ? 0 : 1), 'Killed child did not atomically commit its ledger');
      db.close();
      const state = new Database(ctx.state, { readonly: true });
      const row = state.prepare('SELECT checkpoint_json FROM spool_checkpoints WHERE migration_id=?').get(ctx.id);
      check(mode === 'kill_after_checkpoint' ? JSON.parse(row?.checkpoint_json).nextOffset === 2 : row === undefined, 'Kill barrier did not match durable checkpoint state');
      state.close();
      while (Date.now() <= lease.expires_at_ms) await new Promise(resolve => setTimeout(resolve, 100));
      const resumed = await launch(ctx, 'restart', evidence);
      check(resumed.proof.newestFence > lease.fencing_token, 'Restart did not take over with a newer fence');
      report.entries.push({ case: mode, root: ctx.root, killed, resumed }); await persist();
    }
    await faultCases(identity, report, persist);
    const tamper = await fixture('ledger_tamper', false, identity);
    const killed = await launch(tamper, 'kill_before_checkpoint', evidence);
    const corrupted = new Database(tamper.target);
    const lease = corrupted.prepare('SELECT expires_at_ms FROM spool_execution_leases').get();
    check(corrupted.prepare('UPDATE __spool_batch_ledger SET payload_hash=?').run('sha256:' + '0'.repeat(64)).changes === 1, 'Ledger corruption did not change real committed evidence');
    corrupted.close();
    while (Date.now() <= lease.expires_at_ms) await new Promise(resolve => setTimeout(resolve, 100));
    const refused = await launch(tamper, 'restart', evidence, { expectedErrors: ['TARGET_RECONCILIATION_CONFLICT'] });
    check(targetCounts(tamper).rows === 2 && targetCounts(tamper).ledger === 1, 'Corrupt ledger replay mutated additional target rows');
    report.entries.push({ case: 'ledger_tamper', status: 'PASS', root: tamper.root, killed, refused }); await persist();

    const concurrent = await fixture('concurrent_takeover', false, identity);
    let replacement;
    const old = await launch(concurrent, 'kill_before_checkpoint', evidence, { beforeKill: async () => {
      const db = new Database(concurrent.target, { readonly: true });
      const lease = db.prepare('SELECT expires_at_ms,fencing_token FROM spool_execution_leases').get(); db.close();
      while (Date.now() <= lease.expires_at_ms) await new Promise(resolve => setTimeout(resolve, 100));
      replacement = await launch(concurrent, 'restart', evidence);
      check(replacement.proof.newestFence > lease.fencing_token, 'Live concurrent runner did not advance the fence');
      check(targetCounts(concurrent).rows === 5 && targetCounts(concurrent).ledger === 3, 'Concurrent runner did not reconcile exact accounting');
    } });
    report.entries.push({ case: 'active_concurrent_takeover', status: 'PASS', root: concurrent.root, old, replacement }); await persist();
    report.entries.push(await interruptedSnapshot(large, identity, evidence)); await persist();
    report.functionalCasesComplete = true;
  } finally {
    await writeFile(measurementPath.replace(/\.json$/, '.stop'), 'stop');
    const [code] = await monitorClosed;
    monitorLog.end(); await once(monitorLog, 'finish');
    report.wallMs = performance.now() - started;
    if (code === 0) {
      const measured = await readResourceSummary(measurementPath);
      if (measured.summary) report.resources = measured.summary;
      if (!measured.ok) report.measurementFailure = measured.failure;
    } else report.measurementFailure = 'measurement process exited ' + code;
    await persist(); process.stdout.write('SQLITE_ATTEMPT_EVIDENCE=' + evidence + '\n');
  }
  check(report.functionalCasesComplete && !report.measurementFailure, 'Mandatory SQLite cases/resources did not all execute');
  check(report.resources.peakTreeWorkingSetBytes < 1024 * MiB, 'SQLite process tree exceeded one GiB working-set budget');
  report.status = 'PASS'; await persist();
  process.stdout.write('SPOOL_EVIDENCE_JSON=' + JSON.stringify({ surface: 'sqlite_sustained', status: 'PASS', commitSha: identity.commitSha,
    actualExecution: true, assertions, measurements: report.resources, evidencePath: join(evidence, 'attempt.json'),
    cases: report.entries.map(entry => entry.case) }) + '\n');
}

try {
  if (process.argv[2] === '--snapshot-child') {
    const ctx = JSON.parse(await readFile(process.argv[3], 'utf8'));
    const service = await serviceFor(ctx);
    try { await service.inspect(request(ctx)); } finally { service.close(); }
  } else if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4]);
  else await parent();
} catch (error) {
  if (process.send) process.send({ failure: { code: error.code, message: error.message } });
  process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1;
}
