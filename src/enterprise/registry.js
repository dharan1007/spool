// Durable enterprise registry for SPOOL API v2.
//
// This store carries the multi-tenant model: organizations, workspaces,
// memberships (principal -> role per workspace), issued API keys and the
// per-workspace migration index plus audit activity. Migration OUTCOMES remain
// owned by the engine's own durable state; this registry never becomes a
// second authority for engine truth. It only tracks which principals may act
// on which workspaces and which migrations live where.
import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';

const SCHEMA_VERSION = 1;
const ROLES = new Set(['admin', 'operator', 'viewer']);

function nowIso(now) {
  return new Date(now()).toISOString();
}

export class EnterpriseRegistry {
  constructor({ path, now = () => Date.now() } = {}) {
    if (typeof path !== 'string' || !path) fail('ENTERPRISE_CONFIG_INVALID', 'Registry path is required');
    this.path = resolve(path);
    this.now = now;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.closed = false;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.#migrate();
    this.#prepare();
  }

  #assertOpen() {
    if (this.closed) fail('ENTERPRISE_INTERNAL_ERROR', 'Enterprise registry is closed');
  }

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version === SCHEMA_VERSION) return;
    if (version > SCHEMA_VERSION) fail('ENTERPRISE_INTERNAL_ERROR', 'Registry was written by a newer application version');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        organization_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workspaces_org ON workspaces(organization_id);
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, principal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memberships_principal ON memberships(principal_id);
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY NOT NULL,
        key_id TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS api_keys_principal ON api_keys(principal_id);
      CREATE TABLE IF NOT EXISTS migration_index (
        migration_id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_root TEXT NOT NULL,
        target_path TEXT NOT NULL,
        target_root TEXT NOT NULL,
        table_name TEXT NOT NULL,
        migration_dir TEXT NOT NULL,
        plan_input_json TEXT NOT NULL,
        target_schema_json TEXT NOT NULL,
        mapping_json TEXT NOT NULL,
        mapping_revision INTEGER NOT NULL,
        plan_revision INTEGER NOT NULL,
        plan_json TEXT,
        dry_run_json TEXT,
        approval_json TEXT,
        last_status TEXT,
        last_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS migration_index_workspace ON migration_index(workspace_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS activity (
        activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        category TEXT NOT NULL,
        actor TEXT,
        workspace_id TEXT,
        migration_id TEXT,
        code TEXT,
        detail_json TEXT NOT NULL,
        severity TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id, activity_id DESC);
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  #prepare() {
    this.q = {
      insertOrganization: this.db.prepare('INSERT INTO organizations (organization_id, name, created_at) VALUES (?, ?, ?)'),
      getOrganization: this.db.prepare('SELECT * FROM organizations WHERE organization_id = ?'),
      insertWorkspace: this.db.prepare('INSERT INTO workspaces (workspace_id, organization_id, name, directory, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'),
      getWorkspace: this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?'),
      listMemberWorkspaces: this.db.prepare(`SELECT w.* FROM workspaces w
        JOIN memberships m ON m.workspace_id = w.workspace_id
        WHERE m.principal_id = ? AND w.archived_at IS NULL
        ORDER BY lower(w.name)`),
      insertMembership: this.db.prepare('INSERT INTO memberships (workspace_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)'),
      getMembership: this.db.prepare('SELECT * FROM memberships WHERE workspace_id = ? AND principal_id = ?'),
      listMemberships: this.db.prepare('SELECT * FROM memberships WHERE workspace_id = ? ORDER BY principal_id'),
      deleteMembership: this.db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND principal_id = ?'),
      updateMembership: this.db.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND principal_id = ?'),
      insertApiKey: this.db.prepare('INSERT INTO api_keys (key_hash, key_id, principal_id, workspace_id, role, issued_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'),
      getApiKeyByHash: this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
      revokeApiKey: this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL'),
      insertMigration: this.db.prepare(`INSERT INTO migration_index
        (migration_id, workspace_id, name, source_path, source_root, target_path, target_root, table_name, migration_dir,
         plan_input_json, target_schema_json, mapping_json, mapping_revision, plan_revision, plan_json, dry_run_json,
         approval_json, last_status, last_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`),
      getMigration: this.db.prepare('SELECT * FROM migration_index WHERE migration_id = ?'),
      updateMigrationStatus: this.db.prepare('UPDATE migration_index SET last_status = ?, last_state = ?, updated_at = ? WHERE migration_id = ?'),
      updateMigrationPlan: this.db.prepare('UPDATE migration_index SET plan_json = COALESCE(?, plan_json), dry_run_json = COALESCE(?, dry_run_json), approval_json = COALESCE(?, approval_json), updated_at = ? WHERE migration_id = ?'),
      listMigrations: null, // statements for listMigrations are built per call (IN-list arity varies)
      insertActivity: this.db.prepare('INSERT INTO activity (at, category, actor, workspace_id, migration_id, code, detail_json, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      listActivity: this.db.prepare('SELECT * FROM activity WHERE (? IS NULL OR workspace_id = ?) ORDER BY activity_id DESC LIMIT ? OFFSET ?')
    };
  }

  // ---------- organizations & workspaces ----------

  createOrganization(name) {
    this.#assertOpen();
    if (typeof name !== 'string' || !name.trim()) fail('ENTERPRISE_CONFIG_INVALID', 'An organization name is required');
    const organizationId = `org_${randomUUID()}`;
    this.q.insertOrganization.run(organizationId, name.trim(), nowIso(this.now));
    const row = this.q.getOrganization.get(organizationId);
    return Object.freeze({ organizationId: row.organization_id, name: row.name, createdAt: row.created_at });
  }

  getOrganization(organizationId) {
    this.#assertOpen();
    const row = this.q.getOrganization.get(organizationId);
    if (!row) fail('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
    return Object.freeze({ organizationId: row.organization_id, name: row.name, createdAt: row.created_at });
  }

  createWorkspace({ organizationId, name, directory }) {
    this.#assertOpen();
    this.getOrganization(organizationId);
    if (typeof name !== 'string' || !name.trim()) fail('WORKSPACE_NAME_REQUIRED', 'A workspace name is required');
    if (typeof directory !== 'string' || !directory) fail('WORKSPACE_DIRECTORY_REQUIRED', 'A workspace directory is required');
    let absolute;
    try {
      absolute = resolve(directory);
      if (!statSync(absolute).isDirectory()) throw new Error('not a directory');
    } catch {
      fail('WORKSPACE_ROOT_UNAVAILABLE', 'Workspace directory must be an existing directory');
    }
    const workspaceId = `ws_${randomUUID()}`;
    const at = nowIso(this.now);
    this.q.insertWorkspace.run(workspaceId, organizationId, name.trim(), absolute, at, at);
    return this.getWorkspace(workspaceId);
  }

  getWorkspace(workspaceId) {
    this.#assertOpen();
    const row = this.q.getWorkspace.get(workspaceId);
    if (!row) fail('WORKSPACE_NOT_FOUND', 'Workspace does not exist');
    return Object.freeze({
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      name: row.name,
      directory: row.directory,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  listWorkspacesForPrincipal(principalId) {
    this.#assertOpen();
    if (typeof principalId !== 'string' || !principalId) fail('WORKSPACE_NOT_FOUND', 'Principal is required');
    return this.q.listMemberWorkspaces.all(principalId).map(row => Object.freeze({
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      name: row.name,
      directory: row.directory,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  // ---------- memberships ----------

  addMembership({ workspaceId, principalId, role }) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    if (typeof principalId !== 'string' || !principalId.trim()) fail('ENTERPRISE_CONFIG_INVALID', 'A principal id is required');
    if (!ROLES.has(role)) fail('ENTERPRISE_CONFIG_INVALID', `Role must be one of ${[...ROLES].join(', ')}`);
    const at = nowIso(this.now);
    try {
      this.q.insertMembership.run(workspaceId, principalId.trim(), role, at);
    } catch {
      fail('MEMBERSHIP_EXISTS', 'Principal already has a membership on this workspace');
    }
    return Object.freeze({ workspaceId, principalId: principalId.trim(), role });
  }

  membership(workspaceId, principalId) {
    this.#assertOpen();
    const row = this.q.getMembership.get(workspaceId, principalId);
    if (!row) return null;
    return Object.freeze({ workspaceId: row.workspace_id, principalId: row.principal_id, role: row.role });
  }

  listMemberships(workspaceId) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    const rows = this.q.listMemberships.all(workspaceId);
    return rows.map(r => Object.freeze({
      workspaceId: r.workspace_id,
      principalId: r.principal_id,
      role: r.role,
      createdAt: r.created_at
    }));
  }

  removeMembership(workspaceId, principalId) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    const res = this.q.deleteMembership.run(workspaceId, principalId);
    if (res.changes === 0) fail('NOT_FOUND', 'Membership not found');
    this.recordActivity({
      category: 'workspace',
      actor: 'spool:root',
      workspaceId,
      code: 'MEMBERSHIP_REMOVED',
      detail: { principalId },
      severity: 'info'
    });
    return Object.freeze({ workspaceId, principalId, removed: true });
  }

  updateMembershipRole(workspaceId, principalId, role) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    if (!ROLES.has(role)) fail('ENTERPRISE_CONFIG_INVALID', `Role must be one of ${[...ROLES].join(', ')}`);
    const res = this.q.updateMembership.run(role, workspaceId, principalId);
    if (res.changes === 0) fail('NOT_FOUND', 'Membership not found');
    this.recordActivity({
      category: 'workspace',
      actor: 'spool:root',
      workspaceId,
      code: 'MEMBERSHIP_ROLE_UPDATED',
      detail: { principalId, role },
      severity: 'info'
    });
    return Object.freeze({ workspaceId, principalId, role });
  }

  // ---------- api keys ----------

  issueApiKey({ workspaceId, principalId, role, hash }) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    if (typeof principalId !== 'string' || !principalId.trim()) fail('ENTERPRISE_CONFIG_INVALID', 'A principal id is required');
    if (!ROLES.has(role)) fail('ENTERPRISE_CONFIG_INVALID', `Role must be one of ${[...ROLES].join(', ')}`);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('ENTERPRISE_CONFIG_INVALID', 'A sha256 key hash is required');
    const keyId = `key_${randomUUID()}`;
    const actor = principalId.trim();
    // Workspace-pinned key issuance provisions the principal's membership in
    // the same transaction scope: membership is the single authorization
    // authority, and an issued key without it could never act legitimately.
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO memberships (workspace_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(workspaceId, actor, role, nowIso(this.now));
      this.q.insertApiKey.run(hash, keyId, actor, workspaceId, role, nowIso(this.now));
      this.q.insertActivity.run(
        nowIso(this.now), 'api-key', 'spool:root', workspaceId, null,
        'API_KEY_ISSUED', JSON.stringify({ keyId, principalId: actor, role }), 'info'
      );
    })();
    return Object.freeze({ keyId, workspaceId, principalId: actor, role });
  }

  // Returns the api-key principal descriptor or null when unknown/revoked.
  resolveApiKeyHash(hash) {
    this.#assertOpen();
    const row = this.q.getApiKeyByHash.get(hash);
    if (!row || row.revoked_at) return null;
    return Object.freeze({ keyId: row.key_id, principalId: row.principal_id, workspaceId: row.workspace_id, role: row.role });
  }

  revokeApiKey(keyId) {
    this.#assertOpen();
    const result = this.q.revokeApiKey.run(nowIso(this.now), keyId);
    if (result.changes === 0) fail('API_KEY_NOT_FOUND', 'API key does not exist or is already revoked');
    this.q.insertActivity.run(
      nowIso(this.now), 'api-key', 'spool:root', null, null,
      'API_KEY_REVOKED', JSON.stringify({ keyId }), 'info'
    );
    return Object.freeze({ keyId, revoked: true });
  }

  // ---------- migration index ----------

  createMigrationRecord(record) {
    this.#assertOpen();
    this.getWorkspace(record.workspaceId);
    const at = nowIso(this.now);
    this.q.insertMigration.run(
      record.migrationId, record.workspaceId, record.name, record.sourcePath, record.sourceRoot,
      record.targetPath, record.targetRoot, record.tableName, record.migrationDir,
      JSON.stringify(record.planInput), JSON.stringify(record.targetSchema), JSON.stringify(record.mapping),
      record.mappingRevision, record.planRevision, at, at
    );
    return this.getMigrationRecord(record.migrationId);
  }

  getMigrationRecord(migrationId) {
    this.#assertOpen();
    const row = this.q.getMigration.get(migrationId);
    if (!row) return null;
    return Object.freeze({
      migrationId: row.migration_id,
      workspaceId: row.workspace_id,
      name: row.name,
      sourcePath: row.source_path,
      sourceRoot: row.source_root,
      targetPath: row.target_path,
      targetRoot: row.target_root,
      table: row.table_name,
      migrationDir: row.migration_dir,
      planInput: JSON.parse(row.plan_input_json),
      targetSchema: JSON.parse(row.target_schema_json),
      mapping: JSON.parse(row.mapping_json),
      mappingRevision: row.mapping_revision,
      planRevision: row.plan_revision,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      dryRun: row.dry_run_json ? JSON.parse(row.dry_run_json) : null,
      approval: row.approval_json ? JSON.parse(row.approval_json) : null,
      lastStatus: row.last_status,
      lastState: row.last_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  updateMigrationStatus(migrationId, { status, state }) {
    this.#assertOpen();
    this.q.updateMigrationStatus.run(status ?? null, state ?? null, nowIso(this.now), migrationId);
  }

  updateMigrationPlan(migrationId, { plan = null, dryRun = null, approval = null }) {
    this.#assertOpen();
    this.q.updateMigrationPlan.run(
      plan === null ? null : JSON.stringify(plan),
      dryRun === null ? null : JSON.stringify(dryRun),
      approval === null ? null : JSON.stringify(approval),
      nowIso(this.now),
      migrationId
    );
  }

  listMigrations({ workspaceIds = null, limit = 50, offset = 0 } = {}) {
    this.#assertOpen();
    const safeLimit = Math.min(limit, 100);
    const safeOffset = Math.max(offset, 0);
    if (workspaceIds === null) {
      const rows = this.db.prepare(`SELECT migration_id, workspace_id, name, target_path, table_name, last_status, last_state, created_at, updated_at
        FROM migration_index ORDER BY created_at DESC, migration_id DESC LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
      return this.#mapMigrationList(rows, rows.length);
    }
    const ids = [...new Set(workspaceIds.filter(value => typeof value === 'string' && value))];
    if (ids.length === 0) return { total: 0, items: [] };
    const statement = this.db.prepare(`SELECT migration_id, workspace_id, name, target_path, table_name, last_status, last_state, created_at, updated_at
      FROM migration_index WHERE workspace_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY created_at DESC, migration_id DESC LIMIT ? OFFSET ?`);
    const rows = statement.all(...ids, safeLimit, safeOffset);
    return this.#mapMigrationList(rows, rows.length);
  }

  #mapMigrationList(rows, total) {
    return {
      total,
      items: rows.map(row => ({
        migrationId: row.migration_id,
        workspaceId: row.workspace_id,
        name: row.name,
        table: row.table_name,
        status: row.last_status,
        state: row.last_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  }

  // ---------- activity ----------

  recordActivity({ category, actor = null, workspaceId = null, migrationId = null, code = null, detail = {}, severity = 'info' }) {
    this.#assertOpen();
    this.q.insertActivity.run(
      nowIso(this.now), category, actor, workspaceId, migrationId, code,
      JSON.stringify(detail ?? {}), severity
    );
  }

  listActivity({ workspaceIds = null, limit = 100, offset = 0 } = {}) {
    this.#assertOpen();
    const first = workspaceIds === null ? null : workspaceIds[0];
    return this.q.listActivity.all(first, first, Math.min(limit, 500), Math.max(offset, 0)).map(row => ({
      id: row.activity_id,
      at: row.at,
      category: row.category,
      actor: row.actor,
      workspaceId: row.workspace_id,
      migrationId: row.migration_id,
      code: row.code,
      detail: JSON.parse(row.detail_json),
      severity: row.severity
    }));
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
