import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { requestJson } from '../src/connectors/cloud-http.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
}

test('cloud transport rejects non-http endpoints and embedded credentials', async () => {
  await assert.rejects(requestJson('file:///etc/passwd'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('javascript:alert(1)'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('http://user:secret@127.0.0.1:1/'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
});

test('cloud transport refuses link-local and metadata addresses', async () => {
  for (const endpoint of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.10.20/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:169.254.169.254]/'
  ]) {
    await assert.rejects(requestJson(endpoint), error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN', endpoint);
  }
});

test('cloud transport enforces a response ceiling before buffering the body', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ payload: 'x'.repeat(8192) }));
  }, async endpoint => {
    await assert.rejects(
      requestJson(`${endpoint}/oversized`, { maxBytes: 1024 }),
      error => error.code === 'CLOUD_HTTP_RESPONSE_TOO_LARGE' && error.details.maxBytes === 1024
    );
  });
});

test('cloud transport times out a hung endpoint instead of blocking forever', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Never end the response.
  }, async endpoint => {
    const started = Date.now();
    await assert.rejects(
      requestJson(`${endpoint}/hang`, { timeoutMs: 150 }),
      error => error.code === 'CLOUD_HTTP_TIMEOUT' && error.details.timeoutMs === 150
    );
    assert.ok(Date.now() - started < 5000, 'timeout must fire promptly');
  });
});

test('cloud transport still returns bounded JSON responses unchanged', async () => {
  await withServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, received: body, headers: { auth: req.headers.authorization ?? null } }));
    });
  }, async endpoint => {
    const response = await requestJson(`${endpoint}/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { statement: 'select 1' }
    });
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    const parsed = await response.json();
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.received, '{"statement":"select 1"}');
    assert.equal(parsed.headers.auth, 'Bearer test-token');
  });
});
