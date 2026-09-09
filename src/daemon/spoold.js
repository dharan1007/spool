import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fail, toErrorEnvelope } from '../core/errors.js';

const COMMANDS = new Set(['inspect', 'plan', 'dry-run', 'approve', 'run', 'status', 'verify', 'receipt']);

function safeTokenEqual(expected, actual) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
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

function validOrigin(value, allowedOrigins) {
  if (!value) return true;
  return allowedOrigins.has(value);
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_COMMAND', 'Command body must be an object');
  return parsed;
}

async function dispatch(service, body) {
  if (!COMMANDS.has(body.command)) fail('INVALID_COMMAND', `Unsupported command ${String(body.command)}`);
  switch (body.command) {
    case 'inspect': return service.inspect(body.request);
    case 'plan': return service.plan(body.request);
    case 'dry-run': return service.dryRun(body.request);
    case 'approve': return service.approve(body.request, body.options ?? {});
    case 'run': return service.run(body.request, body.options ?? {});
    case 'status': return service.status(body.migrationId);
    case 'verify': return service.verification(body.migrationId);
    case 'receipt': return service.receipt(body.migrationId);
    default: fail('INVALID_COMMAND', 'Unsupported command');
  }
}

function transportError(error) {
  const envelope = toErrorEnvelope(error);
  return Object.freeze({
    code: envelope.code,
    message: envelope.message,
    severity: envelope.severity,
    retryable: envelope.retryable,
    nextActions: envelope.nextActions
  });
}

export function createSpoolDaemon({ service, token, host = '127.0.0.1', allowedOrigins = [], maxBodyBytes = 1024 * 1024 } = {}) {
  if (!service || typeof service !== 'object') fail('INVALID_DAEMON_CONFIG', 'service is required');
  if (typeof token !== 'string' || token.length < 32) fail('INVALID_DAEMON_CONFIG', 'daemon bearer token must be at least 32 bytes');
  if (!['127.0.0.1', '::1'].includes(host)) fail('INVALID_DAEMON_CONFIG', 'spoold binds only to a loopback IP');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(value => typeof value !== 'string')) fail('INVALID_DAEMON_CONFIG', 'allowedOrigins must be a string array');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 16 * 1024 * 1024) fail('INVALID_DAEMON_CONFIG', 'maxBodyBytes must be 1 KiB to 16 MiB');
  const originSet = new Set(allowedOrigins);
  let listeningPort = null;

  const server = http.createServer(async (request, response) => {
    try {
      const auth = request.headers.authorization;
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !safeTokenEqual(token, auth.slice(7))) {
        json(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer authentication required' } });
        return;
      }
      if (!validHostHeader(request.headers.host, listeningPort)) {
        json(response, 421, { ok: false, error: { code: 'INVALID_HOST', message: 'Host header is not the bound loopback endpoint' } });
        return;
      }
      if (!validOrigin(request.headers.origin, originSet)) {
        json(response, 403, { ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Browser origin is not allowlisted' } });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/command') {
        json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
        return;
      }
      const body = await readJsonBody(request, maxBodyBytes);
      const result = await dispatch(service, body);
      json(response, 200, { ok: true, result });
    } catch (error) {
      const publicError = transportError(error);
      const status = publicError.code === 'REQUEST_TOO_LARGE' ? 413 : publicError.code === 'INVALID_JSON' || publicError.code === 'INVALID_COMMAND' ? 400 : publicError.code === 'INTERNAL_ERROR' ? 500 : 422;
      json(response, status, { ok: false, error: publicError });
    }
  });

  return Object.freeze({
    async listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('INVALID_DAEMON_CONFIG', 'Invalid listen port');
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolvePromise(); });
      });
      const address = server.address();
      listeningPort = typeof address === 'object' && address ? address.port : port;
      return Object.freeze({ host, port: listeningPort });
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
    }
  });
}
