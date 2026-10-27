// SPOOL Enterprise REST API v2 daemon.
//
// Binds REST routes to the REAL engine surface: every migration operation
// resolves through the enterprise orchestrator, which drives the canonical
// SpoolCommandService lifecycle. Principals authenticate with a loopback
// bearer token (platform root) or per-workspace API keys issued by the
// enterprise registry. Authorization is enforced per route with RBAC and
// per-record with workspace membership; cross-workspace records do not
// leak existence (they fail closed with MIGRATION_NOT_FOUND).
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

import { fail, toErrorEnvelope } from '../core/errors.js';
import { metrics, metricsHandler } from '../observability/prometheus.js';
import { verifyApiKey, generateApiKey } from '../platform/api-keys.js';
import { authorizeRole } from '../platform/rbac.js';

// Route -> RBAC action permission. Roles live in src/platform/rbac.js.
const ROUTE_ACTIONS = Object.freeze({
  migrationsCreate: 'migration.create',
  migrationsList: 'migration.history',
  migrationsStatus: 'migration.status',
  migrationsPlan: 'migration.plan',
  migrationsDryRun: 'migration.dryRun',
  migrationsApprove: 'migration.approve',
  migrationsExecute: 'migration.execute',
  migrationsReceipt: 'migration.receipt',
  migrationsVerification: 'migration.verification',
  activityList: 'migration.history'
});

export const ROOT_TOKEN_PRINCIPAL = 'spool:root';

function safeTokenEqual(expected, actual) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(payload);
}

