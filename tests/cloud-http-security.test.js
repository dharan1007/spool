import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  classifyAddress,
  classifyEndpointHost,
  createGuardedLookup,
  requestJson,
  resolveCloudEndpointPolicy
} from '../src/connectors/cloud-http.js';

async function withServer(handler, run, { listenHost = '127.0.0.1' } = {}) {
  const server = http.createServer(handler);
  if (listenHost) server.listen(0, listenHost);
  else server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
}

const loopback = { allowPrivateNetwork: true };

async function withEnv(values, run) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('address classification covers loopback, private, link-local, metadata and IPv4-mapped forms', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('127.8.9.10'), 'loopback');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.31.255.255'), 'private');
  assert.equal(classifyAddress('172.32.0.1'), 'public');
  assert.equal(classifyAddress('192.168.1.1'), 'private');
  assert.equal(classifyAddress('100.64.0.1'), 'private');
  assert.equal(classifyAddress('169.254.1.1'), 'linkLocal');
  assert.equal(classifyAddress('169.254.169.254'), 'linkLocal');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('224.0.0.1'), 'multicast');
  assert.equal(classifyAddress('240.0.0.1'), 'reserved');
  assert.equal(classifyAddress('192.0.2.5'), 'reserved');
  assert.equal(classifyAddress('198.18.0.1'), 'reserved');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::'), 'unspecified');
  assert.equal(classifyAddress('fe80::1'), 'linkLocal');
  assert.equal(classifyAddress('fe80::1%eth0'), 'linkLocal');
  assert.equal(classifyAddress('fd00:ec2::254'), 'private');
  assert.equal(classifyAddress('fc00::1'), 'private');
  assert.equal(classifyAddress('2001:db8::1'), 'reserved');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'linkLocal');
  assert.equal(classifyAddress('::ffff:a9fe:a9fe'), 'linkLocal');
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:7f00:1'), 'loopback');
  assert.equal(classifyAddress('::ffff:10.0.0.1'), 'private');
  assert.equal(classifyAddress('example.test'), 'name');
  assert.equal(classifyEndpointHost('localhost'), 'loopback');
  assert.equal(classifyEndpointHost('app.localhost'), 'loopback');
  assert.equal(classifyEndpointHost('metadata.google.internal'), 'metadata');
  assert.equal(classifyEndpointHost('METADATA.GOOGLE.INTERNAL.'), 'metadata');
  assert.equal(classifyEndpointHost('metadata.goog'), 'metadata');
});

