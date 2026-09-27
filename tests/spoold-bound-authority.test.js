import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpoolDaemon } from '../src/daemon/spoold.js';

const A = 'a'.repeat(48);
const B = 'b'.repeat(48);
const localIdentities = [
  { token: A, principal: 'operator:alice', commands: ['run', 'status'] },
  { token: B, principal: 'operator:bob', commands: ['approve', 'receipt'] }
];

function call(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/command', method: 'POST',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) }
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(response) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('local transport binds caller identity before service authorization', async () => {
  const calls = [];
  const service = {
    run: async request => { calls.push(['run', request.principal]); return { status: 'COMPLETE' }; },
    approve: async request => { calls.push(['approve', request.principal]); return { approved: true }; },
    status: migrationId => { calls.push(['status', migrationId]); return { migrationId }; }
  };
  const daemon = createSpoolDaemon({ service, localIdentities });
  const { port } = await daemon.listen();
  try {
    const missing = await call(port, null, { command: 'run', request: { principal: 'operator:alice' } });
    assert.equal(missing.status, 401);
    const unknown = await call(port, 'x'.repeat(48), { command: 'run', request: { principal: 'operator:alice' } });
    assert.equal(unknown.status, 401);
    const forged = await call(port, A, { command: 'run', request: { principal: 'operator:bob' } });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, 'PRINCIPAL_MISMATCH');
    const privilege = await call(port, A, { command: 'approve', request: { principal: 'operator:alice' } });
    assert.equal(privilege.status, 403);
    assert.equal(privilege.body.error.code, 'COMMAND_FORBIDDEN');
    const approved = await call(port, B, { command: 'approve', request: { principal: 'operator:bob' } });
    assert.equal(approved.status, 200);
    const ran = await call(port, A, { command: 'run', request: { principal: 'operator:alice' } });
    assert.equal(ran.status, 200);
    assert.deepEqual(calls, [['approve', 'operator:bob'], ['run', 'operator:alice']]);
  } finally {
    await daemon.close();
  }
});

test('bound authority never silently falls back to legacy admin bearer', () => {
  assert.throws(() => createSpoolDaemon({ service: {}, token: A, localIdentities }), { code: 'INVALID_DAEMON_CONFIG' });
  assert.throws(() => createSpoolDaemon({ service: {}, localIdentities: [{ token: A, principal: 'operator:alice', commands: ['unknown'] }] }), { code: 'INVALID_DAEMON_CONFIG' });
});
