import { markDisposableQualification } from '../src/platform/disposable-qualification.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpoolDaemon } from '../src/daemon/spoold.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function transportQualification(t) {
  const root = await mkdtemp(join(tmpdir(), 'spool-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return markDisposableQualification(root);
}

function request({ port, token, host = `127.0.0.1:${port}`, origin, body = {} }) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', host };
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    const payload = JSON.stringify(body);
    headers['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/command', method: 'POST', headers }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(payload);
  });
}

const TOKEN = '0123456789abcdef0123456789abcdef';

test('spoold requires bearer auth and rejects Host/Origin rebinding attempts', async t => {
  const service = { status: migrationId => ({ migrationId, status: 'COMPLETE' }) };
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1', qualification: await transportQualification(t) });
  const address = await daemon.listen(0);
  try {
    assert.equal((await request({ port: address.port, body: { command: 'status', migrationId: 'm1' } })).status, 401);
    assert.equal((await request({ port: address.port, token: TOKEN, host: 'evil.example', body: { command: 'status', migrationId: 'm1' } })).status, 421);
    assert.equal((await request({ port: address.port, token: TOKEN, origin: 'https://evil.example', body: { command: 'status', migrationId: 'm1' } })).status, 403);
    const ok = await request({ port: address.port, token: TOKEN, body: { command: 'status', migrationId: 'm1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.status, 'COMPLETE');
  } finally { await daemon.close(); }
});

test('spoold converts unexpected internal failures to a stable non-sensitive envelope', async t => {
  const secret = '/private/customer/secret.db';
  const service = { status: () => { throw new Error(`database exploded at ${secret}\nSTACK: internalImplementation`); } };
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1', qualification: await transportQualification(t) });
  const address = await daemon.listen(0);
  try {
    const result = await request({ port: address.port, token: TOKEN, body: { command: 'status', migrationId: 'm1' } });
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
    assert.equal(result.body.error.message, 'Unexpected internal error');
    assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(JSON.stringify(result.body).includes('internalImplementation'), false);
  } finally { await daemon.close(); }
});

test('spoold routes repair and cutover commands to the service with caller options', async t => {
  const seen = [];
  const service = new Proxy({}, {
    get: (target, method) => {
      void target;
      return async (...args) => {
        seen.push({ method, args: JSON.parse(JSON.stringify(args)) });
        return { method, ok: true };
      };
    }
  });
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1', qualification: await transportQualification(t) });
  const address = await daemon.listen(0);
  try {
    const cases = [
      [{ command: 'repair-evidence', migrationId: 'm1' }, 200],
      [{ command: 'approve-repair', request: { a: 1 }, options: { nonce: 'n' } }, 200],
      [{ command: 'run-repair', request: { a: 1 }, options: { repairApproval: 'x' } }, 200],
      [{ command: 'repair-receipt', migrationId: 'm1' }, 200],
      [{ command: 'begin-cutover', request: { a: 1 }, options: { receipt: 'r' } }, 200],
      [{ command: 'commit-cutover', request: { a: 1 } }, 200],
      [{ command: 'abort-cutover', migrationId: 'm1', options: { reason: 'why' } }, 200],
      [{ command: 'cutover', migrationId: 'm1' }, 200],
      [{ command: 'drop-database' }, 400]
    ];
    for (const [body, status] of cases) {
      const result = await request({ port: address.port, token: TOKEN, body });
      assert.equal(result.status, status, JSON.stringify(body));
    }
    const methods = seen.map(item => item.method);
    assert.deepEqual(methods, [
      'repairEvidence', 'approveRepair', 'runRepair', 'repairReceipt',
      'beginCutover', 'commitCutover', 'abortCutover', 'cutover'
    ]);
    assert.deepEqual(seen[1].args, [{ a: 1 }, { nonce: 'n' }]);
    assert.deepEqual(seen[6].args, ['m1', { reason: 'why' }]);
  } finally { await daemon.close(); }
});

test('spoold drives cutover arming and commit against a real service', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const Database = (await import('better-sqlite3')).default;
  const { SpoolCommandService } = await import('../src/daemon/command-service.js');
  const dir = await mkdtemp(join(tmpdir(), 'spool-spoold-cutover-'));
  const sourceRoot = join(dir, 'source');
  const targetRoot = join(dir, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  const sourcePath = join(sourceRoot, 'rows.csv');
  const targetPath = join(targetRoot, 'rows.db');
  await writeFile(sourcePath, 'id,name\n1,Ada\n');
  const db = new Database(targetPath);
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
  db.close();
  const service = await SpoolCommandService.create({
    qualification: await markDisposableQualification(dir),
    sourceRoot, targetRoot, snapshotDir: join(dir, 'snapshots'),
    statePath: join(targetRoot, 'spool-state.db'),
    approvalSigningKey: '0123456789abcdef0123456789abcdef',
    release: { version: '1.1.0-spoold-test', commitSha: '8123456789abcdef0123456789abcdef01234567' }
  });
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1' });
  const address = await daemon.listen(0);
  const command = body => request({ port: address.port, token: TOKEN, body });
  try {
    const planInput = {
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
    };
    const req = { migrationId: 'spoold_cutover_001', principal: 'operator:spoold', planInput };
    const approved = await command({ command: 'approve', request: req, options: { expiresAt: '2099-01-01T00:00:00.000Z', nonce: 'spoold-n1' } });
    assert.equal(approved.status, 200);
    const run = await command({ command: 'run', request: req, options: { approval: approved.body.result } });
    assert.equal(run.body.result.status, 'COMPLETE');
    const armed = await command({ command: 'begin-cutover', request: req, options: { receipt: run.body.result.receipt } });
    assert.equal(armed.body.result.status, 'ARMED');
    const committed = await command({ command: 'commit-cutover', request: req });
    assert.equal(committed.body.result.status, 'COMMITTED');
    const status = await command({ command: 'cutover', migrationId: 'spoold_cutover_001' });
    assert.equal(status.body.result.status, 'COMMITTED');
    const frozen = await command({ command: 'run', request: req, options: { approval: approved.body.result } });
    assert.equal(frozen.status, 422);
    assert.equal(frozen.body.error.code, 'CUTOVER_ALREADY_COMMITTED');
  } finally {
    await daemon.close();
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
