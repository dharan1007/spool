import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { EnterpriseRegistry } from '../src/enterprise/registry.js';
import { backupDatabase, describeDatabase, verifyRestore } from '../src/platform/sqlite-backup.js';

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spool-backup-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

function seed(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
  const insert = db.prepare('INSERT INTO rows VALUES (?, ?)');
  for (let id = 1; id <= 50; id += 1) insert.run(id, `row-${id}`);
  return db;
}

test('online backup of an open WAL database restores identical schema and content', () => withRoot(async root => {
  const source = join(root, 'source.db');
  const writer = seed(source);
  // Backup while the writer is still open: a plain file copy could tear this.
  const backup = await backupDatabase({ source, destination: join(root, 'copy.db') });
  assert.equal(backup.integrity, 'ok');
  assert.equal(backup.rows, 50);
  assert.equal(backup.journalMode, 'wal');
  const comparison = verifyRestore({ source, restored: join(root, 'copy.db') });
  assert.equal(comparison.ok, true, comparison.problems.join(', '));
  assert.equal(comparison.restored.schemaSha256, comparison.source.schemaSha256);
  writer.close();
}));

test('registry backup restores workspaces, memberships, keys, migrations and activity', () => withRoot(async root => {
  await mkdir(join(root, 'workspace'), { recursive: true });
  const registry = new EnterpriseRegistry({ path: join(root, 'registry.db') });
  const organization = registry.createOrganization('Backup Org');
  const workspace = registry.createWorkspace({ organizationId: organization.organizationId, name: 'Backup Workspace', directory: join(root, 'workspace') });
  registry.addMembership({ workspaceId: workspace.workspaceId, principalId: 'operator:test', role: 'admin' });
  const hash = createHash('sha256').update(randomBytes(16)).digest('hex');
  const issued = registry.issueApiKey({ workspaceId: workspace.workspaceId, principalId: 'operator:test', role: 'admin', hash });
  registry.createMigrationRecord({
    migrationId: 'mig_backup_0001', workspaceId: workspace.workspaceId, name: 'backup',
    sourcePath: join(root, 'source.csv'), sourceRoot: root, targetPath: join(root, 'target.db'), targetRoot: root,
    tableName: 'rows', migrationDir: join(root, 'migrations', 'mig_backup_0001'),
    planInput: { planRevision: 1 }, targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }], mappingRevision: 1, planRevision: 1
  });
  registry.updateMigrationStatus('mig_backup_0001', { status: 'COMPLETE', state: 'COMPLETE' });
  const activity = registry.listActivity({ workspaceIds: [workspace.workspaceId], limit: 100 });
  const backup = await backupDatabase({ source: join(root, 'registry.db'), destination: join(root, 'registry-copy.db') });
  assert.ok(backup.rows > 0);

  const restored = new EnterpriseRegistry({ path: join(root, 'registry-copy.db') });
  try {
    assert.equal(restored.getWorkspace(workspace.workspaceId).name, 'Backup Workspace');
    assert.equal(restored.membership(workspace.workspaceId, 'operator:test').role, 'admin');
    assert.equal(restored.resolveApiKeyHash(hash).keyId, issued.keyId);
    assert.equal(restored.getMigrationRecord('mig_backup_0001').lastStatus, 'COMPLETE');
    assert.equal(restored.listActivity({ workspaceIds: [workspace.workspaceId], limit: 100 }).length, activity.length);
    assert.equal(verifyRestore({ source: join(root, 'registry.db'), restored: join(root, 'registry-copy.db') }).ok, true);
  } finally {
    restored.close();
    registry.close();
  }
}));

test('a backup missing a committed row is rejected with the differing table named', () => withRoot(async root => {
  const source = join(root, 'source.db');
  const writer = seed(source);
  const backupPath = join(root, 'copy.db');
  await backupDatabase({ source, destination: backupPath });
  writer.close();
  const edit = new Database(backupPath);
  edit.prepare('DELETE FROM rows WHERE id = 7').run();
  edit.close();
  const comparison = verifyRestore({ source, restored: backupPath });
  assert.equal(comparison.ok, false);
  assert.ok(comparison.problems.some(problem => problem.includes('rows')), comparison.problems.join(', '));
}));

test('an unreadable database fails closed instead of being treated as restorable', () => withRoot(async root => {
  const broken = join(root, 'broken.db');
  await writeFile(broken, randomBytes(4096));
  assert.throws(() => describeDatabase(broken), error => ['BACKUP_UNREADABLE', 'BACKUP_INTEGRITY_FAILED'].includes(error.code));
}));
