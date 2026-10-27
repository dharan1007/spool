#!/usr/bin/env node
// Backup/restore drill for the SPOOL enterprise state.
//
// Exercises the real artefacts: an enterprise registry with a workspace,
// membership, issued API key, migration record and activity journal, plus a WAL
// target database with committed rows. Both are backed up through SQLite's
// online backup API while writers are open, restored into a fresh root, and
// compared row-for-row. Prints retained evidence; it never touches live data and
// never claims off-host durability.
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

import { EnterpriseRegistry } from '../src/enterprise/registry.js';
import { backupDatabase, verifyRestore } from '../src/platform/sqlite-backup.js';

const checks = [];
function check(value, message) {
  if (!value) throw new Error(message);
  checks.push(message);
}

const root = await mkdtemp(join(tmpdir(), 'spool-backup-drill-'));
const open = { registry: null, restored: null, target: null };
try {
  check(!resolve(root).startsWith(resolve('.') + sep), 'drill root must be outside the repository');
  const live = join(root, 'live');
  const restoredRoot = join(root, 'restored');
  await mkdir(live, { recursive: true });
  await mkdir(restoredRoot, { recursive: true });
  await mkdir(join(live, 'workspace'), { recursive: true });

  // Real enterprise state, including a WAL writer that stays open.
  const registryPath = join(live, 'registry.db');
  const registry = new EnterpriseRegistry({ path: registryPath });
  open.registry = registry;
  const organization = registry.createOrganization('Drill Org');
  const workspace = registry.createWorkspace({ organizationId: organization.organizationId, name: 'Drill Workspace', directory: join(live, 'workspace') });
  registry.addMembership({ workspaceId: workspace.workspaceId, principalId: 'operator:drill', role: 'operator' });
  const keyHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const issued = registry.issueApiKey({ workspaceId: workspace.workspaceId, principalId: 'operator:drill', role: 'operator', hash: keyHash });
  registry.createMigrationRecord({
    migrationId: 'mig_drill_0001', workspaceId: workspace.workspaceId, name: 'drill',
    sourcePath: join(live, 'source.csv'), sourceRoot: live, targetPath: join(live, 'target.db'), targetRoot: live,
    tableName: 'rows', migrationDir: join(live, 'migrations', 'mig_drill_0001'),
    planInput: { planRevision: 1 }, targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }], mappingRevision: 1, planRevision: 1
  });
  registry.updateMigrationStatus('mig_drill_0001', { status: 'COMPLETE', state: 'COMPLETE' });
  for (let index = 0; index < 25; index += 1) {
    registry.recordActivity({ category: 'drill', actor: 'operator:drill', workspaceId: workspace.workspaceId, code: 'DRILL_STEP', detail: { index } });
  }

  const targetPath = join(live, 'target.db');
  const target = new Database(targetPath);
  open.target = target;
  target.pragma('journal_mode = WAL');
  target.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
  const insert = target.prepare('INSERT INTO rows (id, name) VALUES (?, ?)');
  for (let id = 1; id <= 500; id += 1) insert.run(id, `row-${id}`);

  // Back up while both writers are open (registry WAL and target WAL).
  const registryBackup = await backupDatabase({ source: registryPath, destination: join(restoredRoot, 'registry.db') });
  const targetBackup = await backupDatabase({ source: targetPath, destination: join(restoredRoot, 'target.db') });
  check(registryBackup.integrity === 'ok' && targetBackup.integrity === 'ok', 'online backups pass SQLite integrity_check');
  check(registryBackup.rows > 0 && targetBackup.rows === 500, 'online backups captured committed rows');

  // Restoring means opening the copies with the real application code.
  const restored = new EnterpriseRegistry({ path: join(restoredRoot, 'registry.db') });
  open.restored = restored;
  const restoredWorkspace = restored.getWorkspace(workspace.workspaceId);
  check(restoredWorkspace.name === 'Drill Workspace', 'restored registry resolves the workspace');
  check(restored.membership(workspace.workspaceId, 'operator:drill')?.role === 'operator', 'restored membership keeps its role');
  check(restored.resolveApiKeyHash(keyHash)?.keyId === issued.keyId, 'restored registry still resolves the issued API key');
  const restoredMigration = restored.getMigrationRecord('mig_drill_0001');
  check(restoredMigration?.lastStatus === 'COMPLETE', 'restored migration record keeps its terminal status');
  const liveActivity = registry.listActivity({ workspaceIds: [workspace.workspaceId], limit: 100 });
  check(restored.listActivity({ workspaceIds: [workspace.workspaceId], limit: 100 }).length === liveActivity.length && liveActivity.length >= 25,
    'restored activity journal keeps every entry');

  const restoredTarget = new Database(join(restoredRoot, 'target.db'), { readonly: true });
  const restoredRows = restoredTarget.prepare('SELECT count(*) AS n FROM rows').get().n;
  const restoredSum = restoredTarget.prepare('SELECT sum(id) AS s FROM rows').get().s;
  restoredTarget.close();
  check(restoredRows === 500 && restoredSum === 125250, 'restored target has exactly the committed rows');

  const registryComparison = verifyRestore({ source: registryPath, restored: join(restoredRoot, 'registry.db') });
  const targetComparison = verifyRestore({ source: targetPath, restored: join(restoredRoot, 'target.db') });
  check(registryComparison.ok, 'registry restore matches the source schema and content digests: ' + registryComparison.problems.join(', '));
  check(targetComparison.ok, 'target restore matches the source schema and content digests: ' + targetComparison.problems.join(', '));

  // A torn or edited backup must be rejected, not reported as restorable.
  const tampered = join(restoredRoot, 'tampered.db');
  const tamperSource = new Database(targetPath, { readonly: true });
  await tamperSource.backup(tampered);
  tamperSource.close();
  const edit = new Database(tampered);
  edit.prepare('DELETE FROM rows WHERE id = 1').run();
  edit.close();
  check(!verifyRestore({ source: targetPath, restored: tampered }).ok, 'a backup missing a committed row is rejected');

  registry.close();
  restored.close();
  target.close();
  open.registry = open.restored = open.target = null;

  const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  process.stdout.write('SPOOL_EVIDENCE_JSON=' + JSON.stringify({
    surface: 'backup_restore_drill',
    status: 'PASS',
    release: packageVersion,
    drillRoot: root,
    checks,
    registry: { sourceBytes: registryBackup.bytes, rows: registryBackup.rows, schemaSha256: registryBackup.schemaSha256, journalMode: registryBackup.journalMode },
    target: { sourceBytes: targetBackup.bytes, rows: targetBackup.rows, journalMode: targetBackup.journalMode },
    notCovered: [
      'off-host or object-storage copies',
      'encryption at rest or in transit',
      'point-in-time recovery beyond the online backup snapshot',
      'restore into a different machine or cluster'
    ]
  }) + '\n');
} finally {
  // Close every handle before cleanup so a genuine failure is reported instead
  // of being replaced by a Windows EBUSY from an open database handle.
  for (const handle of [open.restored, open.registry, open.target]) {
    try { if (handle && !handle.closed) handle.close(); } catch {}
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
