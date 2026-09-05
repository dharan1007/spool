import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SpoolError, fail } from '../core/errors.js';

const DESCRIPTOR_FILE = 'spoold.json';
const SUPPORTED_PROTOCOL = 'spoold-v1';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_CREDENTIAL_FILE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const COMMANDS = new Set([
  'list_connectors',
  'list_connections',
  'put_connection',
  'test_connection',
  'create_plan',
  'run_migration',
  'inspect_job',
  'get_receipt'
]);

function requireStateDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) fail('INVALID_STATE_DIR', 'stateDir is required');
  return stateDir;
}

function parseJson(text, code, message) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code, message);
  }
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('SPOOLD_DESCRIPTOR_INVALID', 'spoold descriptor schema is invalid');
  }
  if (value.protocolVersion !== SUPPORTED_PROTOCOL) {
    fail('SPOOLD_PROTOCOL_UNSUPPORTED', `Unsupported spoold protocol ${String(value.protocolVersion ?? '')}`);
  }
  if (typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 200) {
    fail('SPOOLD_DESCRIPTOR_INVALID', 'spoold descriptor instanceId is invalid');
  }
  if (value.host !== '127.0.0.1' && value.host !== '::1') {
    fail('SPOOLD_DESCRIPTOR_NON_LOOPBACK', 'spoold descriptor must use a loopback host');
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    fail('SPOOLD_DESCRIPTOR_INVALID', 'spoold descriptor port is invalid');
  }
  const expectedEndpoint = `http://${value.host === '::1' ? '[::1]' : value.host}:${value.port}`;
  if (value.endpoint !== expectedEndpoint) {
    fail('SPOOLD_DESCRIPTOR_INVALID', 'spoold descriptor endpoint does not match host and port');
  }
  if (!value.auth || value.auth.type !== 'bearer' || typeof value.auth.credentialFile !== 'string') {
    fail('SPOOLD_DESCRIPTOR_INVALID', 'spoold descriptor auth metadata is invalid');
  }
  const credentialFile = value.auth.credentialFile;
  if (!SAFE_CREDENTIAL_FILE.test(credentialFile) || basename(credentialFile) !== credentialFile || credentialFile === '.' || credentialFile === '..') {
    fail('SPOOLD_CREDENTIAL_PATH_INVALID', 'spoold credential path is invalid');
  }
  return {
    schemaVersion: 1,
    protocolVersion: SUPPORTED_PROTOCOL,
    instanceId: value.instanceId,
    pid: Number.isSafeInteger(value.pid) ? value.pid : null,
    host: value.host,
    port: value.port,
    endpoint: expectedEndpoint,
    auth: { type: 'bearer', credentialFile },
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null
  };
}

function validatePairing(value, descriptor) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('SPOOLD_PAIRING_INVALID', 'spoold pairing credential schema is invalid');
  }
  if (value.instanceId !== descriptor.instanceId) {
    fail('SPOOLD_INSTANCE_MISMATCH', 'spoold pairing credential does not match the live daemon instance');
  }
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) {
    fail('SPOOLD_PAIRING_INVALID', 'spoold pairing token is invalid');
  }
  return { schemaVersion: 1, instanceId: value.instanceId, token: value.token };
}

function ensurePrivateCredentialMode(fileStat) {
  if (process.platform === 'win32') return;
  if ((fileStat.mode & 0o077) !== 0) {
    fail('SPOOLD_CREDENTIAL_PERMISSIONS', 'spoold pairing credential must not be accessible by group or other users');
  }
}

function normalizeDiscoveryError(error) {
  if (error instanceof SpoolError) throw error;
  if (error?.code === 'ENOENT') fail('SPOOLD_NOT_RUNNING', 'spoold live descriptor or pairing credential was not found');
  throw error;
}

