import test from 'node:test';
import assert from 'node:assert/strict';
import { claimWorkerLease, heartbeatWorkerLease, releaseWorkerLease } from '../src/connectors/postgres/workers.js';

const ref = {
  endpoint: 'postgresql://127.0.0.1:5432/?sslmode=disable',
  database: 'spooltest',
  identity: { user: 'spooltest' },
  secretRef: { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' }
};
const broker = { withSecret: async () => { throw new Error('must not reach the database'); } };

test('worker claims validate identity material before touching the database', async () => {
  await assert.rejects(() => claimWorkerLease({ ref, credentialBroker: broker, resource: 'p', workerId: 'HAS SPACE', ttlMs: 1000 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => claimWorkerLease({ ref, credentialBroker: broker, resource: '', workerId: 'worker-a', ttlMs: 1000 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => claimWorkerLease({ ref, credentialBroker: broker, resource: 'p', workerId: 'worker-a', ttlMs: 0 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => claimWorkerLease({ ref, credentialBroker: {}, resource: 'p', workerId: 'worker-a', ttlMs: 1000 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => heartbeatWorkerLease({ ref, credentialBroker: broker, resource: 'p', workerId: '', ttlMs: 1000 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => releaseWorkerLease({ ref, credentialBroker: broker, resource: 'p', workerId: 'worker-a', fencingToken: 0 }), /INVALID_WORKER_CLAIM/);
  await assert.rejects(() => claimWorkerLease({ ref: null, credentialBroker: broker, resource: 'p', workerId: 'worker-a', ttlMs: 1000 }), /INVALID_WORKER_CLAIM/);
});
