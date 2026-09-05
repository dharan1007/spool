import test from 'node:test';
import assert from 'node:assert/strict';
import { SpoolError } from '../src/core/errors.js';
import { SpooldHost } from '../src/daemon/spoold.js';

const TOKEN = 'spool-test-token-0123456789abcdef0123456789abcdef';

function serviceFixture() {
  const calls = [];
  return {
    calls,
    async listConnectors(request) { calls.push(['listConnectors', request]); return [{ name: 'sqlite', version: '1.1.0' }]; },
    async listConnections(request) { calls.push(['listConnections', request]); return [{ name: 'local', type: 'sqlite' }]; },
    async putConnection(request) { calls.push(['putConnection', request]); return { name: request.name, type: request.type }; },
    async testConnection(request) { calls.push(['testConnection', request]); return { name: request.name, ok: true }; },
    async createPlan(request) { calls.push(['createPlan', request]); return { planId: 'sha256:plan' }; },
    async runMigration(request) { calls.push(['runMigration', request]); return { job: { jobId: 'job_1' }, receipt: { receiptId: 'receipt_1' } }; },
    async inspectJob(request) { calls.push(['inspectJob', request]); return { jobId: request.jobId, state: 'RUNNING' }; },
    async getReceipt(request) { calls.push(['getReceipt', request]); return { receiptId: request.receiptId ?? 'receipt_1' }; }
  };
}

async function startHost(options = {}) {
  const commandService = options.commandService ?? serviceFixture();
  const host = new SpooldHost({
    commandService,
    token: TOKEN,
    host: options.host ?? '127.0.0.1',
    port: 0,
    allowedOrigins: options.allowedOrigins ?? ['https://app.spool.local'],
    maxBodyBytes: options.maxBodyBytes ?? 1024
  });
  const address = await host.start();
  return { host, commandService, baseUrl: `http://${address.host}:${address.port}` };
}

async function command(baseUrl, name, body = {}, headers = {}) {
  return fetch(`${baseUrl}/v1/commands/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test('spoold refuses non-loopback bind addresses', async () => {
  const fixture = serviceFixture();
  const host = new SpooldHost({ commandService: fixture, token: TOKEN, host: '0.0.0.0', port: 0 });
  await assert.rejects(() => host.start(), /loopback/i);
});

test('spoold requires bearer authentication before command dispatch', async () => {
  const { host, commandService, baseUrl } = await startHost();
  try {
    const response = await fetch(`${baseUrl}/v1/commands/list_connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 401);
    assert.deepEqual(commandService.calls, []);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'UNAUTHORIZED');
  } finally {
    await host.close();
  }
});

test('spoold dispatches only allowlisted commands through SpoolCommandService', async () => {
  const { host, commandService, baseUrl } = await startHost();
  try {
    const response = await command(baseUrl, 'inspect_job', { jobId: 'job_123' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { jobId: 'job_123', state: 'RUNNING' } });
    assert.deepEqual(commandService.calls, [['inspectJob', { jobId: 'job_123' }]]);

    const unknown = await command(baseUrl, 'raw_sql', { sql: 'select 1' });
    assert.equal(unknown.status, 404);
    assert.equal(commandService.calls.length, 1);
    const unknownPayload = await unknown.json();
    assert.equal(unknownPayload.error.code, 'COMMAND_NOT_FOUND');
  } finally {
    await host.close();
  }
});

test('spoold rejects unapproved browser origins but permits originless local clients', async () => {
  const { host, commandService, baseUrl } = await startHost();
  try {
    const denied = await command(baseUrl, 'list_connections', {}, { origin: 'https://evil.example' });
    assert.equal(denied.status, 403);
    assert.equal(commandService.calls.length, 0);

    const allowed = await command(baseUrl, 'list_connections', {}, { origin: 'https://app.spool.local' });
    assert.equal(allowed.status, 200);

    const originless = await command(baseUrl, 'list_connectors');
    assert.equal(originless.status, 200);
    assert.equal(commandService.calls.length, 2);
  } finally {
    await host.close();
  }
});

test('spoold answers CORS preflight only for explicitly approved origins', async () => {
  const { host, commandService, baseUrl } = await startHost();
  try {
    const allowed = await fetch(`${baseUrl}/v1/commands/list_connectors`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.spool.local',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.spool.local');
    assert.match(allowed.headers.get('access-control-allow-headers') ?? '', /authorization/i);

    const denied = await fetch(`${baseUrl}/v1/commands/list_connectors`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(commandService.calls, []);
  } finally {
    await host.close();
  }
});

test('spoold enforces bounded JSON bodies before service invocation', async () => {
  const { host, commandService, baseUrl } = await startHost({ maxBodyBytes: 64 });
  try {
    const response = await command(baseUrl, 'put_connection', { name: 'a', type: 'sqlite', padding: 'x'.repeat(512) });
    assert.equal(response.status, 413);
    assert.deepEqual(commandService.calls, []);
    const payload = await response.json();
    assert.equal(payload.error.code, 'REQUEST_TOO_LARGE');
  } finally {
    await host.close();
  }
});

test('spoold normalizes command errors without leaking connector-native secret text', async () => {
  const commandService = serviceFixture();
  commandService.testConnection = async () => {
    throw new SpoolError('CONNECTION_FAILED', 'native failure password=hunter2', {
      token: 'super-secret-token',
      safe: 'bounded'
    });
  };
  const { host, baseUrl } = await startHost({ commandService });
  try {
    const response = await command(baseUrl, 'test_connection', { name: 'prod' });
    assert.equal(response.status, 400);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'CONNECTION_FAILED');
    assert.doesNotMatch(serialized, /hunter2|super-secret-token|password=/i);
  } finally {
    await host.close();
  }
});
