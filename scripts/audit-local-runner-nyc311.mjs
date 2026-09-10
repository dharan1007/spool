import { openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { parseCsv } from '../src/core/csv.js';
import { SpoolCommandService } from '../src/daemon/command-service.js';

const sourcePath = process.argv[2];
const mode = process.argv[3] ?? 'inspect';
const releaseSha = process.env.SPOOL_EXPECTED_SHA ?? 'feb1cfaab15c44522c594d008a8b0190f400ff52';
if (!sourcePath) throw new Error('source path required');

function readHeader(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) throw new Error('CSV header exceeds 128 KiB');
    return parseCsv(text.slice(0, nl + 1)).headers;
  } finally { closeSync(fd); }
}

function safeNames(headers) {
  const used = new Set();
  return headers.map((header, index) => {
    let name = header.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!name || !/^[a-z_]/.test(name)) name = `field_${index + 1}_${name}`;
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${name}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}

const headers = readHeader(sourcePath);
const targets = safeNames(headers);
const root = dirname(sourcePath);
const targetPath = join(root, `spool-audit-${mode}.db`);
const statePath = join(root, `spool-audit-${mode}-state.db`);
for (const p of [targetPath, statePath]) { try { unlinkSync(p); } catch {} }

const db = new Database(targetPath);
try {
  const cols = targets.map(name => `"${name.replaceAll('"','""')}" TEXT`).join(',');
  db.exec(`CREATE TABLE records (${cols}) STRICT;`);
} finally { db.close(); }

const request = {
  migrationId: `audit_nyc311_${mode}_${Date.now()}`,
  principal: 'audit:production',
  planInput: {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'nyc311.csv', path: sourcePath },
    targetRef: { connector: 'sqlite', connectionId: 'dst', resource: 'records', path: targetPath, table: 'records' },
    targetSchema: targets.map(name => ({ name, type: 'string', nullable: true })),
    mapping: targets.map((target, i) => ({ target, expr: { op: 'trim', value: { op: 'field', name: headers[i] } } })),
    mappingRevision: 1,
    writeStrategy: { mode: 'insert', batchSize: 10_000 },
    verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] },
    capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true } }
  }
};

const service = await SpoolCommandService.create({
  sourceRoot: root,
  targetRoot: root,
  statePath,
  approvalSigningKey: '0123456789abcdef0123456789abcdef',
  release: { version: '1.0.0-audit', commitSha: releaseSha }
});

const report = { mode, sourceBytes: statSync(sourcePath).size, headers: headers.length, serviceDefaultMaxSourceBytes: 256 * 1024 * 1024 };
try {
  const t0 = performance.now();
  const inspected = await service.inspect(request);
  report.inspect = { ok: true, seconds: Number(((performance.now()-t0)/1000).toFixed(3)), sourceRows: inspected.sourceRows, sourceBytes: inspected.sourceBytes, maxSourceBytes: inspected.maxSourceBytes, targetPreflight: inspected.targetPreflight.status };
  if (mode === 'run') {
    const dry = await service.dryRun(request);
    report.dryRun = { validRows: dry.validRows, invalidRows: dry.invalidRows, processedRows: dry.processedRows };
    const approval = await service.approve(request, { expiresAt: '2099-01-01T00:00:00.000Z', nonce: `audit-${Date.now()}` });
    const r0 = performance.now();
    const result = await service.run(request, { approval });
    const verifyDb = new Database(targetPath, { readonly: true });
    const targetRows = Number(verifyDb.prepare('SELECT COUNT(*) AS n FROM records').get().n);
    verifyDb.close();
    report.run = {
      status: result.status,
      seconds: Number(((performance.now()-r0)/1000).toFixed(3)),
      verification: result.verification?.status,
      receiptId: result.receipt?.receiptId,
      targetRows,
      receiptCounts: result.receipt?.record?.counts
    };
  }
} catch (error) {
  report.inspect = { ok: false, code: error?.code ?? null, message: error?.message ?? String(error) };
} finally {
  service.close();
}
console.log(JSON.stringify(report));
