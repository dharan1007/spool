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

const MiB = 1024 * 1024;
const LIMIT = 256 * MiB;
const SELF = fileURLToPath(import.meta.url);
const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let assertions = 0;
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
  try {
    const input = request(ctx, mode === 'sustain' ? 10000 : 2);
    const approval = JSON.parse(await readFile(ctx.approval, 'utf8'));
    if (mode.startsWith('kill_')) {
      const registry = service.targetConnectors;
      const registration = registry.registrations.get('target:sqlite');
      registry.registrations.set('target:sqlite', { ...registration, factory: async args => {
        const runtime = await registration.factory(args);
        const create = runtime.createExecution.bind(runtime);
        runtime.createExecution = async args2 => {
          const execution = await create(args2);
          execution.leaseTtlMs = 1000; // Explicit disposable fault configuration only.
          return execution;
        };
        return runtime;
      } });
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
    process.send({ done: true, assertions, counts, receiptId: result.receipt.receiptId,
      metrics: { wallMs: performance.now() - began, sampledNodeHeapPeakBytes: heapPeak, osReportedNodeMaxRssKiB: usage.maxRSS,
        userCpuMicroseconds: usage.userCPUTime, systemCpuMicroseconds: usage.systemCPUTime } });
  } finally { clearInterval(timer); service.close(); }
}

async function fixture(id, large, identity) {
  await reserve(tmpdir());
  const root = await mkdtemp(join(tmpdir(), 'spool-sqlite-release-'));
  const qualification = await markDisposableQualification(root);
  await secureSnapshotPath(root, { directory: true });
  const ctx = { root, qualification, id, ...identity, key: randomBytes(32).toString('hex'), source: join(root, 'source.csv'),
    target: join(root, 'target.db'), state: join(root, 'state.db'), snapshots: join(root, 'snapshots'), approval: join(root, 'approval.json') };
  if (large) await generate(ctx.source);
  else await writeFile(ctx.source, 'id,name\n1,Ada\n2,Lin\n3,Sam\n4,Maya\n5,Lee\n');
  const db = new Database(ctx.target); db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;'); db.close();
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
    ctx.sourceSha256 = await digest(ctx.source);
    check(await digest(join(ctx.snapshots, id, files[0])) === ctx.sourceSha256, 'Snapshot content differs from source');
  } finally { service.close(); }
  ctx.path = join(root, 'context.json');
  await writeFile(ctx.path, JSON.stringify(ctx));
  return ctx;
}

async function launch(ctx, mode, evidence) {
  const log = createWriteStream(join(evidence, ctx.id + '-' + mode + '.log'), { flags: 'wx' });
  const child = fork(SELF, ['--child', ctx.path, mode], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let proof = null;
  let barrier = null;
  child.on('message', value => {
    if (value.done) proof = value;
    if (value.barrier) { barrier = value; child.kill('SIGKILL'); }
  });
  const [code, signal] = await once(child, 'close');
  log.end(); await once(log, 'finish');
  if (mode.startsWith('kill_')) check(barrier && signal === 'SIGKILL', 'OS-level kill did not occur at the commit/checkpoint barrier');
  else check(code === 0 && proof?.done, `Native child failed (${code}/${signal}); see retained log`);
  if (proof) assertions += proof.assertions;
  return { mode, code, signal, proof, barrier };
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
  try {
    const large = await fixture('sustained_256mib', true, identity);
    report.entries.push({ case: 'exact_256mib', root: large.root, sourceSha256: large.sourceSha256, sourceBytes: (await stat(large.source)).size, execution: await launch(large, 'sustain', evidence) });
    await persist();
    for (const mode of ['kill_before_checkpoint', 'kill_after_checkpoint']) {
      const ctx = await fixture(mode, false, identity);
      const killed = await launch(ctx, mode, evidence);
      const db = new Database(ctx.target, { readonly: true });
      const lease = db.prepare('SELECT expires_at_ms,fencing_token FROM spool_execution_leases').get();
      check(db.prepare('SELECT count(*) AS n FROM rows').get().n === 2, 'Killed child target commit was not exactly two rows');
      check(db.prepare('SELECT count(*) AS n FROM __spool_batch_ledger').get().n === 1, 'Killed child did not atomically commit its ledger');
      db.close();
      const state = new Database(ctx.state, { readonly: true });
      const row = state.prepare('SELECT checkpoint_json FROM spool_checkpoints WHERE migration_id=?').get(ctx.id);
      check(mode === 'kill_after_checkpoint' ? JSON.parse(row?.checkpoint_json).nextOffset === 2 : row === undefined, 'Kill barrier did not match durable checkpoint state');
      state.close();
      while (Date.now() <= lease.expires_at_ms) await new Promise(resolve => setTimeout(resolve, 100));
      const resumed = await launch(ctx, 'restart', evidence);
      const final = new Database(ctx.target, { readonly: true });
      check(final.prepare('SELECT fencing_token FROM spool_execution_leases').get().fencing_token > lease.fencing_token, 'Restart did not take over with a newer fence');
      final.close();
      report.entries.push({ case: mode, root: ctx.root, killed, resumed }); await persist();
    }
    // These measured verticals do not yet cover the entire mandatory fault
    // matrix. Refuse a release PASS instead of relabelling partial execution.
    report.remaining = ['WAL contention', 'between-batch schema drift', 'stale writer refusal', 'bounded SQLITE_FULL', 'approval tamper/expiry', 'source changes', 'ledger tamper', 'interrupted snapshot', 'independent negative Windows access', 'continuous process-tree/disk measurements'];
    await persist();
    throw new Error('SQLite lifecycle/crash checkpoint completed; mandatory remaining cases: ' + report.remaining.join(', '));
  } finally { await persist(); process.stdout.write('SQLITE_ATTEMPT_EVIDENCE=' + evidence + '\n'); }
}

try {
  if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4]);
  else await parent();
} catch (error) { process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1; }
