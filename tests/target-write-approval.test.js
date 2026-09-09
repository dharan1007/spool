import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../src/daemon/command-service.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-approval-required-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'customers.csv');
  const targetPath = join(targetRoot, 'customers.db');
  await writeFile(sourcePath, 'id,name\n1,Ada\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    statePath: join(targetRoot, 'state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: 'test', commitSha: '0123456789abcdef0123456789abcdef01234567' }
  });
  try { await fn({ service, sourcePath, targetPath }); }
  finally { service.close(); await rm(dir, { recursive: true, force: true }); }
}

test('Gate B rejects a mutation plan that omits target_write approval', async () => {
  await fixture(async ({ service, sourcePath, targetPath }) => {
    const request = {
      migrationId: 'mig_no_approval', principal: 'operator:test',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', resource: 'customers.csv', path: sourcePath },
        targetRef: { connector: 'sqlite', resource: 'customers', path: targetPath, table: 'customers' },
        targetSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } },
          { target: 'name', expr: { op: 'field', name: 'name' } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize: 100 },
        verification: { checks: ['row_accounting', 'ledger_complete'] },
        risk: { level: 'low', approvals: [] },
        capabilityAssumptions: { target: { transactions: true } }
      }
    };
    await assert.rejects(() => service.inspect(request), /TARGET_WRITE_APPROVAL_REQUIRED/);
    await assert.rejects(() => service.run(request), /TARGET_WRITE_APPROVAL_REQUIRED/);
  });
});
