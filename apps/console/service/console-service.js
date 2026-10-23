import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { consoleFail } from "./errors.js";
import { createSourceDiscovery } from "./source-discovery.js";
import { createSqliteCatalog } from "./sqlite-catalog.js";
import { createRecipeService } from "./recipes.js";
import { buildPlanInput } from "./plan-builder.js";

const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createConsoleService(options = {}) {
  const { engine, store, approvalSigningKey, release, maxSourceBytes } = options;
  const mBytes = maxSourceBytes ?? engine?.PRODUCTION_POLICY?.maxSourceBytes;
  if (!engine?.SpoolCommandService) consoleFail("CONSOLE_INTERNAL_ERROR", "Engine loader must provide SpoolCommandService");
  if (!store) consoleFail("CONSOLE_INTERNAL_ERROR", "Workspace store is required");
  if (typeof approvalSigningKey !== "string" && !Buffer.isBuffer(approvalSigningKey) && !(approvalSigningKey instanceof Uint8Array)) {
    consoleFail("CONSOLE_INTERNAL_ERROR", "approvalSigningKey is required");
  }
  const sourceDiscovery = createSourceDiscovery({ engine, maxSourceBytes: mBytes });
  const sqliteCatalog = createSqliteCatalog({ engine });
  const recipes = createRecipeService({ engine, store });
  const services = new Map();

  function migrationKey(migrationId) {
    if (!MIGRATION_ID_PATTERN.test(migrationId ?? "")) consoleFail("CONSOLE_VALIDATION_FAILED", "Invalid migrationId");
    return migrationId;
  }

  async function getOrCreateService(migration) {
    const id = migrationKey(migration.migrationId);
    if (services.has(id)) return services.get(id);
    const sourceRoot = migration.sourceRoot ?? dirname(migration.sourcePath);
    const targetRoot = migration.targetRoot ?? dirname(migration.targetPath);
    const migrationDir = migration.migrationDir;
    await mkdir(migrationDir, { recursive: true });
    const statePath = join(migrationDir, "state.db");
    const snapshotDir = join(migrationDir, "snapshots");
    await mkdir(snapshotDir, { recursive: true });
    const svc = await engine.SpoolCommandService.create({
      sourceRoot,
      targetRoot,
      statePath,
      snapshotDir,
      approvalSigningKey,
      maxSourceBytes: mBytes,
      release: release ?? {
        version: process.env.SPOOL_RELEASE_VERSION ?? engine.PRODUCTION_POLICY?.release ?? "1.1.2",
        commitSha: process.env.SPOOL_COMMIT_SHA
      }
    });
    services.set(id, svc);
    return svc;
  }

  async function createMigration({ workspaceId, name, sourceProfile, destination, mapping, mappingRevision, planRevision, batchSize }) {
    const workspace = store.getWorkspace(workspaceId);
    const migrationId = `mig_${randomUUID()}`;
    const migrationDir = join(workspace.directory, "migrations", migrationId);
    await mkdir(migrationDir, { recursive: true });
    const record = store.createMigrationRecord({
      migrationId,
      workspaceId,
      name,
      sourcePath: sourceProfile.path,
      sourceRoot: dirname(sourceProfile.path),
      targetPath: destination.path,
      targetRoot: dirname(destination.path),
      tableName: destination.table,
      migrationDir,
      planInput: buildPlanInput({ sourceProfile, destination, mapping, mappingRevision, planRevision, batchSize }),
      targetSchema: destination.targetSchema,
      mapping,
      mappingRevision,
      planRevision
    });
    store.recordActivity({ category: "migration", workspaceId, migrationId, code: "MIGRATION_CREATED", detail: { name }, severity: "info" });
    store.updateMigrationStatus(migrationId, { status: "CREATED", state: "CREATED" });
    return record;
  }

  async function plan(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    const request = { migrationId: id, principal: "console:user", planInput: record.planInput };
    const planned = await svc.plan(request);
    store.updateMigrationPlan(id, { plan: planned });
    store.updateMigrationStatus(id, { status: "PLANNED", state: "PLANNED" });
    store.recordActivity({ category: "migration", workspaceId: record.workspaceId, migrationId: id, code: "PLAN_CREATED", detail: { planId: planned.planId }, severity: "info" });
    return planned;
  }

  async function dryRun(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    const request = { migrationId: id, principal: "console:user", planInput: record.planInput };
    const result = await svc.dryRun(request);
    store.updateMigrationPlan(id, { dryRun: result });
    store.updateMigrationStatus(id, { status: "DRY_RUN", state: "DRY_RUN" });
    store.recordActivity({ category: "migration", workspaceId: record.workspaceId, migrationId: id, code: "DRY_RUN_COMPLETE", detail: { validRows: result.validRows, invalidRows: result.invalidRows }, severity: "info" });
    return result;
  }

  async function approve(migrationId, { expiresMinutes } = {}) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    const request = { migrationId: id, principal: "console:user", planInput: record.planInput };
    const expiresAt = new Date(Date.now() + (expiresMinutes ?? 60) * 60_000).toISOString();
    const nonce = randomUUID();
    const approval = await svc.approve(request, { expiresAt, nonce });
    store.updateMigrationPlan(id, { approval });
    store.updateMigrationStatus(id, { status: "APPROVED", state: "APPROVED" });
    store.recordActivity({ category: "migration", workspaceId: record.workspaceId, migrationId: id, code: "MIGRATION_APPROVED", detail: { approvalId: approval.approvalId }, severity: "info" });
    return approval;
  }

  async function execute(migrationId, { approval } = {}) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    if (record.lastStatus === "RUNNING" || record.lastState === "RUNNING") {
      consoleFail("MIGRATION_ALREADY_RUNNING", "A migration run is already in progress");
    }
    const svc = await getOrCreateService(record);
    const request = { migrationId: id, principal: "console:user", planInput: record.planInput };
    store.updateMigrationStatus(id, { status: "RUNNING", state: "RUNNING" });
    try {
      const result = await svc.run(request, { approval });
      const status = result.status === "COMPLETE" ? "COMPLETE" : result.status;
      store.updateMigrationStatus(id, { status, state: status });
      store.recordActivity({ category: "migration", workspaceId: record.workspaceId, migrationId: id, code: result.status === "COMPLETE" ? "MIGRATION_COMPLETE" : "MIGRATION_STATUS", detail: { status: result.status }, severity: result.status === "COMPLETE" ? "info" : "warning" });
      return result;
    } catch (error) {
      store.updateMigrationStatus(id, { status: "FAILED", state: "FAILED" });
      store.recordActivity({ category: "migration", workspaceId: record.workspaceId, migrationId: id, code: "MIGRATION_FAILED", detail: { message: error?.message }, severity: "error" });
      throw error;
    }
  }

  async function status(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    const runStatus = typeof svc.status === "function" ? svc.status(id) : null;
    const durable = typeof svc.migrationState === "function" ? svc.migrationState(id) : null;
    store.updateMigrationStatus(id, { status: record.lastStatus, state: durable?.currentState ?? record.lastState });
    return { record, runStatus, durableState: durable };
  }

  async function recoveryDecision(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    if (typeof svc.restartDecision === "function") return svc.restartDecision(id);
    return { action: "UNKNOWN" };
  }

  async function transitions(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    if (typeof svc.transitions === "function") return svc.transitions(id);
    return [];
  }

  async function verification(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    if (typeof svc.verification === "function") return svc.verification(id);
    return null;
  }

  async function receipt(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    const svc = await getOrCreateService(record);
    if (typeof svc.receipt === "function") return svc.receipt(id);
    return null;
  }

  async function history(opts = {}) {
    return store.listMigrations(opts);
  }

  function getMigration(migrationId) {
    return store.getMigrationRecord(migrationId);
  }

  async function closeAll() {
    for (const [id, svc] of services) {
      try { svc.close(); } catch {}
    }
    services.clear();
  }

  return Object.freeze({
    createMigration,
    plan,
    dryRun,
    approve,
    execute,
    status,
    recoveryDecision,
    history,
    transitions,
    verification,
    receipt,
    getMigration,
    closeAll,
    sourceDiscovery,
    sqliteCatalog,
    recipes,
    store
  });
}