export async function discoverSpoold({ stateDir } = {}) {
  const root = requireStateDir(stateDir);
  try {
    const descriptorPath = join(root, DESCRIPTOR_FILE);
    const descriptor = validateDescriptor(parseJson(
      await readFile(descriptorPath, 'utf8'),
      'SPOOLD_DESCRIPTOR_INVALID',
      'spoold descriptor is not valid JSON'
    ));
    const credentialPath = join(root, descriptor.auth.credentialFile);
    const credentialStat = await stat(credentialPath);
    if (!credentialStat.isFile()) fail('SPOOLD_PAIRING_INVALID', 'spoold pairing credential is not a regular file');
    ensurePrivateCredentialMode(credentialStat);
    const pairing = validatePairing(parseJson(
      await readFile(credentialPath, 'utf8'),
      'SPOOLD_PAIRING_INVALID',
      'spoold pairing credential is not valid JSON'
    ), descriptor);
    return Object.freeze({
      descriptor: Object.freeze({ ...descriptor, auth: Object.freeze({ ...descriptor.auth }) }),
      token: pairing.token
    });
  } catch (error) {
    normalizeDiscoveryError(error);
  }
}

function requirePositiveInteger(value, code, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(code, `${label} is invalid`);
  return value;
}

function safeRemoteCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'SPOOLD_COMMAND_FAILED';
}

export class SpooldClient {
  constructor({ descriptor, token, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.descriptor = validateDescriptor(descriptor);
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) fail('SPOOLD_PAIRING_INVALID', 'spoold pairing token is invalid');
    this.token = token;
    this.maxRequestBytes = requirePositiveInteger(maxRequestBytes, 'INVALID_CLIENT_REQUEST_LIMIT', 'maxRequestBytes', 8 * 1024 * 1024);
    this.maxResponseBytes = requirePositiveInteger(maxResponseBytes, 'INVALID_CLIENT_RESPONSE_LIMIT', 'maxResponseBytes', 16 * 1024 * 1024);
    this.timeoutMs = requirePositiveInteger(timeoutMs, 'INVALID_CLIENT_TIMEOUT', 'timeoutMs', 120_000);
  }

  static async fromStateDir(options = {}) {
    const discovered = await discoverSpoold(options);
    return new SpooldClient({ ...discovered, ...options });
  }

  async command(command, body = {}) {
    if (!COMMANDS.has(command)) fail('SPOOLD_COMMAND_NOT_ALLOWED', 'Command is not supported by the local spoold client');
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_COMMAND_REQUEST', 'Command request must be an object');
    const payload = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > this.maxRequestBytes) fail('CLIENT_REQUEST_TOO_LARGE', 'Command request exceeds the configured client limit');

    const response = await this.#request(command, payload, payloadBytes);
    if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body) || typeof response.body.ok !== 'boolean') {
      fail('SPOOLD_RESPONSE_INVALID', 'spoold returned an invalid response envelope');
    }
    if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
      const code = safeRemoteCode(response.body?.error?.code);
      throw new SpoolError(code, 'Local spoold command was rejected');
    }
    return response.body.result;
  }

  #request(command, payload, payloadBytes) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const request = http.request({
        host: this.descriptor.host,
        port: this.descriptor.port,
        path: `/v1/commands/${command}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'content-length': payloadBytes,
          accept: 'application/json'
        }
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) {
            response.destroy();
            finish(new SpoolError('CLIENT_RESPONSE_TOO_LARGE', 'spoold response exceeds the configured client limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', error => finish(error));
        response.once('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks, bytes).toString('utf8');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            finish(new SpoolError('SPOOLD_RESPONSE_INVALID', 'spoold returned invalid JSON'));
            return;
          }
          finish(null, { status: response.statusCode ?? 0, body });
        });
      });
      request.once('error', error => finish(error));
      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        finish(new SpoolError('SPOOLD_CLIENT_TIMEOUT', 'Timed out waiting for local spoold'));
      });
      request.end(payload);
    });
  }
}
