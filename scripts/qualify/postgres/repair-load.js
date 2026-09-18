import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { CredentialBroker } from '../../../src/daemon/credential-broker.js';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';
import { writeDatasetCsv, datasetId } from '../dataset.js';
import { rowsPerSecond, mibPerSecond } from '../metrics.js';

export async function runRepairLoad({ profile, seed, evidenceWriter, pgConfig, runId }) {
  const scenario = 'postgres.repair.load';
  const rowCount = Math.min(profile.rows, 200_000);
  const payloadBytes = profile.payloadBytes;
  const batchSize = profile.batchSize;
  const sourceRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-source-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'spool-qualify-target-'));
  const statePath = join(targetRoot, `state-${runId}-repair.db`);
  const snapshotDir = join(tmpdir(), `spool-qualify-snap-${runId}-repair`);
  const csvPath = join(sourceRoot, 'dataset.csv');
  let client, service;
  const table = `qualify_repair_${runId.replaceAll('-', '_').toLowerCase()}`;

  try {
    const did = datasetId({ seed: seed + '-repair', rowCount, payloadBytes });
    await writeDatasetCsv({ seed: seed + '-repair', rowCount, payloadBytes, filePath: csvPath });
    evidenceWriter.appendRaw({ scenario, event: 'dataset_generated', datasetId: did, rowCount });

    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    await client.query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, tenant_id integer NOT NULL, external_id text NOT NULL, name text NOT NULL, email text NOT NULL, status text NOT NULL, integer_value text NOT NULL, decimal_value text NOT NULL, boolean_value text NOT NULL, timestamp_value text NOT NULL, nullable_value text, unicode_value text NOT NULL, json_value text NOT NULL, payload text NOT NULL, updated_at text NOT NULL)`);
    await client.end(); client = null;

    const broker = new CredentialBroker();
    broker.withSecret = async (ref, fn) => fn(pgConfig.password);
    service = await SpoolCommandService.create({
      sourceRoot, targetRoot, statePath, snapshotDir,
      approvalSigningKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      release: { version: '1.1.1', commitSha: process.env.SPOOL_COMMIT_SHA ?? 'unknown' },
      credentialBroker: broker, maxSourceBytes: 1024 * 1024 * 1024
    });

    // Initial load with content_exact for repair
    const request = {
      migrationId: `qualify-repair-${runId}`,
      principal: 'qualify:repair',
      planInput: {
        planRevision: 1,
        sourceRef: { connector: 'filesystem', connectionId: 'src', resource: 'dataset.csv', path: csvPath },
        targetRef: { connector: 'postgres', connectionId: 'pg', resource: `public.${table}`, endpoint: `postgresql://${pgConfig.host}:${pgConfig.port}?sslmode=disable`, database: pgConfig.database, schema: 'public', table, identity: { user: pgConfig.user }, secretRef: { provider: 'env', key: 'PGPASSWORD' } },
        targetSchema: [
          { name: 'id', type: 'integer', nullable: false }, { name: 'tenant_id', type: 'integer', nullable: false }, { name: 'external_id', type: 'string', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'email', type: 'string', nullable: false }, { name: 'status', type: 'string', nullable: false }, { name: 'integer_value', type: 'string', nullable: false }, { name: 'decimal_value', type: 'string', nullable: false }, { name: 'boolean_value', type: 'string', nullable: false }, { name: 'timestamp_value', type: 'string', nullable: false }, { name: 'nullable_value', type: 'string', nullable: true }, { name: 'unicode_value', type: 'string', nullable: false }, { name: 'json_value', type: 'string', nullable: false }, { name: 'payload', type: 'string', nullable: false }, { name: 'updated_at', type: 'string', nullable: false }
        ],
        mapping: [
          { target: 'id', expr: { op: 'cast_number', value: { op: 'field', name: 'id' } } }, { target: 'tenant_id', expr: { op: 'cast_number', value: { op: 'field', name: 'tenant_id' } } }, { target: 'external_id', expr: { op: 'field', name: 'external_id' } }, { target: 'name', expr: { op: 'field', name: 'name' } }, { target: 'email', expr: { op: 'field', name: 'email' } }, { target: 'status', expr: { op: 'field', name: 'status' } }, { target: 'integer_value', expr: { op: 'field', name: 'integer_value' } }, { target: 'decimal_value', expr: { op: 'field', name: 'decimal_value' } }, { target: 'boolean_value', expr: { op: 'field', name: 'boolean_value' } }, { target: 'timestamp_value', expr: { op: 'field', name: 'timestamp_value' } }, { target: 'nullable_value', expr: { op: 'field', name: 'nullable_value' } }, { target: 'unicode_value', expr: { op: 'field', name: 'unicode_value' } }, { target: 'json_value', expr: { op: 'field', name: 'json_value' } }, { target: 'payload', expr: { op: 'field', name: 'payload' } }, { target: 'updated_at', expr: { op: 'field', name: 'updated_at' } }
        ],
        mappingRevision: 1,
        writeStrategy: { mode: 'insert', batchSize, bulk: false },
        verification: { checks: ['row_accounting', 'ledger_complete', 'content_exact'] },
        risk: { level: 'medium', approvals: ['target_write'] },
        capabilityAssumptions: { source: { snapshotBinding: true }, target: { transactions: true, atomicBatchLedger: true, reconcileAfterCrash: true, fencing: true, readAfterWriteVerification: true, repairExecution: true } }
      }
    };
    const plan = await service.plan(request);
    const approval = await service.approve(request, { expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce: `repair-${runId}` });

    // Concurrent tamper (same pattern as postgres-repair-conformance): corrupt
    // rows while the run is in flight so verification observes a DIFF.
    // The tamper fires when the target first holds rows — strictly before the
    // verification phase reads them — coordinated by polling, not sleep.
    const corruptCount = Math.max(1, Math.floor(rowCount * 0.001));
    const tamperIds = Array.from({ length: corruptCount }, (_, i) => (i + 1) * 10);
    const tamperClient = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await tamperClient.connect();
    let tampered = false;
    const tamperDone = (async () => {
      for (;;) {
        const cnt = await tamperClient.query(`SELECT count(*)::int as c FROM public."${table}"`);
        if (cnt.rows[0].c >= Math.min(rowCount, tamperIds[tamperIds.length - 1])) break;
        await new Promise(r => setTimeout(r, 5));
      }
      for (let i = 0; i < tamperIds.length; i++) {
        await tamperClient.query(`UPDATE public."${table}" SET payload = 'corrupted-${i + 1}' WHERE id = $1`, [tamperIds[i]]);
      }
      tampered = true;
      evidenceWriter.appendRaw({ scenario, event: 'corruption_injected', corruptCount });
    })();

    let runError = null;
    try {
      await service.run(request, { approval });
    } catch (e) {
      runError = e;
    }
    await tamperDone;
    await tamperClient.end();
    if (!tampered) throw new Error('tamper never landed; cannot produce repair evidence');
    if (!runError || runError.code !== 'VERIFICATION_FAILED') {
      throw new Error(`expected VERIFICATION_FAILED after concurrent tamper, got ${runError ? `${runError.code}: ${runError.message}` : 'COMPLETE (tamper missed the verification window)'}`);
    }
    evidenceWriter.appendRaw({ scenario, event: 'verification_failed_as_expected', diffCounts: runError.details?.diffCounts });

    const batches = service.repairEvidence(request.migrationId);
    if (batches.length === 0) throw new Error('No repair evidence generated');

    const repairPlanIds = batches.map(b => b.repair.repairPlanId);
    const repairApproval = await service.approveRepair(request, { repairPlanIds, expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce: `repair-approve-${runId}` });

    const repairStart = process.hrtime.bigint();
    const repairResult = await service.runRepair(request, { repairApproval });
    const repairMs = Number(process.hrtime.bigint() - repairStart) / 1e6;

    // Verify repair succeeded
    client = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
    await client.connect();
    const cnt = await client.query(`SELECT count(*)::int as c FROM public."${table}" WHERE payload LIKE 'corrupted-%'`);
    await client.end(); client = null;
    if (cnt.rows[0].c !== 0) throw new Error(`Repair did not fix all corrupted rows, remaining ${cnt.rows[0].c}`);

    const metrics = {
      scenario,
      rowCount,
      corruptCount,
      repairOps: repairResult.repair.opCounts,
      durationMs: repairMs,
      rowsPerSec: rowsPerSecond(corruptCount, repairMs),
      mibPerSec: mibPerSecond(corruptCount * payloadBytes, repairMs),
      verification: 'VERIFIED'
    };
    evidenceWriter.appendRaw({ scenario, event: 'repair_completed', ...metrics });
    return { metrics, failures: [] };
  } finally {
    try { if (client) await client.end(); } catch {}
    try { if (service) service.close(); } catch {}
    try { await rm(sourceRoot, { recursive: true, force: true }); } catch {}
    try { await rm(targetRoot, { recursive: true, force: true }); } catch {}
    try { await rm(snapshotDir, { recursive: true, force: true }); } catch {}
    try {
      const c = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, ssl: false });
      await c.connect(); await c.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`); await c.end();
    } catch {}
  }
}








