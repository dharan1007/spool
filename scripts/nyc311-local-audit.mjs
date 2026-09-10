import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { parseCsv } from '../src/core/csv.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';

const sourcePath = process.env.SPOOL_NYC_HUGE_CSV;
const candidateSha = process.env.SPOOL_CANDIDATE_SHA;
if (!sourcePath || !candidateSha) throw new Error('SPOOL_NYC_HUGE_CSV and SPOOL_CANDIDATE_SHA are required');

async function firstLine(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
  } finally {
    lines.close(); stream.destroy();
  }
  throw new Error('Empty CSV');
}

const headerLine = await firstLine(sourcePath);
const headers = parseCsv(`${headerLine}\n`).headers;
if (headers.length < 40) throw new Error(`Unexpected NYC schema width: ${headers.length}`);
const fields = headers.map((source, index) => ({ source, target: `c_${String(index).padStart(3, '0')}` }));
const work = await mkdtemp(join(tmpdir(), 'spool-nyc-local-'));
const targetPath = join(work, 'nyc311.db');
const statePath = join(work, 'spool-state.db');
const db = new Database(targetPath);
db.exec(`CREATE TABLE nyc311 (${fields.map(f => `"${f.target}" TEXT`).join(', ')}) STRICT;`);
db.close();

const request = {
  migrationId: 'audit_nyc311_large_real_data',
  principal: 'operator:production-audit',
  planInput: {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', connectionId: 'nyc311', resource: basename(sourcePath), path: sourcePath },
    targetRef: { connector: 'sqlite', connectionId: 'audit-target', resource: 'nyc311', path: targetPath, table: 'nyc311' },
    targetSchema: fields.map(f => ({ name: f.target, type: 'string', nullable: true })),
    mapping: fields.map(f => ({ target: f.target, expr: { op: 'copy', name: f.source } })),
    mappingRevision: 1,
    writeStrategy: { mode: 'insert', batchSize: 2000 },
    verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] },
    capabilityAssumptions: {
      source: { snapshotBinding: true },
      target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
    }
  }
};

const service = await SpoolCommandService.create({
  sourceRoot: dirname(sourcePath),
  targetRoot: work,
  statePath,
  approvalSigningKey: 'audit-only-approval-signing-key-0123456789abcdef',
  maxSourceBytes: 256 * 1024 * 1024,
  release: { version: '1.0.0-audit', commitSha: candidateSha }
});

const report = { candidateSha, sourcePath, sourceFields: headers.length };
try {
  let started = performance.now();
  const inspected = await service.inspect(request);
  report.inspectSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  report.sourceRows = inspected.sourceRows;
  report.sourceBytes = inspected.sourceBytes;
  report.maxSourceBytes = inspected.maxSourceBytes;
  if (inspected.sourceBytes <= 100 * 1024 * 1024) throw new Error(`Audit file is not above 100 MiB: ${inspected.sourceBytes}`);
  if (inspected.sourceBytes > inspected.maxSourceBytes) throw new Error('Audit file unexpectedly exceeds local-runner ceiling');
  if (inspected.targetPreflight.status !== 'READY') throw new Error(`Target preflight: ${inspected.targetPreflight.status}`);

  started = performance.now();
  const dry = await service.dryRun(request);
  report.dryRunSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  report.dryRun = { processedRows: dry.processedRows, validRows: dry.validRows, invalidRows: dry.invalidRows, violations: dry.violations };
  if (dry.processedRows !== inspected.sourceRows || dry.validRows !== inspected.sourceRows || dry.invalidRows !== 0) throw new Error(`Dry-run mismatch: ${JSON.stringify(report.dryRun)}`);

  const approval = await service.approve(request, { expiresAt: '2026-12-31T23:59:59.000Z', nonce: 'nyc311-production-audit' });
  started = performance.now();
  const result = await service.run(request, { approval });
  report.runSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  report.run = {
    status: result.status,
    replay: result.replay,
    verification: result.verification,
    receiptId: result.receipt?.receiptId ?? null,
    receiptRelease: result.receipt?.record?.release ?? null
  };
  if (result.status !== 'COMPLETE' || result.replay !== false) throw new Error(`Unexpected run result: ${JSON.stringify(result)}`);
  if (result.verification?.status !== 'VERIFIED') throw new Error(`Verification failed: ${JSON.stringify(result.verification)}`);
  const accounting = result.verification.accounting;
  if (accounting.sourceRows !== inspected.sourceRows || accounting.writtenRows !== inspected.sourceRows || accounting.rejectedRows !== 0 || accounting.filteredRows !== 0 || accounting.unexplainedRows !== 0) throw new Error(`Verification accounting mismatch: ${JSON.stringify(accounting)}`);
  if (result.receipt?.record?.release?.commitSha !== candidateSha) throw new Error(`Receipt release mismatch: ${JSON.stringify(result.receipt?.record?.release)}`);

  const check = new Database(targetPath, { readonly: true });
  const targetRows = check.prepare('SELECT COUNT(*) AS count FROM nyc311').get().count;
  const ledger = check.prepare('SELECT COUNT(*) AS batches, COALESCE(SUM(row_count),0) AS rows FROM __spool_batch_ledger WHERE migration_id = ?').get(request.migrationId);
  check.close();
  report.targetRows = targetRows;
  report.ledgerBatches = ledger.batches;
  report.ledgerRows = ledger.rows;
  if (targetRows !== inspected.sourceRows) throw new Error(`Target row mismatch: ${targetRows} vs ${inspected.sourceRows}`);
  if (ledger.batches !== result.verification.ledger.batchCount || ledger.rows !== inspected.sourceRows) throw new Error(`Ledger mismatch: ${JSON.stringify(ledger)}`);

  const replay = await service.run(request, { approval });
  report.idempotentReplay = replay.replay === true && replay.status === 'COMPLETE';
  if (!report.idempotentReplay) throw new Error('Completed migration replay was not idempotent');

  report.status = 'PASS';
  console.log(JSON.stringify(report, null, 2));
} finally {
  service.close();
  await rm(work, { recursive: true, force: true });
}
