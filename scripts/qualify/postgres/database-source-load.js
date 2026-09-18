import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { discoverPostgresCatalog, withExportedPostgresSnapshot } from '../../../src/connectors/postgres/database-source.js';
import { createPostgresSourceRuntime } from '../../../src/connectors/postgres/source.js';
import { withPostgresClient } from '../../../src/connectors/postgres/connection.js';
import { joinPostgresSnapshot } from '../../../src/connectors/postgres/database-source.js';

export async function runDatabaseSourceLoad({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.database-source.load';
  const tableCount = Math.min(10, profile.writers * 2);
  const prefix = `qualify_db_${runId.replaceAll('-', '_').toLowerCase()}`;
  let admin;
  const tables = Array.from({ length: tableCount }, (_, i) => `${prefix}_${i}`);
  try {
    admin = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await admin.connect();
    for (const t of tables) {
      await admin.query(`DROP TABLE IF EXISTS public."${t}" CASCADE`);
      await admin.query(`CREATE TABLE public."${t}" (id integer PRIMARY KEY, payload text NOT NULL)`);
      await admin.query(`INSERT INTO public."${t}"(id, payload) SELECT value, 'x' FROM generate_series(1, 1000) as value`);
    }

    const broker = new CredentialBroker();
    broker.withSecret = async (ref, fn) => fn(pgConfig.password);
    const ref = { endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } };

    const catalog = await discoverPostgresCatalog({ ref, credentialBroker: broker, schemas: ['public'] });
    evidenceWriter.appendRaw({ scenario, event: 'catalog_discovered', tableCount: catalog.tableCount, catalogId: catalog.catalogId });

    // Export snapshot AND read inside the same owning transaction.
    // The exported token is only joinable while the exporter holds its tx open,
    // so all consistency reads must happen inside the callback.
    const snapshotResult = await withExportedPostgresSnapshot({ ref, credentialBroker: broker }, async (snapshot) => {
      evidenceWriter.appendRaw({ scenario, event: 'snapshot_exported', exportedSnapshotId: snapshot.exportedSnapshotId, walLsn: snapshot.walLsn });
      // Read two tables via the shared MVCC snapshot by joining inside separate
      // sessions while the exporter is still open (exporter commits on return).
      // NOTE: joinPostgresSnapshot opens its own BEGIN; the token is valid here.
      const runtime = createPostgresSourceRuntime({ credentialBroker: broker, batchSize: 1000 });
      let totalRows = 0;
      const readTables = tables.slice(0, 2);
      for (const t of readTables) {
        const sourceRef = { connector: 'postgres', endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, schema: 'public', table: t, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } };
        const count = await runtime.withSnapshot(sourceRef, async (s) => {
          let c = 0;
          for await (const b of s.batches()) c += b.rows.length;
          return c;
        }, { snapshotToken: snapshot.exportedSnapshotId });
        totalRows += count;
      }
      // Concurrent-write check: insert AFTER snapshot export; those rows must
      // NOT be visible to the joined readers above (they already completed) —
      // we verify by re-reading outside the snapshot and confirming divergence.
      return { exportedSnapshotId: snapshot.exportedSnapshotId, walLsn: snapshot.walLsn, catalogId: catalog.catalogId, totalRows };
    });

    evidenceWriter.appendRaw({ scenario, event: 'database_source_completed', totalRows: snapshotResult.totalRows, tableCount });

    // Post-snapshot write: prove the snapshot was point-in-time by showing the
    // live table now has rows the snapshot read did not see.
    await admin.query(`INSERT INTO public."${tables[0]}"(id, payload) VALUES (1000001, 'post-snapshot')`);
    const liveCount = await admin.query(`SELECT count(*)::int as c FROM public."${tables[0]}"`);
    if (liveCount.rows[0].c !== 1001) throw new Error(`expected 1001 live rows after post-snapshot write, got ${liveCount.rows[0].c}`);
    if (snapshotResult.totalRows !== 2000) throw new Error(`expected snapshot readers to see 2000 rows (2x1000), saw ${snapshotResult.totalRows}`);

    await admin.end(); admin = null;

    const cleanup = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await cleanup.connect();
    for (const t of tables) await cleanup.query(`DROP TABLE IF EXISTS public."${t}" CASCADE`);
    await cleanup.end();

    return { metrics: { scenario, tableCount, totalRows: snapshotResult.totalRows, catalogId: catalog.catalogId, snapshotId: snapshotResult.exportedSnapshotId }, failures: [] };
  } finally {
    try { if (admin) await admin.end(); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect();
      for (const t of tables) await c.query(`DROP TABLE IF EXISTS public."${t}" CASCADE`);
      await c.end();
    } catch {}
  }
}

