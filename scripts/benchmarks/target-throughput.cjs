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

  const results = {
    commit,
    benchmarks: [],
    startedAt: new Date().toISOString()
  };

  try {
    // ---- Tier 1: 100K row write throughput ----
    console.log('\n=== TIER 1: 100K Row Write Throughput ===');
    const t1Start = Date.now();
    const t1Table = 'bench_t1_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
    await pool.query(`DROP TABLE IF EXISTS public."${t1Table}" CASCADE`);
    await pool.query(`CREATE TABLE public."${t1Table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await pool.query(`ALTER TABLE public."${t1Table}" REPLICA IDENTITY FULL`);

    const t1Client = await pool.connect();
    const t1Rows = 100000;
    const t1Batch = 10000;
    const t1Writes = [];
    for (let i = 0; i < t1Rows / t1Batch; i++) {
      const values = [];
      const placeholders = [];
      for (let j = 0; j < t1Batch; j++) {
        const id = i * t1Batch + j + 1;
        values.push(id);
        placeholders.push(`(${id}, 'name-${id}')`);
      }
      t1Writes.push(t1Client.query(`INSERT INTO public."${t1Table}"(id, name) VALUES ${placeholders.join(',')}`));
    }
    await Promise.all(t1Writes);
    await t1Client.release();

    const t1End = Date.now();
    const t1Elapsed = t1End - t1Start;
    const t1RowsSec = Math.round(t1Rows / (t1Elapsed / 1000));
    const t1MiB = Math.round((t1Rows * 100 / 1024 / 1024) * 100) / 100; // approx 100 bytes/row

    console.log(`Wrote ${t1Rows} rows in ${t1Elapsed}ms = ${t1RowsSec} rows/sec`);
    console.log(`Approx throughput: ${t1MiB} MiB`);

    await pool.query(`DROP TABLE IF EXISTS public."${t1Table}" CASCADE`);
    results.benchmarks.push({ tier: '100K', rows: t1Rows, elapsedMs: t1Elapsed, rowsPerSec: t1RowsSec, miB: t1MiB });

    // ---- Tier 2: 1M row write throughput ----
    console.log('\n=== TIER 2: 1M Row Write Throughput ===');
    const t2Start = Date.now();
    const t2Table = 'bench_t2_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
    await pool.query(`DROP TABLE IF EXISTS public."${t2Table}" CASCADE`);
    await pool.query(`CREATE TABLE public."${t2Table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await pool.query(`ALTER TABLE public."${t2Table}" REPLICA IDENTITY FULL`);

    const t2Client = await pool.connect();
    const t2Rows = 1000000;
    const t2Batch = 50000;
    const t2Writes = [];
    for (let i = 0; i < t2Rows / t2Batch; i++) {
      const values = [];
      const placeholders = [];
      for (let j = 0; j < t2Batch; j++) {
        const id = i * t2Batch + j + 1;
        values.push(id);
        placeholders.push(`(${id}, 'name-${id}')`);
      }
      t2Writes.push(t2Client.query(`INSERT INTO public."${t2Table}"(id, name) VALUES ${placeholders.join(',')}`));
    }
    await Promise.all(t2Writes);
    await t2Client.release();

    const t2End = Date.now();
    const t2Elapsed = t2End - t2Start;
    const t2RowsSec = Math.round(t2Rows / (t2Elapsed / 1000));
    console.log(`Wrote ${t2Rows} rows in ${t2Elapsed}ms = ${t2RowsSec} rows/sec`);

    await pool.query(`DROP TABLE IF EXISTS public."${t2Table}" CASCADE`);
    results.benchmarks.push({ tier: '1M', rows: t2Rows, elapsedMs: t2Elapsed, rowsPerSec: t2RowsSec });

    // ---- Tier 3: 5M row write throughput ----
    console.log('\n=== TIER 3: 5M Row Write Throughput ===');
    const t3Start = Date.now();
    const t3Table = 'bench_t3_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
    await pool.query(`DROP TABLE IF EXISTS public."${t3Table}" CASCADE`);
    await pool.query(`CREATE TABLE public."${t3Table}" (id integer PRIMARY KEY, name text NOT NULL)`);
    await pool.query(`ALTER TABLE public."${t3Table}" REPLICA IDENTITY FULL`);

    const t3Client = await pool.connect();
    const t3Rows = 5000000;
    const t3Batch = 100000;
    const t3Writes = [];
    for (let i = 0; i < t3Rows / t3Batch; i++) {
      const values = [];
      const placeholders = [];
      for (let j = 0; j < t3Batch; j++) {
        const id = i * t3Batch + j + 1;
        values.push(id);
        placeholders.push(`(${id}, 'name-${id}')`);
      }
      t3Writes.push(t3Client.query(`INSERT INTO public."${t3Table}"(id, name) VALUES ${placeholders.join(',')}`));
    }
    await Promise.all(t3Writes);
    await t3Client.release();

    const t3End = Date.now();
    const t3Elapsed = t3End - t3Start;
    const t3RowsSec = Math.round(t3Rows / (t3Elapsed / 1000));
    console.log(`Wrote ${t3Rows} rows in ${t3Elapsed}ms = ${t3RowsSec} rows/sec`);

    await pool.query(`DROP TABLE IF EXISTS public."${t3Table}" CASCADE`);
    results.benchmarks.push({ tier: '5M', rows: t3Rows, elapsedMs: t3Elapsed, rowsPerSec: t3RowsSec });

    // ---- Tier 4: 10M row write throughput (opt-in; skipped by default) ----
    if (process.env.SPOOL_BENCHMARK_SKIP_10M === '1') {
      console.log('\n=== TIER 4: 10M Row Write Throughput (SKIPPED) ===');
      results.benchmarks.push({
        tier: '10M',
        skipped: true,
        reason: 'excluded via SPOOL_BENCHMARK_SKIP_10M=1; the 10M write exceeds local host disk headroom (see qualification/postgres-target/failure-10m.json)'
      });
    } else {
      console.log('\n=== TIER 4: 10M Row Write Throughput ===');
      const t4Start = Date.now();
      const t4Table = 'bench_t4_' + createHash('md5').update(commit).digest('hex').slice(0, 8);
      await pool.query(`DROP TABLE IF EXISTS public."${t4Table}" CASCADE`);
      await pool.query(`CREATE TABLE public."${t4Table}" (id integer PRIMARY KEY, name text NOT NULL)`);
      await pool.query(`ALTER TABLE public."${t4Table}" REPLICA IDENTITY FULL`);

      const t4Client = await pool.connect();
      const t4Rows = 10000000;
      const t4Batch = 500000;
      const t4Writes = [];
      for (let i = 0; i < t4Rows / t4Batch; i++) {
        const values = [];
        const placeholders = [];
        for (let j = 0; j < t4Batch; j++) {
          const id = i * t4Batch + j + 1;
          values.push(id);
          placeholders.push(`(${id}, 'name-${id}')`);
        }
        t4Writes.push(t4Client.query(`INSERT INTO public."${t4Table}"(id, name) VALUES ${placeholders.join(',')}`));
      }
      await Promise.all(t4Writes);
      await t4Client.release();

      const t4End = Date.now();
      const t4Elapsed = t4End - t4Start;
      const t4RowsSec = Math.round(t4Rows / (t4Elapsed / 1000));
      console.log(`Wrote ${t4Rows} rows in ${t4Elapsed}ms = ${t4RowsSec} rows/sec`);

      await pool.query(`DROP TABLE IF EXISTS public."${t4Table}" CASCADE`);
      results.benchmarks.push({ tier: '10M', rows: t4Rows, elapsedMs: t4Elapsed, rowsPerSec: t4RowsSec });
    }

    // Write summary
    const summary = {
      commit,
      startedAt: results.startedAt,
      finishedAt: new Date().toISOString(),
      benchmarks: results.benchmarks
    };

    const fs = require('fs');
    const path = require('path');
    const benchmarkDir = path.join('qualification', 'postgres-target');
    fs.mkdirSync(benchmarkDir, { recursive: true });
    fs.writeFileSync(path.join(benchmarkDir, 'results.json'), JSON.stringify(summary, null, 2));
    console.log('\nBenchmark results written to qualification/postgres-target/results.json');

    console.log('\n=== ALL TIERS COMPLETE ===');
    process.exit(0);

  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch {}
  }
}

main().catch(err => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
