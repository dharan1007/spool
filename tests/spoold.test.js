import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpoolDaemon } from '../src/daemon/spoold.js';

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

test('spoold requires bearer auth and rejects Host/Origin rebinding attempts', async () => {
  const service = { status: migrationId => ({ migrationId, status: 'COMPLETE' }) };
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1' });
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

test('spoold converts unexpected internal failures to a stable non-sensitive envelope', async () => {
  const secret = '/private/customer/secret.db';
  const service = { status: () => { throw new Error(`database exploded at ${secret}\nSTACK: internalImplementation`); } };
  const daemon = createSpoolDaemon({ service, token: TOKEN, host: '127.0.0.1' });
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
