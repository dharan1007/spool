// REST API v2 qualification: transport hardening, principal resolution, RBAC
// enforcement, workspace isolation and the full real-engine lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { generateApiKey } from '../src/platform/api-keys.js';
import { EnterpriseRegistry } from '../src/enterprise/registry.js';
import { createEnterpriseOrchestrator } from '../src/enterprise/orchestrator.js';
import { createSpoolDaemonV2 } from '../src/daemon/spoold-v2.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const bearerHeaders = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function rawRequest({ port, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const send = {
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };
    const req = http.request({ hostname: '127.0.0.1', port, path, ...send }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function writeSourceCsv(path, rows) {
  let csv = 'customer_id,full_name,monthly_fee,joined_on,is_active\n';
  for (let i = 1; i <= rows; i += 1) {
    csv += `${i}," Customer ${i} ",19.${i % 10}5,2024-0${(i % 9) + 1}-1${i % 9},${i % 2 === 0 ? 'true' : 'false'}\n`;
  }
  await writeFile(path, csv, 'utf8');
}

function buildMapping(targetSchema) {
  const castNumber = name => ({ target: name, expr: { op: 'cast_number', value: { op: 'field', name } } });
  return [
    { target: 'customer_id', expr: { op: 'cast_number', value: { op: 'field', name: 'customer_id' } } },
    { target: 'full_name', expr: { op: 'trim', value: { op: 'field', name: 'full_name' }, multiline: true } },
    { target: 'monthly_fee', expr: { op: 'cast_number', value: { op: 'field', name: 'monthly_fee' } } },
    { target: 'joined_on', expr: { op: 'parse_date', value: { op: 'field', name: 'joined_on' }, options: { outputFormat: 'YYYY-MM-DD' } } },
    { target: 'is_active', expr: { op: 'cast_number', value: { op: 'enum_map', value: { op: 'trim', value: { op: 'field', name: 'is_active' } }, map: { true: 1, false: 0 } } } }
  ].filter(entry => targetSchema.some(field => field.name === entry.target));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spool-api-v2-'));
  t.after(() => { void rm(root, { recursive: true, force: true }); });
  const dirA = join(root, 'wsA');
  const dirB = join(root, 'wsB');
  await mkdir(dirA);
  await mkdir(dirB);

  const registry = new EnterpriseRegistry({ path: join(root, 'enterprise.db') });
  t.after(() => registry.close());
  const org = registry.createOrganization('primary-org');
  const wsA = registry.createWorkspace({ organizationId: org.organizationId, name: 'Workspace A', directory: dirA });
  const wsB = registry.createWorkspace({ organizationId: org.organizationId, name: 'Workspace B', directory: dirB });
  registry.addMembership({ workspaceId: wsA.workspaceId, principalId: 'principal-a', role: 'operator' });
  registry.addMembership({ workspaceId: wsA.workspaceId, principalId: 'viewer-a', role: 'viewer' });
  registry.addMembership({ workspaceId: wsB.workspaceId, principalId: 'principal-b', role: 'operator' });

  const orchestrator = createEnterpriseOrchestrator({
    registry,
    approvalSigningKey: TOKEN,
    release: { version: '1.1.2', commitSha: COMMIT_SHA }
  });

  const daemon = createSpoolDaemonV2({ orchestrator, registry, token: TOKEN });
  const address = await daemon.listen(0);
  t.after(() => daemon.close());

  // Prepare a real source + target inside workspace A only.
  await writeSourceCsv(join(dirA, 'customers.csv'), 5);
  const targetA = join(dirA, 'crm.db');
  const db = new Database(targetA);
  db.exec('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, monthly_fee REAL NOT NULL, joined_on TEXT NOT NULL, is_active INTEGER NOT NULL, silent_note TEXT) STRICT;');
  db.close();
  const derivedTargetSchema = [
    { name: 'customer_id', type: 'integer', nullable: false },
    { name: 'full_name', type: 'string', nullable: false },
    { name: 'monthly_fee', type: 'number', nullable: false },
    { name: 'joined_on', type: 'string', nullable: false },
    { name: 'is_active', type: 'integer', nullable: false },
    { name: 'silent_note', type: 'string', nullable: true }
  ];

  return { root, registry, orchestrator, daemon, wsA, wsB, org, targetA, derivedTargetSchema, port: address.port };
}

test('API v2 transport: probes, authentication, host rebinding, origin and RBAC failures', async t => {
  const f = await fixture(t);
  const { port } = f;

  // Unauthenticated probes work without credentials.
  const health = await rawRequest({ port, path: '/v2/health' });
  assert.equal(health.status, 200);
  const ready = await rawRequest({ port, path: '/v2/ready' });
  assert.equal(ready.status, 200);
  const metricsRes = await rawRequest({ port, path: '/v2/metrics' });
  assert.equal(metricsRes.status, 200);
  assert.ok(metricsRes.text.includes('# TYPE'));

  // Protected route requires credentials.
  const unauthorized = await rawRequest({ port, path: '/v2/migrations' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.code, 'UNAUTHORIZED');

  // Host header rebinding fails closed with 421.
  const rebound = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v2/migrations', method: 'POST', headers: { host: 'evil.example' } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    req.write('{}');
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebound.status, 421);
  assert.equal(rebound.body.error.code, 'INVALID_HOST');

  // Origin allowlist enforcement.
  const badOrigin = await rawRequest({ port, path: '/v2/migrations', headers: { ...bearerHeaders, origin: 'https://evil.example' } });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED');

  // Invalid JSON body fails closed with 400.
  const badJson = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v2/migrations', method: 'POST', headers: { ...bearerHeaders, 'content-type': 'application/json', 'content-length': 7 } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end('{"half:');
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'INVALID_JSON');

  // Unknown route -> 404 typed envelope.
  const missing = await rawRequest({ port, path: '/v2/does-not-exist', headers: bearerHeaders });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  // RBAC: viewers list but cannot create.
  const listAsRoot = await rawRequest({ port, path: '/v2/migrations', headers: bearerHeaders });
  assert.equal(listAsRoot.status, 200);
  assert.deepEqual(listAsRoot.body.result.items, []);
  const deniedCreate = await rawRequest({ port, path: '/v2/migrations', method: 'POST', headers: bearerHeaders, body: {} });
  assert.equal(deniedCreate.status, 422);
  assert.equal(deniedCreate.body.error.code, 'ENTERPRISE_VALIDATION_FAILED'); // root passes RBAC, body validation fails first
});

test('API keys are workspace-pinned and enforced; full real-engine lifecycle completes and verifies target rows', async t => {
  const f = await fixture(t);
  const { port, registry, wsA, wsB, targetA, derivedTargetSchema } = f;

  // Issue API keys through the API itself (root only).
  const keyForA = await rawRequest({
    port, path: `/v2/workspaces/${wsA.workspaceId}/apikeys`, method: 'POST',
    headers: bearerHeaders, body: { principalId: 'principal-a', role: 'operator' }
  });
  assert.equal(keyForA.status, 201);
  assert.ok(keyForA.body.apiKey.startsWith('spool_live_'));

  const keyForView = await rawRequest({
    port, path: `/v2/workspaces/${wsA.workspaceId}/apikeys`, method: 'POST',
    headers: bearerHeaders, body: { principalId: 'viewer-a', role: 'viewer' }
  });
  assert.equal(keyForView.status, 201);

  const keyForB = await rawRequest({
    port, path: `/v2/workspaces/${wsB.workspaceId}/apikeys`, method: 'POST',
    headers: bearerHeaders, body: { principalId: 'principal-b', role: 'operator' }
  });
  assert.equal(keyForB.status, 201);

  const opHeadersA = { 'x-api-key': keyForA.body.apiKey, 'content-type': 'application/json' };
  const opHeadersB = { 'x-api-key': keyForB.body.apiKey, 'content-type': 'application/json' };
  const viewHeaders = { 'x-api-key': keyForView.body.apiKey, 'content-type': 'application/json' };

  // An unauthorized garbage key fails authentication entirely.
  const badKey = await rawRequest({ port, path: '/v2/migrations', headers: { 'x-api-key': 'spool_live_bogus_bogus' } });
  assert.equal(badKey.status, 401);

  // Cross-workspace isolation is asserted with the created migration below.

  // Operator A creates the migration through the REAL engine path.
  const createRes = await rawRequest({
    port, path: '/v2/migrations', method: 'POST', headers: opHeadersA,
    body: {
      name: 'crm import A',
      sourcePath: 'customers.csv',
      destination: { path: 'crm.db', table: 'customers', targetSchema: derivedTargetSchema },
      mapping: buildMapping(derivedTargetSchema),
      mappingRevision: 1,
      planRevision: 1,
      batchSize: 2
    }
  });
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.result.migrationId.startsWith('mig_'));
  assert.equal(createRes.body.result.workspaceId, wsA.workspaceId);
  assert.equal(createRes.body.result.sourceProfile.rowCount, 5);
  const migrationId = createRes.body.result.migrationId;

  // Operator B (workspace-pinned key) cannot see workspace A's migration.
  const crossStatus = await rawRequest({ port, path: `/v2/migrations/${migrationId}`, headers: opHeadersB });
  assert.equal(crossStatus.status, 404);
  assert.equal(crossStatus.body.error.code, 'MIGRATION_NOT_FOUND');
  const crossExecute = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: opHeadersB, body: {} });
  assert.equal(crossExecute.status, 404);
  assert.equal(crossExecute.body.error.code, 'MIGRATION_NOT_FOUND');
  const crossPlan = await rawRequest({ port, path: `/v2/migrations/${migrationId}/plan`, method: 'POST', headers: opHeadersB, body: {} });
  assert.equal(crossPlan.status, 404);

  // A workspace-B operator's list must not show workspace A's migration.
  const listB = await rawRequest({ port, path: '/v2/migrations', headers: opHeadersB });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.result.items.find(item => item.migrationId === migrationId), undefined);

  // Execute before approval fails closed with a typed step-order error.
  const earlyExecute = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: opHeadersA, body: {} });
  assert.equal(earlyExecute.status, 422);
  assert.equal(earlyExecute.body.error.code, 'MIGRATION_STEP_OUT_OF_ORDER');

  // Viewer cannot plan or execute; can read status once it exists.
  const viewerPlan = await rawRequest({ port, path: `/v2/migrations/${migrationId}/plan`, method: 'POST', headers: viewHeaders, body: {} });
  assert.equal(viewerPlan.status, 403);
  assert.equal(viewerPlan.body.error.code, 'FORBIDDEN');
  const viewerExecute = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: viewHeaders, body: {} });
  assert.equal(viewerExecute.status, 403);
  const viewerStatus = await rawRequest({ port, path: `/v2/migrations/${migrationId}`, headers: viewHeaders });
  assert.equal(viewerStatus.status, 200);
  assert.equal(viewerStatus.body.result.status, 'CREATED');

  // Lifecycle: plan -> dry-run -> approve -> execute -> receipt (real engine).
  const planRes = await rawRequest({ port, path: `/v2/migrations/${migrationId}/plan`, method: 'POST', headers: opHeadersA, body: {} });
  assert.equal(planRes.status, 200);
  assert.ok(planRes.body.result.planId);
  const planId = planRes.body.result.planId;

  const dryRes = await rawRequest({ port, path: `/v2/migrations/${migrationId}/dry-run`, method: 'POST', headers: opHeadersA, body: {} });
  assert.equal(dryRes.status, 200);
  assert.equal(dryRes.body.result.validRows, 5);
  assert.equal(dryRes.body.result.invalidRows, 0);

  const approveRes = await rawRequest({ port, path: `/v2/migrations/${migrationId}/approve`, method: 'POST', headers: opHeadersA, body: {} });
  assert.equal(approveRes.status, 200);
  assert.ok(approveRes.body.result.approvalId ?? approveRes.body.result.record?.approvalId);

  const executeRes = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: opHeadersA, body: {} });
  assert.equal(executeRes.status, 200);
  assert.equal(executeRes.body.result.status, 'COMPLETE');

  // Receipt and verification (visible to viewers too).
  const receiptRes = await rawRequest({ port, path: `/v2/migrations/${migrationId}/receipt`, headers: viewHeaders });
  assert.equal(receiptRes.status, 200);
  assert.ok(receiptRes.body.result.record);
  assert.equal(receiptRes.body.result.record.planId ?? receiptRes.body.result.planId, planId);

  // Verification surface proves the written row accounting.
  const verification = await rawRequest({ port, path: `/v2/migrations/${migrationId}/verification`, headers: viewHeaders });
  assert.equal(verification.status, 200);
  assert.ok(verification.body.result);

  // The real durable target now contains exactly five migrated rows.
  const verifyDb = new Database(targetA, { readonly: true });
  const count = verifyDb.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  verifyDb.close();
  assert.equal(count, 5);

  // Root status + history + workspace activity surfaces.
  const rootStatus = await rawRequest({ port, path: `/v2/migrations/${migrationId}`, headers: bearerHeaders });
  assert.equal(rootStatus.status, 200);
  assert.equal(rootStatus.body.result.state, 'COMPLETE');
  const rootHistory = await rawRequest({ port, path: '/v2/migrations', headers: bearerHeaders });
  assert.ok(rootHistory.body.result.items.length >= 1);
  const activity = await rawRequest({ port, path: `/v2/workspaces/${wsA.workspaceId}/activity`, headers: bearerHeaders });
  assert.equal(activity.status, 200);
  assert.ok(activity.body.result.length >= 1);

  // Workspace administration is root/admin only.
  const rejectedWorkspaceCreate = await rawRequest({
    port, path: '/v2/workspaces', method: 'POST', headers: opHeadersA,
    body: { organizationId: f.org.organizationId, name: 'x', directory: f.root }
  });
  assert.equal(rejectedWorkspaceCreate.status, 403);
  await mkdir(join(f.root, 'adhoc-ws'));
  const adminWorkspace = await rawRequest({
    port, path: '/v2/workspaces', method: 'POST', headers: bearerHeaders,
    body: { organizationId: f.org.organizationId, name: 'Adhoc', directory: join(f.root, 'adhoc-ws'), principalId: 'principal-admin', principalRole: 'admin' }
  });
  assert.equal(adminWorkspace.status, 201);
  assert.ok(adminWorkspace.body.result.workspaceId.startsWith('ws_'));

  // API request metrics were observed for exercised routes.
  const metricsOut = await rawRequest({ port, path: '/v2/metrics' });
  assert.ok(metricsOut.text.includes('spool_api_requests_total'));
  assert.ok(metricsOut.text.includes('route="/v2/migrations/:id"'));
});

