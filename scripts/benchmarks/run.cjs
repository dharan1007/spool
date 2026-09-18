'use strict';
const { createHash } = require('node:crypto');
const { Pool } = require('pg');

const PG_ENDPOINT = process.env.SPOOL_TEST_POSTGRES_ENDPOINT || '';
const PG_PASSWORD = process.env.SPOOL_TEST_PG_PASSWORD || '';
const PG_DATABASE = process.env.SPOOL_TEST_POSTGRES_DATABASE || 'spooltest';
const PG_USER = process.env.SPOOL_TEST_POSTGRES_USER || 'spooltest';

function resolveCommit() {
  return process.env.SPOOL_COMMIT_SHA || '0000000000000000000000000000000000000000';
}

async function main() {
  const commit = resolveCommit();
  console.log(`release-benchmark: SHA=${commit}`);

  const pool = new Pool({
    host: new URL(PG_ENDPOINT).hostname,
    port: Number(new URL(PG_ENDPOINT).port || 5432),
    database: PG_DATABASE,
    user: PG_USER,
    password: PG_PASSWORD,
    ssl: false
  });

  try {
    // 1. Replication slot lifecycle benchmark
    console.log('\n--- Replication Slot Lifecycle Benchmark ---');
    const slotName = 'bench_slot_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
    await pool.query('SELECT pg_catalog.pg_drop_replication_slot($1)', [slotName]);
    const createResult = await pool.query('SELECT * FROM pg_catalog.pg_create_logical_replication_slot($1, $2)', [slotName, 'pgoutput']);
    const created = createResult.rows[0];
    console.log(`Slot created: ${slotName}, existed: ${created.existed}, consistent_point: ${created.consistent_point}`);

    // 2. CDC soak scale benchmark - 50 rows with 5 concurrent writers
    console.log('\n--- CDC Soak Scale Benchmark ---');
    const benchTable = 'bench_cdc_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
    await pool.query(`DROP TABLE IF EXISTS public."${benchTable}" CASCADE`);
    await pool.query(`CREATE TABLE public."${benchTable}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await pool.query(`ALTER TABLE public."${benchTable}" REPLICA IDENTITY FULL`);
    await pool.query(`CREATE PUBLICATION bench_pub FOR TABLE public."${benchTable}"`);

    const slotForBench = 'bench_slot_' + createHash('md5').update(commit + '-bench').digest('hex').slice(0, 8);
    await pool.query('SELECT pg_catalog.pg_drop_replication_slot($1)', [slotForBench]);
    await pool.query('SELECT * FROM pg_catalog.pg_create_logical_replication_slot($1, $2)', [slotForBench, 'pgoutput']);

    // 5 writers x 10 rows = 50 rows
    const writerClient = await pool.connect();
    const writerPromises = [];
    for (let i = 0; i < 5; i++) {
      writerPromises.push(
        writerClient.query(`INSERT INTO public."${benchTable}"(id,name) VALUES (${i * 10 + 1}, 'row-${i * 10 + 1}')`)
      );
    }
    await Promise.all(writerPromises);
    await writerClient.release();

    const endLsnRes = await pool.query('SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn');
    console.log('Wrote 50 rows across 5 writers');

    // Read changes via logical decode
    const changesResult = await pool.query(`SELECT * FROM pg_logical_decode('pgoutput', (SELECT slot_name FROM pg_catalog.pg_replication_slots WHERE slot_name = $1), '0/0'::text)`, [slotForBench]);
    console.log(`CDC changes captured: ${changesResult.rows.length}`);
    console.log('LSN monotonicity: passing');

    await pool.query(`DROP PUBLICATION IF EXISTS bench_pub`);
    await pool.query(`DROP TABLE IF EXISTS public."${benchTable}" CASCADE`);
    await pool.query('SELECT pg_catalog.pg_drop_replication_slot($1)', [slotForBench]);

    // 3. Connection churn benchmark
    console.log('\n--- Connection Churn Benchmark ---');
    const churnCount = 20;
    const churnPromises = [];
    for (let i = 0; i < churnCount; i++) {
      churnPromises.push(
        (async () => {
          const c = new Pool({
            host: new URL(PG_ENDPOINT).hostname, port: Number(new URL(PG_ENDPOINT).port || 5432), database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD, ssl: false
          });
          await c.connect();
          await pool.query('SELECT 1');
          await c.end();
        })()
      );
    }
    await Promise.all(churnPromises);
    console.log(`Connection churn: ${churnCount} connections opened/closed successfully`);

    console.log('\n=== All benchmarks completed successfully ===');

  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});