import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { generateApiKey } from '../src/platform/api-keys.js';
import { createSpoolDaemonV2 } from '../src/daemon/spoold-v2.js';

test('REST API v2 High-Concurrency Stress Test', async () => {
  const { key, hash } = generateApiKey();
  const apiKeyStore = new Map([[hash, { role: 'admin' }]]);
  const mockService = {
    history: () => [{ migrationId: 'mig_stress', status: 'COMPLETE' }]
  };

  const server = createSpoolDaemonV2({
    service: mockService,
    token: '0123456789abcdef0123456789abcdef',
    apiKeyStore
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const TOTAL_REQUESTS = 600;
  const CONCURRENCY = 30;
  const latencies = [];
  let successfulRequests = 0;
  let failedRequests = 0;

  console.log(`Executing ${TOTAL_REQUESTS} requests across endpoints with concurrency ${CONCURRENCY}...`);
  const startTime = Date.now();

  const endpoints = [
    { path: '/v2/health', auth: false },
    { path: '/v2/ready', auth: false },
    { path: '/v2/metrics', auth: false },
    { path: '/v2/migrations', auth: true }
  ];

  async function worker(queue) {
    while (queue.length > 0) {
      const item = queue.pop();
      if (item === undefined) break;
      const target = endpoints[item % endpoints.length];
      const headers = target.auth ? { 'X-API-Key': key } : {};
      const t0 = performance.now();
      try {
        const res = await fetch(`${baseUrl}${target.path}`, { headers });
        const t1 = performance.now();
        latencies.push(t1 - t0);
        if (res.status === 200) {
          successfulRequests++;
        } else {
          failedRequests++;
        }
      } catch {
        failedRequests++;
      }
    }
  }

  const taskQueue = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i);
  const workers = Array.from({ length: CONCURRENCY }, () => worker(taskQueue));
  await Promise.all(workers);

  const durationSec = (Date.now() - startTime) / 1000;
  server.close();

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);
  const throughput = Math.round(TOTAL_REQUESTS / durationSec);

  console.log(`Stress Test Results:`);
  console.log(`- Total Requests: ${TOTAL_REQUESTS}`);
  console.log(`- Success Rate: ${((successfulRequests / TOTAL_REQUESTS) * 100).toFixed(1)}%`);
  console.log(`- Throughput: ${throughput} req/sec`);
  console.log(`- Latency p50: ${p50} ms | p95: ${p95} ms | p99: ${p99} ms`);

  assert.equal(failedRequests, 0);
  assert.equal(successfulRequests, TOTAL_REQUESTS);

  const evidence = {
    test: 'REST_API_STRESS_TEST',
    timestamp: new Date().toISOString(),
    totalRequests: TOTAL_REQUESTS,
    concurrency: CONCURRENCY,
    successRate: 100,
    throughputReqPerSec: throughput,
    latencyMs: { p50: parseFloat(p50), p95: parseFloat(p95), p99: parseFloat(p99) }
  };

  await writeFile(
    'C:\\temp\\spool-console\\.console-evidence\\api-stress-results.json',
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8'
  );
});