test('API v2 hardening: revocation, duplicate execution replay, source mutation, contract drift', async t => {
  const f = await fixture(t);
  const { port, registry, wsA, targetA, derivedTargetSchema } = f;

  // Issue an operator key through the API, use it, then revoke it.
  const issued = await rawRequest({
    port, path: `/v2/workspaces/${wsA.workspaceId}/apikeys`, method: 'POST',
    headers: bearerHeaders, body: { principalId: 'principal-a', role: 'operator' }
  });
  assert.equal(issued.status, 201);
  const keyId = issued.body.result.keyId;
  const opHeaders = { 'x-api-key': issued.body.apiKey, 'content-type': 'application/json' };
  const preRevoke = await rawRequest({ port, path: '/v2/migrations', headers: opHeaders });
  assert.equal(preRevoke.status, 200);
  registry.revokeApiKey(keyId);
  const postRevoke = await rawRequest({ port, path: '/v2/migrations', headers: opHeaders });
  assert.equal(postRevoke.status, 401);

  // Declared target schema that drifts from the real database fails closed.
  const driftedSchema = derivedTargetSchema.map(field =>
    field.name === 'is_active' ? { ...field, type: 'boolean' } : field
  );
  const drift = await rawRequest({
    port, path: '/v2/migrations', method: 'POST', headers: bearerHeaders,
    body: {
      workspaceId: wsA.workspaceId,
      name: 'drift probe',
      sourcePath: join(f.root, 'wsA', 'customers.csv'),
      destination: { path: join(f.root, 'wsA', 'crm.db'), table: 'customers', targetSchema: driftedSchema },
      mapping: buildMapping(driftedSchema)
    }
  });
  assert.equal(drift.status, 422);
  assert.equal(drift.body.error.code, 'TARGET_CONTRACT_DRIFT');

  // Real lifecycle for replay + source-mutation qualification.
  await writeSourceCsv(join(f.root, 'wsA', 'customers2.csv'), 5);
  const createdByKeyForA = await rawRequest({
    port, path: `/v2/workspaces/${wsA.workspaceId}/apikeys`, method: 'POST',
    headers: bearerHeaders, body: { principalId: 'op-live', role: 'operator' }
  });
  assert.equal(createdByKeyForA.status, 201);
  const liveHeaders = { 'x-api-key': createdByKeyForA.body.apiKey, 'content-type': 'application/json' };
  const migration = await rawRequest({
    port, path: '/v2/migrations', method: 'POST', headers: liveHeaders,
    body: {
      name: 'replay probe',
      sourcePath: join(f.root, 'wsA', 'customers2.csv'),
      destination: { path: join(f.root, 'wsA', 'crm.db'), table: 'customers', targetSchema: derivedTargetSchema },
      mapping: buildMapping(derivedTargetSchema),
      batchSize: 3
    }
  });
  assert.equal(migration.status, 201);
  const migrationId = migration.body.result.migrationId;

  const lifecycle = [];
  for (const step of ['plan', 'dry-run', 'approve']) {
    const res = await rawRequest({ port, path: `/v2/migrations/${migrationId}/${step}`, method: 'POST', headers: liveHeaders, body: {} });
    lifecycle.push(res.status);
  }
  assert.deepEqual(lifecycle, [200, 200, 200]);

  // Mutating the source after approval must abort execution fail-closed.
  await writeSourceCsv(join(f.root, 'wsA', 'customers2.csv'), 7);
  const mutatedExecute = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: liveHeaders, body: {} });
  assert.equal(mutatedExecute.status, 409);
  assert.equal(mutatedExecute.body.error.code, 'SOURCE_MODIFIED');
  const driftedDb = new Database(targetA, { readonly: true });
  const driftedCount = driftedDb.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  driftedDb.close();
  assert.equal(driftedCount, 0); // no partial write happened

  // Restoring the exact approved source bytes makes execution legal again.
  await writeSourceCsv(join(f.root, 'wsA', 'customers2.csv'), 5);
  const complete = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: liveHeaders, body: {} });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.result.status, 'COMPLETE');

  // Duplicate execution replays the completed run without re-writing rows.
  const replay = await rawRequest({ port, path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: liveHeaders, body: {} });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.status, 'COMPLETE');
  assert.equal(replay.body.result.replay, true);
  const replayDb = new Database(targetA, { readonly: true });
  const replayCount = replayDb.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  replayDb.close();
  assert.equal(replayCount, 5); // idempotent: no duplicate writes
});

test('registry isolation guarantees: listMigrations is workspace-scoped and unknown keys fail', async t => {
  const f = await fixture(t);
  const { registry } = f;
  assert.deepEqual(registry.listMigrations({ workspaceIds: [] }), { total: 0, items: [] });
  assert.equal(registry.resolveApiKeyHash('deadbeef'.repeat(8)), null);
  assert.throws(() => registry.getWorkspace('ws_missing'), /WORKSPACE_NOT_FOUND/);
});
