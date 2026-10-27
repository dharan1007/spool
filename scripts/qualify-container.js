#!/usr/bin/env node
// Container acceptance qualifier.
//
// Runs inside the running SPOOL daemon image (as the `node` user) and drives
// the real HTTP surface end to end: workspace provisioning, workspace-pinned
// API key issuance, a real CSV -> SQLite migration through the plan/dry-run/
// approve/execute/receipt/verification lifecycle, and direct row verification
// of the durable target. It is evidence tooling, not product code: copy it
// into the container and run it with `node`.
//
// Required environment (inherited from the daemon container):
//   SPOOL_DAEMON_TOKEN   same bearer token the daemon was started with
// Optional:
//   SPOOL_DAEMON_PORT    default 8080
//   SPOOL_QUALIFY_DIR    default /var/lib/spool/qualify
//   SPOOL_APP_ROOT       default /app (used to resolve better-sqlite3)
//
// Exits 0 only when every check passes, and prints a single JSON document.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const APP_ROOT = process.env.SPOOL_APP_ROOT || '/app';
const requireFromApp = createRequire(join(APP_ROOT, 'package.json'));
const Database = requireFromApp('better-sqlite3');

const PORT = Number(process.env.SPOOL_DAEMON_PORT || 8080);
const TOKEN = process.env.SPOOL_DAEMON_TOKEN ?? '';
const DIR = process.env.SPOOL_QUALIFY_DIR || '/var/lib/spool/qualify';
const bearer = { authorization: `Bearer ${TOKEN}` };