test('non-http endpoints, embedded credentials, fragments and control characters are rejected', async () => {
  await assert.rejects(requestJson('file:///etc/passwd'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('javascript:alert(1)'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('http://user:secret@127.0.0.1:1/'), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('http://127.0.0.1:1/#fragment', loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('http://127.0.0.1:1/\u0000', loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson(`http://127.0.0.1:1/${'a'.repeat(3000)}`, loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('', loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  await assert.rejects(requestJson('not a url', loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
  // An IPv6 zone identifier is not a valid http URL; it is refused before any
  // address classification happens.
  await assert.rejects(requestJson('http://[fe80::1%25eth0]/', loopback), error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT');
});

test('cloud metadata and link-local targets are refused and no configuration enables them', async () => {
  const alwaysForbidden = [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.10.20/',
    'http://0251.0376.0251.0376/',
    'http://2852039166/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://METADATA.GOOGLE.INTERNAL/computeMetadata/v1/',
    'http://metadata.goog/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://224.0.0.1/',
    'http://192.0.2.1/',
    'http://[2001:db8::1]/'
  ];
  for (const endpoint of alwaysForbidden) {
    await assert.rejects(requestJson(endpoint), error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN', endpoint);
    await assert.rejects(requestJson(endpoint, loopback), error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN', `${endpoint} must stay forbidden even with allowPrivateNetwork`);
  }
  await withEnv({ SPOOL_CLOUD_ALLOW_PRIVATE_ENDPOINTS: '1', SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS: '169.254.169.254,metadata.google.internal' }, async () => {
    await assert.rejects(requestJson('http://169.254.169.254/'), error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN');
    await assert.rejects(requestJson('http://metadata.google.internal/'), error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN');
  });
});

test('loopback and private targets need an explicit allowlist entry or opt-in', async () => {
  const privateTargets = [
    'http://127.0.0.1:1/',
    'http://127.8.9.10:1/',
    'http://localhost:1/',
    'http://app.localhost:1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://[::1]:1/',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]:1/'
  ];
  for (const endpoint of privateTargets) {
    await assert.rejects(
      requestJson(endpoint),
      error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN' && /SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS/.test(error.message),
      endpoint
    );
  }

  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, async (endpoint, port) => {
    await assert.rejects(
      requestJson(endpoint),
      error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN'
    );

    // Exact host:port allowlist entry permits that endpoint only.
    const allowed = await requestJson(endpoint, { allowedPrivateHosts: [`127.0.0.1:${port}`] });
    assert.deepEqual(await allowed.json(), { ok: true });

    // A different port in the entry does not grant access.
    await assert.rejects(
      requestJson(endpoint, { allowedPrivateHosts: [`127.0.0.1:${port + 1}`] }),
      error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN'
    );

    // The environment allowlist is honoured the same way.
    await withEnv({ SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS: `127.0.0.1:${port}` }, async () => {
      const viaEnv = await requestJson(endpoint);
      assert.equal(viaEnv.status, 200);
    });

    // A host-only entry also matches.
    const byHost = await requestJson(endpoint, { allowedPrivateHosts: ['127.0.0.1'] });
    assert.equal(byHost.status, 200);
  });
});

test('a hostname that resolves to a forbidden address is refused at resolution time', async () => {
  // `localhost` is not an IP literal, so this can only fail inside the guarded
  // lookup: the policy is applied to the resolved address, not to the URL text.
  await assert.rejects(
    requestJson('http://localhost:1/'),
    error => error.code === 'CLOUD_HTTP_ENDPOINT_FORBIDDEN'
  );

  const permissive = { allowPrivateNetwork: false, allowedPrivateHosts: new Set(['localhost']), requireTls: false };
  const lookup = createGuardedLookup(new URL('http://localhost:1/'), permissive);
  const resolved = await new Promise((resolve, reject) => {
    lookup('localhost', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.equal(classifyAddress(resolved.address), 'loopback', `expected a loopback address, got ${resolved.address}`);
  assert.ok(resolved.family === 4 || resolved.family === 6);

  const denied = createGuardedLookup(new URL('http://localhost:1/'), { allowPrivateNetwork: false, allowedPrivateHosts: new Set(), requireTls: false });
  const failure = await new Promise(resolve => {
    denied('localhost', {}, error => resolve(error ?? null));
  });
  assert.equal(failure?.code, 'CLOUD_HTTP_ENDPOINT_FORBIDDEN');
});

test('a DNS name is connected through the validated, pinned address', async () => {
  // Server bound on all interfaces so both `localhost` families are reachable;
  // success here proves the guarded lookup is used for the real connection.
  await withServer(
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"via":"dns"}'); },
    async (_endpoint, port) => {
      const response = await requestJson(`http://localhost:${port}/`, { allowedPrivateHosts: ['localhost'] });
      assert.deepEqual(await response.json(), { via: 'dns' });
    },
    { listenHost: null }
  );
});

test('an https requirement can be enforced by policy', async () => {
  await withEnv({ SPOOL_CLOUD_REQUIRE_TLS: '1' }, async () => {
    await assert.rejects(
      requestJson('http://127.0.0.1:1/', loopback),
      error => error.code === 'INVALID_CLOUD_HTTP_ENDPOINT' && /https/.test(error.message)
    );
  });
});

test('redirects are never followed', async () => {
  let redirectedRequests = 0;
  await withServer((req, res) => { redirectedRequests += 1; res.writeHead(200); res.end('{}'); }, async (_endpoint, targetPort) => {
    await withServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` });
      res.end('moved');
    }, async (endpoint) => {
      const response = await requestJson(endpoint, loopback);
      assert.equal(response.status, 302);
      assert.equal(response.ok, false);
      assert.equal(await response.text(), 'moved');
      assert.equal(redirectedRequests, 0, 'the transport must not follow a redirect');
    });
  });
});

test('a redirect to a forbidden address is returned, not followed', async () => {
  await withServer((req, res) => {
    res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  }, async endpoint => {
    const response = await requestJson(endpoint, loopback);
    assert.equal(response.status, 307);
    assert.equal(response.ok, false);
  });
});

test('the request body and response body are both bounded', async () => {
  await withServer((req, res) => {
    if (req.url === '/oversized-declared') {
      res.writeHead(200, { 'content-length': '4096' });
      res.end(Buffer.alloc(4096, 0x61));
      return;
    }
    if (req.url === '/oversized-streamed') {
      res.writeHead(200);
      res.end(Buffer.alloc(4096, 0x61));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, async endpoint => {
    await assert.rejects(
      requestJson(`${endpoint}/oversized-declared`, { ...loopback, maxBytes: 1024 }),
      error => error.code === 'CLOUD_HTTP_RESPONSE_TOO_LARGE'
    );
    await assert.rejects(
      requestJson(`${endpoint}/oversized-streamed`, { ...loopback, maxBytes: 1024 }),
      error => error.code === 'CLOUD_HTTP_RESPONSE_TOO_LARGE'
    );
    await assert.rejects(
      requestJson(`${endpoint}/echo`, { ...loopback, method: 'POST', body: 'x'.repeat(4096), maxRequestBytes: 1024 }),
      error => error.code === 'CLOUD_HTTP_REQUEST_TOO_LARGE'
    );
  });
});

test('a hung endpoint and a trickling response both hit the total deadline', async () => {
  await withServer((req, res) => {
    if (req.url === '/hang') return; // never responds
    if (req.url === '/trickle') {
      res.writeHead(200);
      res.write('a');
      const interval = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(interval));
      return;
    }
    res.writeHead(200);
    res.end('{}');
  }, async endpoint => {
    const started = Date.now();
    await assert.rejects(
      requestJson(`${endpoint}/hang`, { ...loopback, timeoutMs: 150 }),
      error => error.code === 'CLOUD_HTTP_TIMEOUT'
    );
    await assert.rejects(
      requestJson(`${endpoint}/trickle`, { ...loopback, timeoutMs: 200 }),
      error => error.code === 'CLOUD_HTTP_TIMEOUT'
    );
    assert.ok(Date.now() - started < 10_000, 'the deadline must bound the whole exchange');
  });
});

test('a bounded JSON response is returned unchanged', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true }));
  }, async endpoint => {
    const response = await requestJson(`${endpoint}/echo`, loopback);
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { received: true });
  });
});
