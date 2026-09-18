import { Client } from 'pg';

export async function runLargeTransactions({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.largeTransactions';
  const sizes = [1, 100, 10000, 100000].filter(n => n <= profile.largeTransactionRows);
  const table = `qualify_large_tx_${runId.replaceAll('-', '_').toLowerCase()}`;
  let client;
  const results = [];
  try {
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.end(); client = null;

    for (const size of sizes) {
      const start = process.hrtime.bigint();
      let memBefore = process.memoryUsage().rss;
      client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await client.connect();
      await client.query('BEGIN');
      for (let i = 0; i < size; i += 1000) {
        const batch = Math.min(1000, size - i);
        const values = Array.from({ length: batch }, (_, j) => `(${i + j + 1}, 'x')`).join(',');
        await client.query(`INSERT INTO public."${table}"(id, payload) VALUES ${values} ON CONFLICT DO NOTHING`);
      }
      await client.query('COMMIT');
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const memAfter = process.memoryUsage().rss;
      const cnt = await client.query(`SELECT count(*)::int as c FROM public."${table}"`);
      await client.query(`TRUNCATE public."${table}"`);
      await client.end(); client = null;
      const r = { size, durationMs: ms, rowsPerSec: size / (ms / 1000), memDeltaBytes: memAfter - memBefore, count: cnt.rows[0].c };
      results.push(r);
      evidenceWriter.appendRaw({ scenario, event: 'large_tx', size, durationMs: ms, rowsPerSec: r.rowsPerSec });
    }
    return { metrics: { scenario, results, largestTransaction: Math.max(...sizes) }, failures: [] };
  } finally {
    try { if (client) await client.end(); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect(); await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); await c.end();
    } catch {}
  }
}