const checks = [];
function check(name, condition, detail) {
  if (!condition) {
    const error = new Error(`CHECK_FAILED ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    error.checks = checks;
    throw error;
  }
  checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
}

function request({ path, method = 'GET', headers = {}, body = null, rawBody = null }) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== null ? rawBody : (body === null ? null : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers
      }
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: response.statusCode, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function buildMapping(targetSchema) {
  const entries = [
    { target: 'customer_id', expr: { op: 'cast_number', value: { op: 'field', name: 'customer_id' } } },
    { target: 'full_name', expr: { op: 'trim', value: { op: 'field', name: 'full_name' }, multiline: true } },
    { target: 'monthly_fee', expr: { op: 'cast_number', value: { op: 'field', name: 'monthly_fee' } } },
    { target: 'joined_on', expr: { op: 'parse_date', value: { op: 'field', name: 'joined_on' }, options: { outputFormat: 'YYYY-MM-DD' } } },
    { target: 'is_active', expr: { op: 'cast_number', value: { op: 'enum_map', value: { op: 'trim', value: { op: 'field', name: 'is_active' } }, map: { true: 1, false: 0 } } } }
  ];
  return entries.filter(entry => targetSchema.some(field => field.name === entry.target));
}

async function writeSourceCsv(path, rows) {
  let csv = 'customer_id,full_name,monthly_fee,joined_on,is_active\n';
  for (let i = 1; i <= rows; i += 1) {
    csv += `${i}," Customer ${i} ",19.${i % 10}5,2024-0${(i % 9) + 1}-1${i % 9},${i % 2 === 0 ? 'true' : 'false'}\n`;
  }
  await writeFile(path, csv, 'utf8');
}

async function main() {
  if (TOKEN.length < 32) throw new Error('SPOOL_DAEMON_TOKEN missing or shorter than 32 bytes');
  await mkdir(DIR, { recursive: true });

  // 1. Unauthenticated probes.
  const health = await request({ path: '/v2/health' });
  check('health_200', health.status === 200 && health.body?.status === 'ok', health.status);
  const ready = await request({ path: '/v2/ready' });
  check('ready_200', ready.status === 200 && ready.body?.status === 'ready', ready.status);
  const metrics = await request({ path: '/v2/metrics' });
  check('metrics_prometheus', metrics.status === 200 && metrics.text.includes('# TYPE'), metrics.status);

  // 2. Fail-closed transport.
  const unauthenticated = await request({ path: '/v2/migrations' });
  check('unauthenticated_401', unauthenticated.status === 401 && unauthenticated.body?.error?.code === 'UNAUTHORIZED', unauthenticated.status);
  const rebound = await request({ path: '/v2/migrations', headers: { host: 'evil.example' } });
  check('host_rebinding_421', rebound.status === 421 && rebound.body?.error?.code === 'INVALID_HOST', rebound.status);
  const badJson = await request({ path: '/v2/migrations', method: 'POST', headers: { ...bearer, 'content-type': 'application/json', 'content-length': 7 }, rawBody: '{"half:' });
  check('bad_json_400', badJson.status === 400 && badJson.body?.error?.code === 'INVALID_JSON', badJson.status);

  // 3. Organization + workspace provisioning + workspace-pinned API key.
  const org = await request({
    path: '/v2/organizations',
    method: 'POST',
    headers: bearer,
    body: { name: `container-qualification-${Date.now()}` }
  });
  check('organization_created', org.status === 201 && org.body.result.organizationId.startsWith('org_'), org.status);
  const wsDir = join(DIR, 'ws');
  await mkdir(wsDir, { recursive: true });
  const wsName = `container-${Date.now()}`;
  const ws = await request({
    path: '/v2/workspaces',
    method: 'POST',
    headers: bearer,
    body: { organizationId: org.body.result.organizationId, name: wsName, directory: wsDir, principalId: 'container-runner', principalRole: 'operator' }
  });
  check('workspace_created', ws.status === 201, ws.status);
  const workspaceId = ws.body.result.workspaceId;
  const key = await request({
    path: `/v2/workspaces/${workspaceId}/apikeys`,
    method: 'POST',
    headers: bearer,
    body: { principalId: 'container-runner', role: 'operator' }
  });
  check('apikey_issued', key.status === 201 && key.body.apiKey.startsWith('spool_live_'), key.status);
  const opHeaders = { 'x-api-key': key.body.apiKey };

  // 4. Real source, real durable target, inside the declared workspace.
  const sourcePath = join(DIR, 'ws', 'customers.csv');
  const targetPath = join(DIR, 'ws', 'crm.db');
  await writeSourceCsv(sourcePath, 5);
  const targetSchema = [
    { name: 'customer_id', type: 'integer', nullable: false },
    { name: 'full_name', type: 'string', nullable: false },
    { name: 'monthly_fee', type: 'number', nullable: false },
    { name: 'joined_on', type: 'string', nullable: false },
    { name: 'is_active', type: 'integer', nullable: false }
  ];
  const db = new Database(targetPath);
  db.exec('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, monthly_fee REAL NOT NULL, joined_on TEXT NOT NULL, is_active INTEGER NOT NULL) STRICT;');
  db.close();

  // 5. Migration lifecycle through the canonical command path.
  const created = await request({
    path: '/v2/migrations',
    method: 'POST',
    headers: opHeaders,
    body: {
      name: 'container qualification import',
      workspaceId,
      sourcePath: 'customers.csv',
      destination: { path: 'crm.db', table: 'customers', targetSchema },
      mapping: buildMapping(targetSchema),
      mappingRevision: 1,
      planRevision: 1,
      batchSize: 2
    }
  });
  check('migration_created', created.status === 201 && created.body.result.sourceProfile.rowCount === 5, created.status);
  const migrationId = created.body.result.migrationId;

  const earlyExecute = await request({ path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: opHeaders, body: {} });
  check('execute_before_approval_422', earlyExecute.status === 422 && earlyExecute.body.error.code === 'MIGRATION_STEP_OUT_OF_ORDER', earlyExecute.status);

  const plan = await request({ path: `/v2/migrations/${migrationId}/plan`, method: 'POST', headers: opHeaders, body: {} });
  check('plan_200', plan.status === 200 && Boolean(plan.body.result.planId), plan.status);
  const planId = plan.body.result.planId;

  const dryRun = await request({ path: `/v2/migrations/${migrationId}/dry-run`, method: 'POST', headers: opHeaders, body: {} });
  check('dry_run_exact', dryRun.status === 200 && dryRun.body.result.validRows === 5 && dryRun.body.result.invalidRows === 0, dryRun.body?.result);

  const approve = await request({ path: `/v2/migrations/${migrationId}/approve`, method: 'POST', headers: opHeaders, body: {} });
  check('approve_200', approve.status === 200, approve.status);

  const execute = await request({ path: `/v2/migrations/${migrationId}/execute`, method: 'POST', headers: opHeaders, body: {} });
  check('execute_complete', execute.status === 200 && execute.body.result.status === 'COMPLETE', execute.body?.result?.status);

  const receipt = await request({ path: `/v2/migrations/${migrationId}/receipt`, headers: opHeaders });
  check('receipt_bound_to_plan', receipt.status === 200 && (receipt.body.result.record?.planId ?? receipt.body.result.planId) === planId, receipt.status);
  const verification = await request({ path: `/v2/migrations/${migrationId}/verification`, headers: opHeaders });
  check('verification_present', verification.status === 200 && Boolean(verification.body.result), verification.status);

  // 6. Durable target contains exactly the migrated content.
  const verifyDb = new Database(targetPath, { readonly: true });
  const rows = verifyDb.prepare('SELECT * FROM customers ORDER BY customer_id').all();
  verifyDb.close();
  check('target_row_count', rows.length === 5, rows.length);
  check('target_content', rows[0].full_name === 'Customer 1' && rows[0].is_active === 0 && rows[1].is_active === 1 && rows[4].joined_on.startsWith('2024-05-15'), rows[0]);
  check('target_fee_value', rows[2].monthly_fee === 19.35 && rows[2].joined_on.startsWith('2024-03-13'), rows[2]);

  return {
    ok: true,
    workspaceId,
    migrationId,
    planId,
    rows: rows.length,
    checks,
    release: (await request({ path: '/v2/ready' })).body
  };
}

main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}).catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, checks: error.checks ?? [] })}\n`);
  process.exit(1);
});
