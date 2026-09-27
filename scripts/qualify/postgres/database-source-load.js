import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { discoverPostgresCatalog, withExportedPostgresSnapshot } from '../../../src/connectors/postgres/database-source.js';
import { createPostgresSourceRuntime } from '../../../src/connectors/postgres/source.js';
import { withPostgresClient } from '../../../src/connectors/postgres/connection.js';
import { joinPostgresSnapshot } from '../../../src/connectors/postgres/database-source.js';


// PostgreSQL truncates identifiers past 63 characters: all scenario table
// names derive from a short deterministic hash so expected names always
// equal live names and parallel runs cannot collide on truncation.
function shortKey(seed, runId) {
  return createHash('sha256').update(`qualify-${seed}-${runId}`).digest('hex').slice(0, 12);
}

export async function runDatabaseSourceLoad({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.database-source.load';
  const tableCount = profile.writers * 2;
  const effectiveConfig = { writers: profile.writers };
  const prefix = `qualify_db_${shortKey(seed, runId)}`;
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

    // The exporter must remain open while all child sessions join its MVCC
    // snapshot. A write performed AFTER the snapshot closes proves nothing.
    const snapshotResult = await withExportedPostgresSnapshot({ ref, credentialBroker: broker }, async snapshot => {
      evidenceWriter.appendRaw({ scenario, event: 'snapshot_exported',
        exportedSnapshotId: snapshot.exportedSnapshotId, walLsn: snapshot.walLsn });

      // An INDEPENDENT admin session commits post-export mutations BEFORE
      // any child reader joins. Every live table now has 1001 rows while
      // every reader joined to the old snapshot must still see 1000.
      for (const t of tables) {
        await admin.query(`INSERT INTO public."${t}"(id, payload) VALUES (1000001, 'post-snapshot')`);
      }

      // Exactly profile.writers concurrent sessions, each joining two tables.
      // The old harness created 2*writers tables but silently read only two.
      const runtime = createPostgresSourceRuntime({ credentialBroker: broker, batchSize: 1000 });
      const readerStats = await Promise.all(Array.from({ length: profile.writers }, async (_, wi) => {
        let readRows = 0;
        for (const t of tables.slice(wi * 2, wi * 2 + 2)) {
          const sourceRef = {
            connector: 'postgres', endpoint: ref.endpoint, database: pgConfig.database,
            schema: 'public', table: t, identity: { user: pgConfig.user },
            secretRef: { provider: 'env', key: 'PGPASSWORD' }
          };
          const count = await runtime.withSnapshot(sourceRef, async joined => {
            let c = 0;
            for await (const batch of joined.batches()) c += batch.rows.length;
            return c;
          }, { snapshotToken: snapshot.exportedSnapshotId });
          if (count !== 1000) {
            throw new Error(`Joined reader ${wi} observed ${count} rows in ${t}; exported snapshot should contain 1000`);
          }
          readRows += count;
        }
        return { writer: wi, rows: readRows, tablesRead: 2 };
      }));
      const totalRows = readerStats.reduce((total, reader) => total + reader.rows, 0);
      if (readerStats.length !== profile.writers || totalRows !== tableCount * 1000) {
        throw new Error('Exported-snapshot fanout did not execute its full declared reader count');
      }

      // Prove the writes were real and visible outside the exported snapshot,
      // while all joined readers above saw only the pre-export rows.
      for (const t of tables) {
        const live = await admin.query(`SELECT count(*)::int AS c FROM public."${t}"`);
        if (live.rows[0]?.c !== 1001) {
          throw new Error(`Post-export write was not visible to an independent session for ${t}`);
        }
      }
      return {
        exportedSnapshotId: snapshot.exportedSnapshotId,
        walLsn: snapshot.walLsn, catalogId: catalog.catalogId, totalRows,
        joinedReaders: readerStats.length,
        tablesRead: readerStats.reduce((total, reader) => total + reader.tablesRead, 0),
        postExportWrites: tables.length
      };
    });

    evidenceWriter.appendRaw({ scenario, event: 'database_source_completed',
      totalRows: snapshotResult.totalRows, tableCount, joinedReaders: snapshotResult.joinedReaders,
      tablesRead: snapshotResult.tablesRead, postExportWrites: snapshotResult.postExportWrites });

    await admin.end(); admin = null;

    const cleanup = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await cleanup.connect();
    for (const t of tables) await cleanup.query(`DROP TABLE IF EXISTS public."${t}" CASCADE`);
    await cleanup.end();

    return { metrics: { scenario, requestedConfig: { writers: profile.writers }, effectiveConfig, tableCount, totalRows: snapshotResult.totalRows, joinedReaders: snapshotResult.joinedReaders, tablesRead: snapshotResult.tablesRead, postExportWrites: snapshotResult.postExportWrites, catalogId: catalog.catalogId, snapshotId: snapshotResult.exportedSnapshotId }, failures: [] };
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

