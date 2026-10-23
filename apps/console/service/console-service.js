// Orchestrator for the SPOOL Console service layer.
//
// Every migration gets an isolated engine instance (state.db + snapshots under
// the migration directory) with strict path containment: the engine's
// sourceRoot is the CSV's directory and targetRoot is the SQLite file's
// directory. All mutation goes through SpoolCommandService; the Console adds
// no second parser, planner or executor.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { consoleFail } from "./errors.js";
import { createSourceDiscovery } from "./source-discovery.js";
import { createSqliteCatalog } from "./sqlite-catalog.js";
import { createRecipeService } from "./recipes.js";
import { buildPlanInput, validateMapping } from "./plan-builder.js";

const PRINCIPAL = "console:user";
const MIGRATION_STATUS = Object.freeze({
  CREATED: "CREATED", PLANNED: "PLANNED", DRY_RUN: "DRY_RUN",
  AWAITING_APPROVAL: "AWAITING_APPROVAL", APPROVED: "APPROVED",
  RUNNING: "RUNNING", FAILED: "FAILED", COMPLETE: "COMPLETE"
});

export function createConsoleService(options = {}) {
  const { engine, store, approvalSigningKey, release } = options;
  const maxSourceBytes = options.maxSourceBytes ?? engine?.PRODUCTION_POLICY?.maxSourceBytes;
  if (!engine?.SpoolCommandService) consoleFail("CONSOLE_INTERNAL_ERROR", "Engine loader must provide SpoolCommandService");
  if (!store) consoleFail("CONSOLE_INTERNAL_ERROR", "Workspace store is required");
  if (typeof approvalSigningKey !== "string" && !Buffer.isBuffer(approvalSigningKey) && !(approvalSigningKey instanceof Uint8Array)) {
    consoleFail("CONSOLE_INTERNAL_ERROR", "approvalSigningKey is required");
  }

  const sourceDiscovery = createSourceDiscovery({ engine, maxSourceBytes });
  const sqliteCatalog = createSqliteCatalog({ engine });
  const recipes = createRecipeService({ engine, store });
  const services = new Map();      // migrationId -> SpoolCommandService
  const running = new Set();       // migrationIds an execute() call owns

  const engineRelease = () => release ?? {
    version: engine.PRODUCTION_POLICY?.release ?? "1.1.2",
    commitSha: process.env.SPOOL_COMMIT_SHA
  };

  async function getOrCreateService(record) {
    const migrationId = record.migrationId;
    const existing = services.get(migrationId);
    if (existing) return existing;
    await mkdir(record.migrationDir, { recursive: true });
    const svc = await engine.SpoolCommandService.create({
      sourceRoot: record.sourceRoot,
      targetRoot: record.targetRoot,
      statePath: join(record.migrationDir, "state.db"),
      snapshotDir: join(record.migrationDir, "snapshots"),
      approvalSigningKey,
      maxSourceBytes,
      release: engineRelease()
    });
    services.set(migrationId, svc);
    return svc;
  }

  function requestFor(record) {
    return {
      migrationId: record.migrationId,
      principal: PRINCIPAL,
      planInput: structuredClone(record.planInput)
    };
  }

  async function readSourceProfile(record) {
    try {
      return JSON.parse(await readFile(join(record.migrationDir, "source-profile.json"), "utf8"));
    } catch {
      consoleFail("SOURCE_PROFILE_NOT_FOUND", "Source profile is missing; re-inspect the source file", { migrationId: record.migrationId });
    }
  }

  async function assertSourceUnchanged(record) {
    await sourceDiscovery.assertUnchanged(await readSourceProfile(record));
  }

  function setLocally(record, status, state, extra = {}) {
    store.updateMigrationStatus(record.migrationId, { status, state });
    return { ...record, lastStatus: status, lastState: state, ...extra };
  }

  async function createMigration({ workspaceId, name, sourceProfile, destination, mapping, mappingRevision, planRevision, batchSize }) {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace || workspace.archivedAt) consoleFail("WORKSPACE_ARCHIVED", "Restore the workspace before starting new work");
    const validation = validateMapping({ engine, mapping, targetSchema: destination.targetSchema, sourceHeaders: sourceProfile.headers ?? [] });
    if (!validation.valid) consoleFail("MAPPING_INCOMPLETE", "Mapping does not cover the target schema", { problems: validation.problems });
    // Destination must preflight against the engine before a record exists.
    await sqliteCatalog.preflight({ path: destination.path, table: destination.table, targetSchema: destination.targetSchema });
    const migrationId = `mig_${randomUUID()}`;
    const migrationDir = join(workspace.directory, "migrations", migrationId);
    await mkdir(join(migrationDir, "snapshots"), { recursive: true });
    await writeFile(join(migrationDir, "source-profile.json"), JSON.stringify(sourceProfile, null, 2) + "\n", "utf8");
    const planInput = buildPlanInput({ sourceProfile, destination, mapping, mappingRevision, planRevision, batchSize });
    const record = store.createMigrationRecord({
      migrationId, workspaceId, name,
      sourcePath: sourceProfile.path, sourceRoot: dirname(sourceProfile.path),
      targetPath: destination.path, targetRoot: dirname(destination.path),
      tableName: destination.table, migrationDir,
      planInput, targetSchema: destination.targetSchema, mapping,
      mappingRevision, planRevision
    });
    store.recordActivity({
      category: "migration", workspaceId, migrationId, code: "MIGRATION_CREATED",
      detail: { name, batchSize }, severity: "info"
    });
    return setLocally(record, MIGRATION_STATUS.CREATED, "CREATED");
  }

  const mapping = {
    validate: ({ mapping: entries, targetSchema, sourceHeaders = [] }) =>
      validateMapping({ engine, mapping: entries, targetSchema, sourceHeaders })
  };

  async function plan(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    await assertSourceUnchanged(record);
    const svc = await getOrCreateService(record);
    const plan = await svc.plan(requestFor(record));
    store.updateMigrationPlan(record.migrationId, { plan });
    store.recordActivity({
      category: "migration", workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: "PLAN_CREATED", detail: { planId: plan.planId, planRevision: plan.planRevision }, severity: "info"
    });
    return setLocally(store.getMigrationRecord(record.migrationId), "PLANNED", "PLANNED", { plan });
  }

  async function dryRun(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    if (!record.plan) consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Generate the plan before the dry-run");
    await assertSourceUnchanged(record);
    const svc = await getOrCreateService(record);
    const result = await svc.dryRun(requestFor(record));
    if (result.planId !== record.plan.planId) {
      consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Dry-run used a different plan; regenerate the plan and retry", { planId: result.planId, expected: record.plan.planId });
    }
    store.updateMigrationPlan(record.migrationId, { dryRun: result });
    store.recordActivity({
      category: "migration", workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: "DRY_RUN_COMPLETE",
      detail: { validRows: result.validRows, invalidRows: result.invalidRows }, severity: "info"
    });
    return setLocally(store.getMigrationRecord(record.migrationId), "DRY_RUN", "DRY_RUN", { dryRun: result });
  }

  async function approve(migrationId, { expiresMinutes } = {}) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    if (!record.plan || !record.dryRun) consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Plan and dry-run must be recorded before approval");
    await assertSourceUnchanged(record);
    const svc = await getOrCreateService(record);
    const request = requestFor(record);
    const currentPlan = await svc.plan(request);
    if (currentPlan.planId !== record.plan.planId) {
      const refreshed = {...record, plan: currentPlan};
      store.updateMigrationPlan(record.migrationId, { plan: currentPlan });
      consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Source or design changed since the recorded plan; review the new plan and dry-run again");
    }
    if (record.dryRun.planId !== record.plan.planId) {
      consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Recorded dry-run does not bound the current plan");
    }
    const minutes = expiresMinutes ?? store.getSetting("approvalMinutes", 60);
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const nonce = randomUUID();
    let approval;
    try {
      approval = await svc.approve(request, { expiresAt, nonce });
    } catch (error) {
      // Failure leaves the durable state advanced; status re-read keeps the
      // Console index honest for the recovery view.
      throw error;
    }
    store.updateMigrationPlan(record.migrationId, { approval });
    store.recordActivity({
      category: "approval", workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: "MIGRATION_APPROVED", detail: { approvalId: approval.approvalId, expiresAt }, severity: "info"
    });
    return setLocally(store.getMigrationRecord(record.migrationId), "APPROVED", "APPROVED", { approval });
  }

  async function execute(migrationId) {
    const id = migrationKey(migrationId);
    const record = store.getMigrationRecord(id);
    // Synchronous duplicate-run guard: the second call can never observe
    // RUNNING in time through the async store alone.
    if (running.has(id)) consoleFail("MIGRATION_ALREADY_RUNNING", "A run is already active for this migration");
    if (record.lastStatus === MIGRATION_STATUS.RUNNING) consoleFail("MIGRATION_ALREADY_RUNNING", "A run is already active for this migration");
    if (!record.approval) consoleFail("MIGRATION_STEP_OUT_OF_ORDER", "Approval must be recorded before execution", { migrationId: id });
    await assertSourceUnchanged(record);
    const svc = await getOrCreateService(record);
    const approval = { ...record.approval, record: { ...record.approval.record ?? {} } };
    running.add(id);
    store.updateMigrationStatus(id, { status: "RUNNING", state: "RUNNING" });
    store.recordActivity({
      category: "execution", workspaceId: record.workspaceId, migrationId: id,
      code: "MIGRATION_RUN_STARTED", detail: { approvalId: record.approval.approvalId }, severity: "info"
    });
    try {
      const result = await svc.run(requestFor(record), { approval });
      const complete = result.status === "COMPLETE";
      store.updateMigrationStatus(id, {
        status: complete ? "COMPLETE" : String(result.status),
        state: complete ? "COMPLETE" : String(result.status)
      });
      store.recordActivity({
        category: "execution", workspaceId: record.workspaceId, migrationId: id,
        code: complete ? "MIGRATION_COMPLETE" : "MIGRATION_RUN_RESULT",
        detail: { status: result.status, rows: result.verification?.record?.writtenRows ?? null },
        severity: complete ? "info" : "warning"
      });
      return result;
    } catch (error) {
      const durable = (() => { try { return svc.migrationState(id)?.currentState ?? null; } catch { return null; } })();
      const status = durable ?? "FAILED";
      store.updateMigrationStatus(id, { status, state: durable ?? "FAILED" });
      store.recordActivity({
        category: "execution", workspaceId: record.workspaceId, migrationId: id,
        code: "MIGRATION_RUN_FAILED",
        detail: { code: error?.code ?? null, durableState: durable }, severity: "error"
      });
      throw error;
    } finally {
      running.delete(id);
    }
  }

  async function status(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    const svc = services.get(record.migrationId) ?? await getOrCreateService(record);
    let runStatus = null;
    try { runStatus = svc.status(record.migrationId); } catch (error) { runStatus = { error: error?.code ?? "STATUS_UNAVAILABLE" }; }
    let durableState = null;
    try { durableState = svc.migrationState(record.migrationId); } catch { durableState = null; }
    if (durableState?.currentState && durableState.currentState !== record.lastState) {
      store.updateMigrationStatus(record.migrationId, { status: record.lastStatus, state: durableState.currentState });
    }
    let recovery = null;
    try { recovery = svc.restartDecision(record.migrationId); } catch { recovery = null; }
    return { record: store.getMigrationRecord(record.migrationId), runStatus, durableState, recovery };
  }

  function transitionSnapshot(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    const svc = services.get(record.migrationId);
    if (!svc) return { transitions: [], durableState: null };
    let transitions = [];
    let durableState = null;
    try { transitions = svc.transitions(record.migrationId); durableState = svc.migrationState(record.migrationId); }
    catch { /* engine state not yet initialised */ }
    return { transitions, durableState };
  }

  async function recoveryDecision(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    const svc = services.get(record.migrationId) ?? await getOrCreateService(record);
    try {
      return { record, decision: svc.restartDecision(record.migrationId) };
    } catch (error) {
      return { record, decision: { action: "NOT_APPLICABLE", reason: error?.code ?? null } };
    }
  }

  async function verification(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    const svc = services.get(record.migrationId);
    if (!svc) return null;
    try { return svc.verification(record.migrationId); }
    catch (error) { return { error: error?.code ?? "VERIFICATION_NOT_AVAILABLE" }; }
  }

  async function receipt(migrationId) {
    const record = store.getMigrationRecord(migrationKey(migrationId));
    const svc = services.get(record.migrationId);
    if (!svc) return null;
    try { return svc.receipt(record.migrationId); }
    catch (error) { return { error: error?.code ?? "RECEIPT_NOT_AVAILABLE" }; }
  }

  function migrationKey(migrationId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(migrationId ?? "")) {
      consoleFail("CONSOLE_VALIDATION_FAILED", "Invalid migrationId", { migrationId: null });
    }
    return migrationId;
  }

  const mappingApi = {
    validate: ({ mapping: entries, targetSchema, sourceHeaders = [] }) =>
      validateMapping({ engine, mapping: entries, targetSchema, sourceHeaders })
  };

  async function closeAll() {
    for (const svc of services.values()) { try { svc.close(); } catch {} }
    services.clear();
    running.clear();
  }

  return Object.freeze({
    createMigration, plan, dryRun, approve, execute, status,
    recoveryDecision, transitions: transitionSnapshot, verification, receipt,
    history: (opts = {}) => store.listMigrations(opts),
    getMigration: id => store.getMigrationRecord(id),
    closeAll,
    sourceDiscovery, sqliteCatalog, recipes, mapping: mappingApi, store
  });
}
