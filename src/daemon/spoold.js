import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { SpoolError, fail } from '../core/errors.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_LIMIT = 8 * 1024 * 1024;
const COMMAND_PATH = /^\/v1\/commands\/([a-z][a-z0-9_]*)$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const COMMANDS = Object.freeze({
  list_connectors: 'listConnectors',
  list_connections: 'listConnections',
  put_connection: 'putConnection',
  test_connection: 'testConnection',
  create_plan: 'createPlan',
  run_migration: 'runMigration',
  inspect_job: 'inspectJob',
  get_receipt: 'getReceipt'
});

const REQUIRED_SERVICE_METHODS = Object.freeze([...new Set(Object.values(COMMANDS))]);

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1';
}

function requireCommandService(commandService) {
  if (!commandService || typeof commandService !== 'object') {
    fail('INVALID_SPOOLD_SERVICE', 'spoold requires a command service');
  }
  for (const method of REQUIRED_SERVICE_METHODS) {
    if (typeof commandService[method] !== 'function') {
      fail('INVALID_SPOOLD_SERVICE', `spoold command service must implement ${method}()`);
    }
  }
  return commandService;
}

function requireToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
    fail('INVALID_SPOOLD_TOKEN', 'spoold bearer token must contain at least 32 characters');
  }
  return token;
}

function requirePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('INVALID_SPOOLD_PORT', 'spoold port must be an integer between 0 and 65535');
  }
  return port;
}

function requireMaxBodyBytes(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BODY_LIMIT) {
    fail('INVALID_SPOOLD_BODY_LIMIT', `spoold maxBodyBytes must be between 1 and ${MAX_BODY_LIMIT}`);
  }
  return value;
}

function normalizeOrigins(origins) {
  if (!Array.isArray(origins)) fail('INVALID_SPOOLD_ORIGINS', 'allowedOrigins must be an array');
  const normalized = new Set();
  for (const origin of origins) {
    if (typeof origin !== 'string' || !origin) fail('INVALID_SPOOLD_ORIGIN', 'allowed origin must be a non-empty string');
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      fail('INVALID_SPOOLD_ORIGIN', 'allowed origin must be an absolute URL origin');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      fail('INVALID_SPOOLD_ORIGIN', 'allowed origin must be an exact HTTP(S) origin');
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function tokenMatches(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

function safeCode(error) {
  return error instanceof SpoolError && SAFE_ERROR_CODE.test(error.code ?? '') ? error.code : 'INTERNAL_ERROR';
}

function statusForCode(code) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'ORIGIN_FORBIDDEN') return 403;
  if (code === 'COMMAND_NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'RECOVERY_REQUIRED' || code.endsWith('_CONFLICT')) return 409;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

function publicError(error) {
  const code = safeCode(error);
  return {
    status: statusForCode(code),
    body: {
      ok: false,
      error: {
        code,
        message: code === 'INTERNAL_ERROR' ? 'Internal command failure' : 'Command rejected'
      }
    }
  };
}

function writeJson(response, status, body, origin = null) {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  if (origin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  response.end(payload);
}

function requestOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin == null) return null;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
    throw new SpoolError('ORIGIN_FORBIDDEN', 'Browser origin is not paired with this spoold instance');
  }
  return origin;
}

function resolveCommand(request) {
  let parsed;
  try {
    parsed = new URL(request.url ?? '/', 'http://spoold.local');
  } catch {
    throw new SpoolError('COMMAND_NOT_FOUND', 'Command route was not found');
  }
  if (parsed.search || parsed.hash) throw new SpoolError('COMMAND_NOT_FOUND', 'Command route was not found');
  const match = COMMAND_PATH.exec(parsed.pathname);
  if (!match || !COMMANDS[match[1]]) throw new SpoolError('COMMAND_NOT_FOUND', 'Command route was not found');
  return { command: match[1], method: COMMANDS[match[1]] };
}

async function readJsonBody(request, maxBodyBytes) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new SpoolError('UNSUPPORTED_MEDIA_TYPE', 'spoold accepts application/json command bodies only');
  }

  const declared = request.headers['content-length'];
  if (declared != null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new SpoolError('INVALID_CONTENT_LENGTH', 'Invalid Content-Length');
    if (length > maxBodyBytes) throw new SpoolError('REQUEST_TOO_LARGE', 'Command body exceeds configured limit');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new SpoolError('REQUEST_TOO_LARGE', 'Command body exceeds configured limit');
    chunks.push(chunk);
  }

  if (bytes === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new SpoolError('INVALID_JSON', 'Command body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpoolError('INVALID_COMMAND_REQUEST', 'Command body must be a JSON object');
  }
  return parsed;
}

export class SpooldHost {
  constructor({
    commandService,
    token,
    host = DEFAULT_HOST,
    port = 8766,
    allowedOrigins = [],
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES
  } = {}) {
    this.commandService = requireCommandService(commandService);
    this.token = requireToken(token);
    this.host = host;
    this.port = requirePort(port);
    this.allowedOrigins = normalizeOrigins(allowedOrigins);
    this.maxBodyBytes = requireMaxBodyBytes(maxBodyBytes);
    this.server = null;
    this.address = null;
  }

  async start() {
    if (!isLoopbackHost(this.host)) fail('SPOOLD_NON_LOOPBACK_BIND', 'spoold may bind only to a loopback address');
    if (this.server) fail('SPOOLD_ALREADY_STARTED', 'spoold is already started');

    const server = http.createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;

    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    const bound = server.address();
    if (!bound || typeof bound === 'string') {
      server.close();
      fail('SPOOLD_BIND_FAILED', 'spoold did not receive a TCP address');
    }
    this.server = server;
    this.address = Object.freeze({ host: this.host, port: bound.port });
    return { ...this.address };
  }

  async close() {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
  }

  async #handle(request, response) {
    let origin = null;
    try {
      const route = resolveCommand(request);
      origin = requestOrigin(request, this.allowedOrigins);

      if (request.method === 'OPTIONS') {
        if (!origin) throw new SpoolError('ORIGIN_FORBIDDEN', 'CORS preflight requires an approved browser origin');
        const requestedMethod = request.headers['access-control-request-method'];
        if (requestedMethod !== 'POST') throw new SpoolError('METHOD_NOT_ALLOWED', 'Only POST commands are supported');
        response.statusCode = 204;
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-methods', 'POST');
        response.setHeader('access-control-allow-headers', 'authorization, content-type');
        response.setHeader('access-control-max-age', '600');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
        response.end();
        return;
      }

      if (request.method !== 'POST') throw new SpoolError('METHOD_NOT_ALLOWED', 'Only POST commands are supported');
      if (!tokenMatches(request.headers.authorization, this.token)) {
        throw new SpoolError('UNAUTHORIZED', 'Valid spoold bearer authentication is required');
      }

      const body = await readJsonBody(request, this.maxBodyBytes);
      const result = await this.commandService[route.method](body);
      writeJson(response, 200, { ok: true, result }, origin);
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      const normalized = publicError(error);
      writeJson(response, normalized.status, normalized.body, origin);
    }
  }
}