function validHostHeader(value, port) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(`http://${value}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return false;
    return parsed.port === String(port);
  } catch { return false; }
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) fail('REQUEST_TOO_LARGE', `Request exceeds ${maxBodyBytes} bytes`);
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { fail('INVALID_JSON', 'Request body must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_JSON', 'Request body must be a JSON object');
  return parsed;
}

export function createSpoolDaemonV2({
  orchestrator,
  registry = null,
  token = null,
  allowedOrigins = [],
  maxBodyBytes = 1024 * 1024,
  rateLimitPerMinute = 2000,
  host = '127.0.0.1'
} = {}) {
  if (!orchestrator || typeof orchestrator.createMigration !== 'function') {
    fail('INVALID_DAEMON_CONFIG', 'An enterprise orchestrator is required');
  }
  if (!['127.0.0.1', '::1'].includes(host)) fail('INVALID_DAEMON_CONFIG', 'spoold-v2 binds only to a loopback IP');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(value => typeof value !== 'string')) {
    fail('INVALID_DAEMON_CONFIG', 'allowedOrigins must be a string array');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 16 * 1024 * 1024) {
    fail('INVALID_DAEMON_CONFIG', 'maxBodyBytes must be 1 KiB to 16 MiB');
  }
  if (token !== null && (typeof token !== 'string' || token.length < 32)) {
    fail('INVALID_DAEMON_CONFIG', 'bearer token must be at least 32 bytes');
  }
  const originSet = new Set(allowedOrigins);
  let listeningPort = null;
  const rateLimitBuckets = new Map();

  function checkRateLimit(principalKey) {
    const now = Date.now();
    const windowStart = now - 60000;
    let timestamps = rateLimitBuckets.get(principalKey);
    if (!timestamps) {
      timestamps = [];
      rateLimitBuckets.set(principalKey, timestamps);
    }
    // Prune expired
    while (timestamps.length > 0 && timestamps[0] < windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= rateLimitPerMinute) {
      fail('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded; please wait before retrying');
    }
    timestamps.push(now);
  }

  // Resolve the authenticated principal: platform root via bearer token,
  // enterprise principals via workspace-pinned API keys.
  function authenticate(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ') && token) {
      if (safeTokenEqual(token, authorization.slice(7))) {
        return Object.freeze({ kind: 'root', principalId: ROOT_TOKEN_PRINCIPAL, role: 'admin', workspaceId: null });
      }
    }
    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader && registry) {
      const hash = createHash('sha256').update(apiKeyHeader).digest('hex');
      const candidate = registry.resolveApiKeyHash(hash);
      if (candidate && verifyApiKey(apiKeyHeader, hash)) {
        return Object.freeze({
          kind: 'apikey',
          principalId: candidate.principalId,
          role: candidate.role,
          workspaceId: candidate.workspaceId
        });
      }
    }
    return null;
  }

  function assertAuthorized(role, action) {
    if (action === 'workspace.admin') {
      if (role !== 'admin') fail('FORBIDDEN', "Role 'workspace.admin' required for workspace administration");
      return;
    }
    if (!authorizeRole(role, action)) {
      fail('FORBIDDEN', `Role '${role}' is not authorized to perform '${action}'`);
    }
  }

  // API-key principals are pinned to their issued workspace: any other
  // workspace reference is a cross-tenant attempt that fails closed.
  function resolveWorkspaceId(principal, requestedWorkspaceId = null) {
    if (principal.kind === 'apikey') {
      if (requestedWorkspaceId && requestedWorkspaceId !== principal.workspaceId) {
        fail('WORKSPACE_NOT_FOUND', 'Workspace does not exist or is not authorized for this principal');
      }
      return principal.workspaceId;
    }
    if (!requestedWorkspaceId) fail('WORKSPACE_REQUIRED', 'A workspaceId is required');
    return requestedWorkspaceId;
  }

  async function dispatch(request, response, pathname, principal) {
    // POST /v2/migrations — create a migration from a real inspected source.
    if (request.method === 'POST' && pathname === '/v2/migrations') {
      assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsCreate);
      const body = await readJsonBody(request, maxBodyBytes);
      if (typeof body.sourcePath !== 'string' || !body.sourcePath) {
        fail('ENTERPRISE_VALIDATION_FAILED', 'sourcePath is required');
      }
      const workspaceId = resolveWorkspaceId(principal, body.workspaceId);
      const result = await orchestrator.createMigration({
        workspaceId,
        name: body.name,
        principalId: principal.principalId,
        sourcePath: body.sourcePath,
        destination: body.destination,
        mapping: body.mapping,
        mappingRevision: body.mappingRevision ?? 1,
        planRevision: body.planRevision ?? 1,
        batchSize: body.batchSize ?? 1000
      });
      return json(response, 201, { ok: true, result });
    }

    // GET /v2/migrations — list migrations scoped to the principal's workspaces.
    if (request.method === 'GET' && pathname === '/v2/migrations') {
      assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsList);
      const result = await orchestrator.history({
        principalId: principal.principalId,
        workspaceId: principal.kind === 'apikey' ? principal.workspaceId : null
      });
      return json(response, 200, { ok: true, result });
    }

    // POST /v2/workspaces — create a workspace (platform root only).
    if (request.method === 'POST' && pathname === '/v2/workspaces') {
      if (principal.kind !== 'root' || !registry) fail('FORBIDDEN', 'Only the platform root with a registry may manage workspaces');
      const body = await readJsonBody(request, maxBodyBytes);
      const workspace = registry.createWorkspace({
        organizationId: body.organizationId,
        name: body.name,
        directory: body.directory
      });
      let membership = null;
      if (body.principalId) {
        membership = registry.addMembership({
          workspaceId: workspace.workspaceId,
          principalId: body.principalId,
          role: body.principalRole ?? 'admin'
        });
      }
      return json(response, 201, { ok: true, result: workspace, membership });
    }

    // POST /v2/workspaces/{id}/apikeys — issue a workspace-pinned key.
    const apiKeyIssueMatch = pathname.match(/^\/v2\/workspaces\/([^/]+)\/apikeys$/);
    if (apiKeyIssueMatch && request.method === 'POST') {
      if (principal.kind !== 'root' || !registry) fail('FORBIDDEN', 'Only the platform root with a registry may issue API keys');
      const body = await readJsonBody(request, maxBodyBytes);
      const { key, hash } = generateApiKey();
      const issued = registry.issueApiKey({
        workspaceId: apiKeyIssueMatch[1],
        principalId: body.principalId,
        role: body.role,
        hash
      });
      return json(response, 201, { ok: true, result: issued, apiKey: key });
    }

    // DELETE /v2/apikeys/{keyId} — revoke an API key.
    const apiKeyRevokeMatch = pathname.match(/^\/v2\/apikeys\/([^/]+)$/);
    if (apiKeyRevokeMatch && (request.method === 'DELETE' || request.method === 'POST')) {
      if (principal.kind !== 'root' || !registry) fail('FORBIDDEN', 'Only the platform root with a registry may revoke API keys');
      const revoked = registry.revokeApiKey(apiKeyRevokeMatch[1]);
      return json(response, 200, { ok: true, result: revoked });
    }

    // Memberships CRUD routes:
    // GET /v2/workspaces/{id}/memberships
    // POST /v2/workspaces/{id}/memberships
    // DELETE /v2/workspaces/{id}/memberships/{principalId}
    const membershipsMatch = pathname.match(/^\/v2\/workspaces\/([^/]+)\/memberships$/);
    const membershipMemberMatch = pathname.match(/^\/v2\/workspaces\/([^/]+)\/memberships\/([^/]+)$/);

    if (membershipsMatch && request.method === 'GET') {
      if (!registry) fail('NOT_FOUND', 'Registry not enabled');
      const wsId = membershipsMatch[1];
      if (principal.kind !== 'root' && (principal.workspaceId !== wsId || principal.role !== 'admin')) {
        fail('FORBIDDEN', 'Only workspace admins or platform root may list memberships');
      }
      const list = registry.listMemberships(wsId);
      return json(response, 200, { ok: true, result: list });
    }

    if (membershipsMatch && request.method === 'POST') {
      if (!registry) fail('NOT_FOUND', 'Registry not enabled');
      const wsId = membershipsMatch[1];
      if (principal.kind !== 'root' && (principal.workspaceId !== wsId || principal.role !== 'admin')) {
        fail('FORBIDDEN', 'Only workspace admins or platform root may manage memberships');
      }
      const body = await readJsonBody(request, maxBodyBytes);
      const added = registry.addMembership({
        workspaceId: wsId,
        principalId: body.principalId,
        role: body.role
      });
      return json(response, 201, { ok: true, result: added });
    }

    if (membershipMemberMatch && request.method === 'DELETE') {
      if (!registry) fail('NOT_FOUND', 'Registry not enabled');
      const wsId = membershipMemberMatch[1];
      const targetPrincipal = membershipMemberMatch[2];
      if (principal.kind !== 'root' && (principal.workspaceId !== wsId || principal.role !== 'admin')) {
        fail('FORBIDDEN', 'Only workspace admins or platform root may remove memberships');
      }
      const res = registry.removeMembership(wsId, targetPrincipal);
      return json(response, 200, { ok: true, result: res });
    }

    // GET /v2/workspaces/{id}/activity — audit activity for a workspace.
    const activityMatch = pathname.match(/^\/v2\/workspaces\/([^/]+)\/activity$/);
    if (activityMatch && request.method === 'GET') {
      assertAuthorized(principal.role, ROUTE_ACTIONS.activityList);
      const workspaceId = principal.kind === 'apikey' ? principal.workspaceId : activityMatch[1];
      const result = await orchestrator.workspaceActivity({
        principalId: principal.principalId,
        workspaceId,
        limit: 100,
        offset: 0
      });
      return json(response, 200, { ok: true, result });
    }

    // Migration record + lifecycle routes.
    const migrationIdMatch = pathname.match(/^\/v2\/migrations\/([^/]+)$/);
    const migrationActionMatch = pathname.match(/^\/v2\/migrations\/([^/]+)\/(plan|dry-run|approve|execute|receipt|verification)$/);

    if (migrationIdMatch && request.method === 'GET') {
      assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsStatus);
      const result = await orchestrator.status({
        migrationId: migrationIdMatch[1],
        principalId: principal.principalId
      });
      return json(response, 200, { ok: true, result });
    }

    if (migrationActionMatch) {
      const id = migrationActionMatch[1];
      const action = migrationActionMatch[2];
      if (request.method === 'POST' && action === 'plan') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsPlan);
        const result = await orchestrator.plan({ migrationId: id, principalId: principal.principalId });
        return json(response, 200, { ok: true, result });
      }
      if (request.method === 'POST' && action === 'dry-run') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsDryRun);
        const result = await orchestrator.dryRun({ migrationId: id, principalId: principal.principalId });
        return json(response, 200, { ok: true, result });
      }
      if (request.method === 'POST' && action === 'approve') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsApprove);
        const body = await readJsonBody(request, maxBodyBytes);
        const result = await orchestrator.approve({
          migrationId: id,
          principalId: principal.principalId,
          role: principal.role,
          expiresMinutes: Number.isSafeInteger(body.expiresMinutes) ? body.expiresMinutes : 60
        });
        return json(response, 200, { ok: true, result });
      }
      if (request.method === 'POST' && action === 'execute') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsExecute);
        await readJsonBody(request, maxBodyBytes);
        const result = await orchestrator.execute({ migrationId: id, principalId: principal.principalId });
        return json(response, 200, { ok: true, result });
      }
      if (request.method === 'GET' && action === 'receipt') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsReceipt);
        const result = await orchestrator.receipt({ migrationId: id, principalId: principal.principalId });
        if (result === null || result.error) {
          fail('RECEIPT_NOT_AVAILABLE', 'Receipt is not available for an incomplete migration');
        }
        return json(response, 200, { ok: true, result });
      }
      if (request.method === 'GET' && action === 'verification') {
        assertAuthorized(principal.role, ROUTE_ACTIONS.migrationsVerification);
        const result = await orchestrator.verification({ migrationId: id, principalId: principal.principalId });
        if (result === null || result.error) fail('VERIFICATION_NOT_AVAILABLE', 'Verification is not available');
        return json(response, 200, { ok: true, result });
      }
    }

    fail('NOT_FOUND', `Unknown endpoint ${request.method} ${pathname}`);
  }

  const server = http.createServer(async (request, response) => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(request.url ?? '/', `http://${request.headers.host || 'localhost'}`);
    let status = 500;
    try {
      // Unauthenticated operational probes.
      if (request.method === 'GET' && url.pathname === '/v2/health') {
        status = 200;
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/v2/metrics') {
        status = 200;
        return metricsHandler(request, response);
      }
      if (request.method === 'GET' && url.pathname === '/v2/ready') {
        if (!registry) {
          status = 200;
          return json(response, 200, { status: 'ready' });
        }
        try {
          registry.listMigrations({ workspaceIds: null, limit: 1 });
          status = 200;
          return json(response, 200, { status: 'ready' });
        } catch {
          status = 503;
          return json(response, 503, { status: 'not_ready' });
        }
      }

      // Transport hardening: bound Host header and allowlisted Origin.
      if (!validHostHeader(request.headers.host, listeningPort)) {
        status = 421;
        return json(response, 421, { ok: false, error: { code: 'INVALID_HOST', message: 'Host header is not the bound loopback endpoint' } });
      }
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin && !originSet.has(origin)) {
        status = 403;
        return json(response, 403, { ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Browser origin is not allowlisted' } });
      }

      const principal = authenticate(request);
      if (!principal) {
        status = 401;
        return json(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authentication credentials' } });
      }

      checkRateLimit(`${principal.kind}:${principal.principalId}`);

      await dispatch(request, response, url.pathname, principal);
      status = response.statusCode;
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      const code = envelope.code;
      if (code === 'REQUEST_TOO_LARGE') status = 413;
      else if (code === 'RATE_LIMIT_EXCEEDED') status = 429;
      else if (code === 'INVALID_JSON') status = 400;
      else if (code === 'INTERNAL_ERROR') status = 500;
      else if (code === 'MIGRATION_NOT_FOUND' || code === 'WORKSPACE_NOT_FOUND' || code === 'ORGANIZATION_NOT_FOUND' || code === 'API_KEY_NOT_FOUND' || code === 'TABLE_NOT_AVAILABLE' || code === 'NOT_FOUND') status = 404;
      else if (code === 'FORBIDDEN') status = 403;
      else if (code === 'SOURCE_MODIFIED' || code === 'MIGRATION_ALREADY_RUNNING') status = 409;
      else if (code === 'SOURCE_TOO_LARGE') status = 413;
      else status = 422;
      json(response, status, {
        ok: false,
        error: { code: envelope.code, message: envelope.message, retryable: envelope.retryable, nextActions: envelope.nextActions }
      });
    } finally {
      try {
        metrics.apiRequestsTotal.inc({ method: request.method ?? 'UNKNOWN', route: routeLabel(url.pathname), status: String(status) });
        metrics.apiLatencySeconds.observe({ method: request.method ?? 'UNKNOWN', route: routeLabel(url.pathname) }, Number(process.hrtime.bigint() - startedAt) / 1e9);
      } catch {}
    }
  });

  return Object.freeze({
    server,
    async listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('INVALID_DAEMON_CONFIG', 'Invalid listen port');
      await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => { server.off('error', rejectPromise); resolvePromise(); });
      });
      const address = server.address();
      listeningPort = typeof address === 'object' && address ? address.port : port;
      return Object.freeze({ host, port: listeningPort });
    },
    async close() {
      if (server.listening) {
        await new Promise((resolvePromise, rejectPromise) => server.close(error => error ? rejectPromise(error) : resolvePromise()));
      }
      if (orchestrator && typeof orchestrator.closeAll === 'function') await orchestrator.closeAll();
    }
  });
}

// Collapse concrete ids in the route label so metric cardinality stays bounded.
export function routeLabel(pathname) {
  if (pathname === '/v2/health' || pathname === '/v2/ready' || pathname === '/v2/metrics') return pathname;
  if (pathname === '/v2/migrations') return '/v2/migrations';
  if (/^\/v2\/migrations\/[^/]+\/?$/.test(pathname)) return '/v2/migrations/:id';
  if (/^\/v2\/workspaces\//.test(pathname)) return '/v2/workspaces/:id';
  return '/other';
}
