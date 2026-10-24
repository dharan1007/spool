import test from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, verifyApiKey } from '../src/platform/api-keys.js';
import { createSpoolDaemonV2 } from '../src/daemon/spoold-v2.js';

test('API key generation and verification', () => {
  const { key, hash } = generateApiKey();
  assert.ok(key.startsWith('spool_live_'));
  assert.equal(verifyApiKey(key, hash), true);
  assert.equal(verifyApiKey('spool_live_wrongkey', hash), false);
});

test('REST API v2 routing and authentication', async () => {
  const { key, hash } = generateApiKey();
  const apiKeyStore = new Map([[hash, { role: 'admin' }]]);
  const mockService = {
    history: () => [{ migrationId: 'mig_123', status: 'COMPLETE' }]
  };

  const server = createSpoolDaemonV2({
    service: mockService,
    token: '0123456789abcdef0123456789abcdef',
    apiKeyStore
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Health check (no auth needed)
    const healthRes = await fetch(`http://127.0.0.1:${port}/v2/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');

    // 2. Metrics check (no auth needed)
    const metricsRes = await fetch(`http://127.0.0.1:${port}/v2/metrics`);
    assert.equal(metricsRes.status, 200);

    // 3. Unauthorized request
    const unauthRes = await fetch(`http://127.0.0.1:${port}/v2/migrations`);
    assert.equal(unauthRes.status, 401);

    // 4. Authenticated request with API key
    const authRes = await fetch(`http://127.0.0.1:${port}/v2/migrations`, {
      headers: { 'X-API-Key': key }
    });
    assert.equal(authRes.status, 200);
    const body = await authRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.length, 1);
  } finally {
    server.close();
  }
});
