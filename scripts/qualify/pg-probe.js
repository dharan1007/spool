#!/usr/bin/env node
// Live PostgreSQL qualification probe for the standalone runner.
// Contract (stdout markers, parsed by scripts/qualify/run-standalone.js):
//   LIVE_PG_PROBE OK                followed by LIVE_PG_PROBE_META <json>
//   LIVE_PG_PROBE UNAVAILABLE       connection failed (exit 2)
//   LIVE_PG_PROBE INVALID           target identity/settings wrong (exit 4)
// Exit codes: 0 ok | 2 unreachable | 3 credentials missing | 4 invalid target | 5 query error.
// The password is never printed in any output or error.
import { Client } from 'pg';

function required(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function metaLine(fields) {
  return `LIVE_PG_PROBE_META ${JSON.stringify(fields)}`;
}

async function main() {
  const endpoint = required('SPOOL_TEST_POSTGRES_ENDPOINT');
  const database = required('SPOOL_TEST_POSTGRES_DATABASE');
  const user = required('SPOOL_TEST_POSTGRES_USER');
  const password = required('SPOOL_TEST_PG_PASSWORD');
  if (!endpoint || !database || !user || !password) {
    out('LIVE_PG_PROBE UNAVAILABLE reason=missing-credentials');
    process.exit(3);
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    out('LIVE_PG_PROBE UNAVAILABLE reason=malformed-endpoint');
    process.exit(3);
  }
  const host = url.hostname || null;
  const port = url.port ? Number(url.port) : 5432;
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    out('LIVE_PG_PROBE UNAVAILABLE reason=malformed-endpoint');
    process.exit(3);
  }

  const client = new Client({
    host,
    port,
    database,
    user,
    password,
    ssl: false,
    connectionTimeoutMillis: 10000
  });
  try {
    await client.connect();
  } catch (error) {
    const code = error?.code ?? 'connect-failed';
    out(`LIVE_PG_PROBE UNAVAILABLE host=${host} port=${port} code=${code}`);
    process.exit(2);
  }

  try {
    const identity = await client.query('SELECT current_database() AS db, current_user AS role, version() AS v');
    const row = identity.rows?.[0];
    if (!row || row.db !== database || row.role !== user) {
      out('LIVE_PG_PROBE INVALID reason=target-identity-mismatch');
      out(metaLine({ host, port, database: row?.db ?? null, user: row?.role ?? null }));
      process.exit(4);
    }
    const wal = await client.query('SHOW wal_level');
    const walLevel = wal.rows?.[0]?.wal_level ?? null;
    if (walLevel !== 'logical') {
      out(`LIVE_PG_PROBE INVALID reason=wal-level-not-logical wal_level=${walLevel ?? 'unknown'}`);
      process.exit(4);
    }
    const version = String(row.v ?? '').split(',')[0];
    out('LIVE_PG_PROBE OK');
    out(metaLine({ host, port, database, user, version, walLevel }));
    process.exit(0);
  } catch (error) {
    out(`LIVE_PG_PROBE UNAVAILABLE reason=query-failed code=${error?.code ?? 'query-failed'}`);
    process.exit(5);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  out(`LIVE_PG_PROBE UNAVAILABLE reason=probe-crashed code=${error?.code ?? 'probe-crashed'}`);
  process.exit(5);
});
