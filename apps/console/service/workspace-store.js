// Local Console metadata store. This database is deliberately separate from the
// engine's durable run state: it holds workspace/draft/recipe/preference records
// and a *cache* of migration status. The engine state database remains the only
// authority for migration outcomes.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { consoleFail } from './errors.js';

const SCHEMA_VERSION = 1;

function nowIso(now) {
  return new Date(now()).toISOString();
}

export class WorkspaceStore {
  constructor({ path, now = () => Date.now() } = {}) {
    if (typeof path !== 'string' || !path) consoleFail('CONSOLE_INTERNAL_ERROR', 'Metadata store path is required');
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

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version === SCHEMA_VERSION) return;
    if (version > SCHEMA_VERSION) {
      consoleFail('CONSOLE_INTERNAL_ERROR', 'Console metadata was written by a newer application version');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        directory TEXT NOT NULL,
        retention_days INTEGER,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS drafts (
        draft_id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS recipes (
        recipe_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        version INTEGER NOT NULL,
        schema_signature TEXT NOT NULL,
        target_schema_json TEXT NOT NULL,
        mapping_json TEXT NOT NULL,
        operator_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS activity (
        activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        category TEXT NOT NULL,
        actor TEXT,
        correlation_id TEXT,
        workspace_id TEXT,
        migration_id TEXT,
        code TEXT,
        detail_json TEXT NOT NULL,
        severity TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
      CREATE INDEX IF NOT EXISTS activity_migration ON activity(migration_id, at DESC);
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
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  #prepare() {
    this.q = {
      insertWorkspace: this.db.prepare('INSERT INTO workspaces (workspace_id, name, description, directory, retention_days, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'),
      getWorkspace: this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?'),
      updateWorkspace: this.db.prepare('UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description), retention_days = COALESCE(?, retention_days), archived_at = ?, updated_at = ? WHERE workspace_id = ?'),
      listWorkspaces: this.db.prepare('SELECT * FROM workspaces ORDER BY archived_at IS NOT NULL, lower(name)'),
      insertDraft: this.db.prepare('INSERT INTO drafts (draft_id, workspace_id, name, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      updateDraft: this.db.prepare('UPDATE drafts SET name = ?, state_json = ?, updated_at = ? WHERE draft_id = ?'),
      getDraft: this.db.prepare('SELECT * FROM drafts WHERE draft_id = ?'),
      listDrafts: this.db.prepare('SELECT draft_id, workspace_id, name, created_at, updated_at FROM drafts WHERE (? IS NULL OR workspace_id = ?) ORDER BY updated_at DESC'),
      deleteDraft: this.db.prepare('DELETE FROM drafts WHERE draft_id = ?'),
      insertRecipe: this.db.prepare('INSERT INTO recipes (recipe_id, name, description, version, schema_signature, target_schema_json, mapping_json, operator_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      updateRecipe: this.db.prepare('UPDATE recipes SET name = ?, description = ?, version = ?, schema_signature = ?, target_schema_json = ?, mapping_json = ?, operator_version = ?, updated_at = ? WHERE recipe_id = ?'),
      getRecipe: this.db.prepare('SELECT * FROM recipes WHERE recipe_id = ?'),
      listRecipes: this.db.prepare('SELECT * FROM recipes ORDER BY lower(name)'),
      deleteRecipe: this.db.prepare('DELETE FROM recipes WHERE recipe_id = ?'),
      getSetting: this.db.prepare('SELECT value_json FROM settings WHERE key = ?'),
      setSetting: this.db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'),
      allSettings: this.db.prepare('SELECT key, value_json FROM settings'),
      insertActivity: this.db.prepare('INSERT INTO activity (at, category, actor, correlation_id, workspace_id, migration_id, code, detail_json, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      listActivity: this.db.prepare('SELECT * FROM activity WHERE (? IS NULL OR category = ?) AND (? IS NULL OR migration_id = ?) ORDER BY activity_id DESC LIMIT ? OFFSET ?'),
      insertMigration: this.db.prepare(`INSERT INTO migration_index
        (migration_id, workspace_id, name, source_path, source_root, target_path, target_root, table_name, migration_dir,
         plan_input_json, target_schema_json, mapping_json, mapping_revision, plan_revision, plan_json, dry_run_json,
         approval_json, last_status, last_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`),
      getMigration: this.db.prepare('SELECT * FROM migration_index WHERE migration_id = ?'),
      updateMigrationStatus: this.db.prepare('UPDATE migration_index SET last_status = ?, last_state = ?, updated_at = ? WHERE migration_id = ?'),
      updateMigrationPlan: this.db.prepare('UPDATE migration_index SET plan_json = COALESCE(?, plan_json), dry_run_json = COALESCE(?, dry_run_json), approval_json = COALESCE(?, approval_json), updated_at = ? WHERE migration_id = ?'),
      updateMigrationDesign: this.db.prepare('UPDATE migration_index SET plan_input_json = ?, target_schema_json = ?, mapping_json = ?, mapping_revision = ?, plan_revision = ?, updated_at = ? WHERE migration_id = ?'),
      listMigrations: this.db.prepare(`SELECT migration_id, workspace_id, name, target_path, table_name, last_status, last_state, created_at, updated_at
        FROM migration_index
        WHERE (? IS NULL OR workspace_id = ?)
          AND (? IS NULL OR last_status = ?)
          AND (? IS NULL OR name LIKE ? OR migration_id LIKE ?)
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at <= ?)
        ORDER BY created_at DESC, migration_id DESC
        LIMIT ? OFFSET ?`),
      countMigrations: this.db.prepare(`SELECT COUNT(*) AS total FROM migration_index
        WHERE (? IS NULL OR workspace_id = ?)
          AND (? IS NULL OR last_status = ?)
          AND (? IS NULL OR name LIKE ? OR migration_id LIKE ?)
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at <= ?)`),
      countByStatus: this.db.prepare('SELECT last_status AS status, COUNT(*) AS total FROM migration_index WHERE workspace_id = ? GROUP BY last_status')
    };
  }

  #assertOpen() {
    if (this.closed) consoleFail('CONSOLE_INTERNAL_ERROR', 'Metadata store is closed');
  }

  createWorkspace({ name, description = null, directory }) {
    this.#assertOpen();
    if (typeof name !== 'string' || !name.trim()) consoleFail('WORKSPACE_NAME_REQUIRED', 'A workspace name is required');
    const workspaceId = `ws_${randomUUID()}`;
    const at = nowIso(this.now);
    this.q.insertWorkspace.run(workspaceId, name.trim(), description, resolve(directory), null, at, at);
    return this.getWorkspace(workspaceId);
  }

  getWorkspace(workspaceId) {
    this.#assertOpen();
    const row = this.q.getWorkspace.get(workspaceId);
    if (!row) consoleFail('WORKSPACE_NOT_FOUND', 'Workspace does not exist', { workspaceId });
    return mapWorkspace(row);
  }

  listWorkspaces({ query = null, includeArchived = false } = {}) {
    this.#assertOpen();
    const rows = this.q.listWorkspaces.all().map(mapWorkspace);
    const needle = query ? query.trim().toLowerCase() : null;
    return rows
      .filter(row => includeArchived || row.archivedAt === null)
      .filter(row => !needle || row.name.toLowerCase().includes(needle) || row.description?.toLowerCase().includes(needle));
  }

  updateWorkspace({ workspaceId, name = null, description = null, retentionDays = null, archivedAt = undefined }) {
    this.#assertOpen();
    const current = this.getWorkspace(workspaceId);
    if (name !== null && !String(name).trim()) consoleFail('WORKSPACE_NAME_REQUIRED', 'A workspace name is required');
    if (current.archivedAt !== null && name !== null) consoleFail('WORKSPACE_ARCHIVED', 'Restore the workspace before renaming it');
    this.q.updateWorkspace.run(
      name === null ? null : String(name).trim(),
      description,
      retentionDays,
      archivedAt === undefined ? current.archivedAt : archivedAt,
      nowIso(this.now),
      workspaceId
    );
    return this.getWorkspace(workspaceId);
  }

  setWorkspaceArchived(workspaceId, archived) {
    const current = this.getWorkspace(workspaceId);
    return this.updateWorkspace({
      workspaceId,
      archivedAt: archived ? (current.archivedAt ?? nowIso(this.now)) : null
    });
  }

  saveDraft({ draftId = null, workspaceId, name, state }) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    const at = nowIso(this.now);
    const serialized = JSON.stringify(state ?? {});
    if (!draftId) {
      const created = `draft_${randomUUID()}`;
      this.q.insertDraft.run(created, workspaceId, name, serialized, at, at);
      return this.getDraft(created);
    }
    const existing = this.q.getDraft.get(draftId);
    if (!existing) consoleFail('MIGRATION_NOT_FOUND', 'Draft does not exist', { draftId });
    this.q.updateDraft.run(name, serialized, at, draftId);
    return this.getDraft(draftId);
  }

  getDraft(draftId) {
    this.#assertOpen();
    const row = this.q.getDraft.get(draftId);
    if (!row) consoleFail('MIGRATION_NOT_FOUND', 'Draft does not exist', { draftId });
    return {
      draftId: row.draft_id,
      workspaceId: row.workspace_id,
      name: row.name,
      state: JSON.parse(row.state_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listDrafts({ workspaceId = null } = {}) {
    this.#assertOpen();
    return this.q.listDrafts.all(workspaceId, workspaceId).map(row => ({
      draftId: row.draft_id,
      workspaceId: row.workspace_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  deleteDraft(draftId) {
    this.#assertOpen();
    this.q.deleteDraft.run(draftId);
    return { deleted: true };
  }

  saveRecipe({ recipeId = null, name, description = null, schemaSignature, targetSchema, mapping, operatorVersion }) {
    this.#assertOpen();
    const at = nowIso(this.now);
    const targetSchemaJson = JSON.stringify(targetSchema);
    const mappingJson = JSON.stringify(mapping);
    if (!recipeId) {
      const created = `rec_${randomUUID()}`;
      this.q.insertRecipe.run(created, name, description, 1, schemaSignature, targetSchemaJson, mappingJson, operatorVersion, at, at);
      return this.getRecipe(created);
    }
    const existing = this.q.getRecipe.get(recipeId);
    if (!existing) consoleFail('RECIPE_INCOMPATIBLE', 'Recipe does not exist', { recipeId });
    const version = existing.schema_signature === schemaSignature && existing.mapping_json === mappingJson
      ? existing.version
      : existing.version + 1;
    this.q.updateRecipe.run(name, description, version, schemaSignature, targetSchemaJson, mappingJson, operatorVersion, at, recipeId);
    return this.getRecipe(recipeId);
  }

  getRecipe(recipeId) {
    this.#assertOpen();
    const row = this.q.getRecipe.get(recipeId);
    if (!row) consoleFail('RECIPE_INCOMPATIBLE', 'Recipe does not exist', { recipeId });
    return mapRecipe(row);
  }

  listRecipes({ query = null } = {}) {
    this.#assertOpen();
    const needle = query ? query.trim().toLowerCase() : null;
    return this.q.listRecipes.all().map(mapRecipe)
      .filter(row => !needle || row.name.toLowerCase().includes(needle));
  }

  deleteRecipe(recipeId) {
    this.#assertOpen();
    this.q.deleteRecipe.run(recipeId);
    return { deleted: true };
  }

  getSetting(key, fallback = null) {
    this.#assertOpen();
    const row = this.q.getSetting.get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  }

  setSetting(key, value) {
    this.#assertOpen();
    this.q.setSetting.run(key, JSON.stringify(value ?? null), nowIso(this.now));
    return value;
  }

  allSettings() {
    this.#assertOpen();
    const out = {};
    for (const row of this.q.allSettings.all()) out[row.key] = JSON.parse(row.value_json);
    return out;
  }

  recordActivity({ category, actor = null, correlationId = null, workspaceId = null, migrationId = null, code = null, detail = {}, severity = 'info' }) {
    this.#assertOpen();
    this.q.insertActivity.run(
      nowIso(this.now), category, actor, correlationId, workspaceId, migrationId, code,
      JSON.stringify(detail ?? {}), severity
    );
  }

  listActivity({ category = null, migrationId = null, limit = 100, offset = 0 } = {}) {
    this.#assertOpen();
    return this.q.listActivity.all(category, category, migrationId, migrationId, Math.min(limit, 500), offset).map(row => ({
      id: row.activity_id,
      at: row.at,
      category: row.category,
      actor: row.actor,
      correlationId: row.correlation_id,
      workspaceId: row.workspace_id,
      migrationId: row.migration_id,
      code: row.code,
      detail: JSON.parse(row.detail_json),
      severity: row.severity
    }));
  }

  createMigrationRecord(record) {
    this.#assertOpen();
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
    if (!row) consoleFail('MIGRATION_NOT_FOUND', 'Migration does not exist in this workspace', { migrationId });
    return mapMigration(row);
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

  updateMigrationDesign(migrationId, { planInput, targetSchema, mapping, mappingRevision, planRevision }) {
    this.#assertOpen();
    this.q.updateMigrationDesign.run(
      JSON.stringify(planInput), JSON.stringify(targetSchema), JSON.stringify(mapping),
      mappingRevision, planRevision, nowIso(this.now), migrationId
    );
  }

  listMigrations({ workspaceId = null, status = null, query = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
    this.#assertOpen();
    const like = query ? `%${query.trim()}%` : null;
    const args = [workspaceId, workspaceId, status, status, like, like, like, from, from, to, to];
    const rows = this.q.listMigrations.all(...args, Math.min(limit, 100), offset);
    const total = this.q.countMigrations.get(...args).total;
    return {
      total,
      items: rows.map(row => ({
        migrationId: row.migration_id,
        workspaceId: row.workspace_id,
        name: row.name,
        targetPath: row.target_path,
        table: row.table_name,
        status: row.last_status,
        state: row.last_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  }

  countByStatus(workspaceId) {
    this.#assertOpen();
    const out = {};
    for (const row of this.q.countByStatus.all(workspaceId)) {
      out[row.status ?? 'DRAFT'] = row.total;
    }
    return out;
  }

  workspaceImpact(workspaceId) {
    this.#assertOpen();
    this.getWorkspace(workspaceId);
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM migration_index WHERE workspace_id = ?').get(workspaceId);
    const active = this.db.prepare("SELECT COUNT(*) AS total FROM migration_index WHERE workspace_id = ? AND last_status IN ('RUNNING','QUEUED')").get(workspaceId);
    return {
      migrationCount: row.total,
      activeMigrationCount: active.total,
      databaseFilesDeleted: 0,
      note: 'Deleting a workspace removes Console metadata only. Customer CSV files and SQLite databases are never deleted.'
    };
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

function mapWorkspace(row) {
  return {
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    directory: row.directory,
    retentionDays: row.retention_days,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRecipe(row) {
  return {
    recipeId: row.recipe_id,
    name: row.name,
    description: row.description,
    version: row.version,
    schemaSignature: row.schema_signature,
    targetSchema: JSON.parse(row.target_schema_json),
    mapping: JSON.parse(row.mapping_json),
    operatorVersion: row.operator_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMigration(row) {
  return {
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
  };
}
