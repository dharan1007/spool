import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../src/daemon/credential-broker.js';
import {
  PostgresTarget,
  ensurePostgresMetadata,
  invalidatePostgresMetadataCache
} from '../src/connectors/postgres/target.js';
import { inspectPostgresTarget } from '../src/connectors/postgres/preflight.js';

const endpoint = process.env.SPOOL_TEST_POSTGRES_ENDPOINT ?? '';
const database = process.env.SPOOL_TEST_POSTGRES_DATABASE ?? 'spooltest';
const user = process.env.SPOOL_TEST_POSTGRES_USER ?? 'spooltest';
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? '';
const enabled = Boolean(endpoint && password);
const secretRef = { provider: 'env', key: 'SPOOL_TEST_PG_PASSWORD' };
const broker = new CredentialBroker();

function ref(table) {
  return {
    connector: 'postgres',
    connectionId: 'industrial-redteam',
    endpoint,
    database,
    schema: 'public',
    table,
    identity: { user },
    secretRef
  };
}

async function admin() {
  const url = new URL(endpoint);
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database,
    user,
    password,
    ssl: false
  });
  await client.connect();
  return client;
}

const H = value => 'sha256:' + value.repeat(64);
let identitySeq = 0;
function input(table, contractId, mutations) {
  identitySeq += 1;
  const n = (identitySeq % 15).toString(16);
  return {
    migrationId: 'industrial-redteam',
    planId: H('1'),
    sourceSnapshotId: H('2'),
    mappingRevision: 1,
    targetContractId: contractId,
    transactionIdentity: H(n),
    xid: identitySeq,
    beginLsn: '0/10',
    commitLsn: '0/20',
    mutationCount: mutations.length,
    payloadHash: H('3'),
    primaryKey: ['id'],
    mutations
  };
}

test('cached target contract cannot allow newly-created trigger to partially suppress CDC writes', { skip: !enabled, timeout: 120_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const table = `rt_contract_${suffix}`;
  const fn = `rt_suppress_${suffix}`;
  const trigger = `rt_trigger_${suffix}`;
  const targetRef = ref(table);
  const client = await admin();
  t.after(async () => {
    try { await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); } catch {}
    try { await client.query(`DROP FUNCTION IF EXISTS public."${fn}"() CASCADE`); } catch {}
    await client.end();
    invalidatePostgresMetadataCache(targetRef);
  });

  await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
  const preflight = await inspectPostgresTarget({
    targetRef,
    targetSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'payload', type: 'string', nullable: false }
    ],
    credentialBroker: broker
  });
  await ensurePostgresMetadata({ targetRef, credentialBroker: broker });

  const target = new PostgresTarget({ targetRef, credentialBroker: broker, requireFencing: false });

  // Warm the process-global target-contract cache with a legitimate commit.
  await target.commitCdcTransaction(input(table, preflight.targetContractId, [
    { op: 'upsert', row: { id: 1, payload: 'warm' } }
  ]));

  // Drift the target inside the 10-second contract-cache window. The trigger
  // suppresses exactly one row, so a weak "at least one RETURNING row" proof
  // can still pass while target contents diverge.
  await client.query(`
    CREATE FUNCTION public."${fn}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = 3 THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END
    $$`);
  await client.query(`
    CREATE TRIGGER "${trigger}"
    BEFORE INSERT OR UPDATE ON public."${table}"
    FOR EACH ROW EXECUTE FUNCTION public."${fn}"()
  `);

  let accepted = false;
  try {
    await target.commitCdcTransaction(input(table, preflight.targetContractId, [
      { op: 'upsert', row: { id: 2, payload: 'must-exist' } },
      { op: 'upsert', row: { id: 3, payload: 'must-also-exist' } }
    ]));
    accepted = true;
  } catch (error) {
    // A correct implementation must fail closed on the changed contract.
    assert.match(String(error?.code ?? error?.message ?? error), /TARGET_CONTRACT_CHANGED|TARGET_TRIGGER_UNSUPPORTED|SCHEMA_DRIFT/);
  }

  const rows = await client.query(`SELECT id, payload FROM public."${table}" ORDER BY id`);
  if (accepted) {
    assert.deepEqual(
      rows.rows.map(r => Number(r.id)),
      [1, 2, 3],
      'COMMITTED_EXACT was returned even though a concurrently-added trigger suppressed one CDC mutation'
    );
  }
});

test('contract-validation cache key must be endpoint/identity scoped, not database.schema.table only', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/connectors/postgres/target.js', import.meta.url), 'utf8')
  );
  const body = /function contractCacheKey\(targetRef\)\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  assert.match(body, /endpoint|connectionId|identity|connector/i,
    'target-contract cache can alias distinct PostgreSQL servers that share database/schema/table names');
});
