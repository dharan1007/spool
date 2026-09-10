import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../../src/daemon/command-service.js';

const ROWS = 230_000;
const REJECT_EVERY = 25_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const LONG_NAME = 'x'.repeat(240);
const EXPECTED_REJECTED = Math.floor(ROWS / REJECT_EVERY);
const EXPECTED_WRITTEN = ROWS - EXPECTED_REJECTED;

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function generateCsv(path) {
  const stream = createWriteStream(path, { encoding: 'utf8' });
  try {
    await writeChunk(stream, 'id,name\n');
    for (let i = 1; i <= ROWS; i += 1) {
      const id = i % REJECT_EVERY === 0 ? `bad-${i}` : String(i);
      await writeChunk(stream, `${id},User ${i} ${LONG_NAME}\n`);
    }
  } finally {
    stream.end();
    await once(stream, 'close');
  }
}

function requestFor(sourcePath, targetPath) {
  return {
    migrationId: 'bounded_memory_proof',
    principal: 'operator:memory-proof',
    planInput: {
      planRevision: 1,
      sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'large.csv', path: sourcePath },
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
      writeStrategy: { mode: 'insert', batchSize: 500 },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true }
      }
    }
  };
}

const dir = await mkdtemp(join(tmpdir(), 'spool-memory-proof-'));
const sourceRoot = join(dir, 'source');
const targetRoot = join(dir, 'target');
const snapshotDir = join(dir, 'snapshots');
const sourcePath = join(sourceRoot, 'large.csv');
const targetPath = join(targetRoot, 'rows.db');
let service;

try {
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  await generateCsv(sourcePath);

  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();

  service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'spool-state.db'),
    snapshotDir,
    maxSourceBytes: MAX_SOURCE_BYTES,
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-memory-proof', commitSha: '2123456789abcdef0123456789abcdef01234567' }
  });
  const request = requestFor(sourcePath, targetPath);

  const inspected = await service.inspect(request);
  if (inspected.sourceRows !== ROWS) throw new Error(`inspect row mismatch: ${inspected.sourceRows}`);
  if (inspected.sourceBytes <= 50 * 1024 * 1024) throw new Error(`fixture must exceed browser 50 MiB boundary: ${inspected.sourceBytes}`);
  if (inspected.sourceBytes >= MAX_SOURCE_BYTES) throw new Error(`fixture exceeds local test ceiling: ${inspected.sourceBytes}`);

  const dry = await service.dryRun(request);
  if (dry.processedRows !== ROWS || dry.validRows !== EXPECTED_WRITTEN || dry.invalidRows !== EXPECTED_REJECTED) {
    throw new Error(`dry-run mismatch: ${JSON.stringify({ processedRows: dry.processedRows, validRows: dry.validRows, invalidRows: dry.invalidRows })}`);
  }

  const approval = await service.approve(request, {
    expiresAt: '2099-01-01T00:00:00.000Z',
    nonce: 'bounded-memory-proof'
  });
  const result = await service.run(request, { approval });
  if (result.status !== 'COMPLETE' || result.verification.status !== 'VERIFIED') {
    throw new Error(`migration did not verify: ${JSON.stringify({ status: result.status, verification: result.verification?.status })}`);
  }
  const counts = result.receipt.record.counts;
  if (counts.sourceRows !== ROWS || counts.writtenRows !== EXPECTED_WRITTEN || counts.rejectedRows !== EXPECTED_REJECTED || counts.filteredRows !== 0) {
    throw new Error(`receipt mismatch: ${JSON.stringify(counts)}`);
  }

  const verify = new Database(targetPath, { readonly: true });
  const targetRows = Number(verify.prepare('SELECT COUNT(*) AS n FROM rows').get().n);
  verify.close();
  if (targetRows !== EXPECTED_WRITTEN) throw new Error(`target row mismatch: ${targetRows}`);

  const heapLimitMiB = Math.round((await import('node:v8')).getHeapStatistics().heap_size_limit / (1024 * 1024));
  process.stdout.write(`BOUNDED_MEMORY_OK ${JSON.stringify({ sourceBytes: inspected.sourceBytes, sourceRows: ROWS, writtenRows: EXPECTED_WRITTEN, rejectedRows: EXPECTED_REJECTED, heapLimitMiB })}\n`);
} finally {
  if (service) service.close();
  await rm(dir, { recursive: true, force: true });
}
