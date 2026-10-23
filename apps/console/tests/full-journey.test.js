import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { loadEngine } from "../service/engine-loader.js";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createConsoleService } from "../service/console-service.js";
import { createEvidenceService } from "../service/evidence.js";
import { createIpcRouter, ALLOWED_OPERATIONS } from "../service/ipc-router.js";
import { CONTRACT_VERSION } from "../service/contracts.js";
import { toEnvelope } from "../service/errors.js";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

async function fixture({ rows = 5, headline = "people" } = {}) {
  const engine = await loadEngine(join(process.cwd(), "..", "..", "src"));
  const dir = await mkdtemp(join(tmpdir(), "spool-console-journey-"));
  const wsDir = join(dir, "ws");
  await mkdir(wsDir, { recursive: true });
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const svc = createConsoleService({
    engine, store,
    approvalSigningKey: "0123456789abcdef0123456789abcdef",
    release: { version: "1.1.2", commitSha: COMMIT_SHA },
    maxSourceBytes: 256 * 1024 * 1024
  });
  const sourcePath = join(dir, "source.csv");
  let csv = "customer_id,full_name,monthly_fee,joined_on,is_active\n";
  for (let i = 1; i <= rows; i += 1) csv += `${i}," Customer ${i} ",19.${i % 10}5,2024-0${(i % 9) + 1}-1${i % 9},${i % 2 === 0 ? "true" : "false"}\n`;
  await writeFile(sourcePath, csv, "utf8");
  const targetPath = join(dir, "crm.db");
  const db = new Database(targetPath);
  db.exec("CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, monthly_fee REAL NOT NULL, joined_on TEXT NOT NULL, is_active INTEGER NOT NULL, silent_note TEXT);");
  db.close();
  const ws = store.createWorkspace({ name: "CRM", directory: wsDir });
  return { engine, dir, store, svc, ws, sourcePath, targetPath, wsDir };
}

test("full journey: inspect->create->plan->dryRun->approve->execute->receipt through engine", async () => {
  const f = await fixture({ rows: 5 });
  const { svc } = f;
  const profile = await svc.sourceDiscovery.inspect({ path: f.sourcePath });
  assert.equal(profile.rowCount, 5);
  assert.equal(profile.rowCountBasis, "exact");
  const dest = await svc.sqliteCatalog.inspect({ path: f.targetPath, table: "customers" });
  assert.ok(dest.targetContractId.startsWith("sha256:"));
  const columns = Object.fromEntries(dest.columns.map(c => [c.name, c]));
  const mapping = [
    { target: "customer_id", expr: { op: "cast_number", value: { op: "field", name: "customer_id" } } },
    { target: "full_name", expr: { op: "trim", value: { op: "field", name: "full_name" }, multiline: true } },
    { target: "monthly_fee", expr: { op: "cast_number", value: { op: "field", name: "monthly_fee" } } },
    { target: "joined_on", expr: { op: "parse_date", value: { op: "field", name: "joined_on" }, options: { outputFormat: "YYYY-MM-DD" } } },
    { target: "is_active", expr: { op: "cast_number", value: { op: "enum_map", value: { op: "trim", value: { op: "field", name: "is_active" } }, map: { "true": 1, "false": 0 } } } }
  ];
  void columns;
  const targetSchema = dest.targetSchema.filter(c => ["customer_id", "full_name", "monthly_fee", "joined_on", "is_active"].includes(c.name));
  const record = await svc.createMigration({
    workspaceId: f.ws.workspaceId,
    name: "crm import",
    sourceProfile: profile,
    destination: { path: dest.path, table: dest.table, targetContractId: dest.targetContractId, targetSchema },
    mapping, mappingRevision: 1, planRevision: 1, batchSize: 2
  });
  await svc.plan(record.migrationId);
  const dry = await svc.dryRun(record.migrationId);
  assert.equal(dry.dryRun.validRows, 5);
  assert.equal(dry.dryRun.invalidRows, 0);
  const approved = await svc.approve(record.migrationId);
  assert.ok(approved.approval?.approvalId ?? approved.approval?.record?.approvalId);
  const result = await svc.execute(record.migrationId);
  assert.equal(result.status, "COMPLETE");
  // entertainment receipt comes from the engine, not the Console
  const receipt = await svc.receipt(record.migrationId);
  assert.ok(receipt.record);
  const verification = await svc.verification(record.migrationId);
  assert.ok(verification);
  // target database got exactly 5 rows
  const db = new Database(f.targetPath, { readonly: true });
  const count = db.prepare("SELECT COUNT(*) AS n FROM customers").get().n;
  db.close();
  assert.equal(count, 5);
  // evidence export + verify
  const evidence = createEvidenceService({ store: f.store });
  const bundle = await evidence.exportBundle({ migrationId: record.migrationId });
  const verified = await evidence.verifyBundle({ path: bundle.manifestPath });
  assert.equal(verified.valid, true);
  // tamper test: modified bundle must fail verification
  const raw = JSON.parse(await readFile(bundle.path, "utf8"));
  raw.lastStatus = "COMPLETE";
  raw.lastState = "FAILED";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(bundle.path, JSON.stringify(raw, null, 2) + "\n", "utf8");
  await assert.rejects(() => evidence.verifyBundle({ path: bundle.manifestPath }), /hash does not match manifest/);
  // history shows completion
  const history = await svc.history({ workspaceId: f.ws.workspaceId });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].status, "COMPLETE");
  f.store.close();
  await svc.closeAll();
});

test("duplicate execute is rejected with MIGRATION_ALREADY_RUNNING", async () => {
  // no run needed: lastStatus RUNNING after first begin
  const f = await fixture({ rows: 3 });
  const { svc } = f;
  const profile = await svc.sourceDiscovery.inspect({ path: f.sourcePath });
  const dest = await svc.sqliteCatalog.inspect({ path: f.targetPath, table: "customers" });
  const mapping = [
    { target: "customer_id", expr: { op: "cast_number", value: { op: "field", name: "customer_id" } } },
    { target: "full_name", expr: { op: "trim", value: { op: "field", name: "full_name" }, multiline: true } },
    { target: "monthly_fee", expr: { op: "cast_number", value: { op: "field", name: "monthly_fee" } } },
    { target: "joined_on", expr: { op: "parse_date", value: { op: "field", name: "joined_on" }, options: { outputFormat: "YYYY-MM-DD" } } },
    { target: "is_active", expr: { op: "cast_boolean", value: { op: "field", name: "is_active" } } }
  ];
  const targetSchema = dest.targetSchema.filter(c => ["customer_id", "full_name", "monthly_fee", "joined_on", "is_active"].includes(c.name));
  const record = await svc.createMigration({
    workspaceId: f.ws.workspaceId, name: "m2", sourceProfile: profile,
    destination: { path: dest.path, table: dest.table, targetContractId: dest.targetContractId, targetSchema },
    mapping, mappingRevision: 1, planRevision: 1, batchSize: 100
  });
  // simulate a running run marker directly in the store: duplicate-run guard must trip
  f.store.updateMigrationStatus(record.migrationId, { status: "RUNNING", state: "RUNNING" });
  await assert.rejects(
    () => svc.execute(record.migrationId),
    error => error.code === "MIGRATION_ALREADY_RUNNING"
  );
  f.store.close();
  await svc.closeAll();
});

test("ipc router rejects unknown operations and extra fields", async () => {
  const f = await fixture({ rows: 2 });
  const evidence = createEvidenceService({ store: f.store });
  const diagnosticsStub = { get: () => ({}), exportBundle: async () => ({}) };
  const router = createIpcRouter({
    service: f.svc, evidence, diagnostics: diagnosticsStub,
    dialogs: { chooseDirectory: async () => null, chooseSourceCsv: async () => null, chooseSqliteDatabase: async () => null },
    system: { getInfo: async () => ({}), verifyRelease: async () => ({}), getCapabilities: async () => ({}), getEnvironmentStatus: async () => ({}), updatesUnavailable: async () => ({}), keyHealth: async () => ({}) },
    settings: { get: async () => ({}), update: async () => ({}), completeOnboarding: async () => ({}) }
  });
  assert.ok(ALLOWED_OPERATIONS.length > 30);
  const unknown = await router("system.nuke", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "CONSOLE_VALIDATION_FAILED");
  const extraField = await router("workspace.create", { name: "x", extra: "field" });
  assert.equal(extraField.ok, false);
  assert.equal(extraField.error.code, "CONSOLE_VALIDATION_FAILED");
  const notFound = await router("workspace.get", { workspaceId: "ws_missing" });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error.code, "WORKSPACE_NOT_FOUND");
  f.store.close();
  await f.svc.closeAll();
});

test("mapping validation rejects duplicate and unknown targets", async () => {
  const engine = await loadEngine(join(process.cwd(), "..", "..", "src"));
  const f = await fixture({ rows: 1 });
  const mappingApi = f.svc.mapping;
  const targetSchema = [
    { name: "a", type: "string", nullable: false },
    { name: "b", type: "string", nullable: true }
  ];
  const dup = mappingApi.validate({
    mapping: [
      { target: "a", expr: { op: "field", name: "customer_id" } },
      { target: "a", expr: { op: "field", name: "full_name" } },
      { target: "b", expr: { op: "field", name: "full_name" } }
    ],
    targetSchema, sourceHeaders: ["customer_id", "full_name", "monthly_fee"]
  });
  assert.equal(dup.valid, false);
  assert.ok(dup.problems.some(p => p.code === "DUPLICATE_TARGET"));
  const unknown = mappingApi.validate({
    mapping: [
      { target: "a", expr: { op: "field", name: "customer_id" } },
      { target: "zzz", expr: { op: "field", name: "full_name" } }
    ],
    targetSchema, sourceHeaders: ["customer_id", "full_name"]
  });
  assert.equal(unknown.valid, false);
  void engine;
  f.store.close();
  await f.svc.closeAll();
});

test("source modified between inspect and approve fails closed", async () => {
  const f = await fixture({ rows: 2 });
  const { svc } = f;
  const profile = await svc.sourceDiscovery.inspect({ path: f.sourcePath });
  const dest = await svc.sqliteCatalog.inspect({ path: f.targetPath, table: "customers" });
  const mapping = [
    { target: "customer_id", expr: { op: "cast_number", value: { op: "field", name: "customer_id" } } },
    { target: "full_name", expr: { op: "trim", value: { op: "field", name: "full_name" }, multiline: true } },
    { target: "monthly_fee", expr: { op: "cast_number", value: { op: "field", name: "monthly_fee" } } },
    { target: "joined_on", expr: { op: "parse_date", value: { op: "field", name: "joined_on" }, options: { outputFormat: "YYYY-MM-DD" } } },
    { target: "is_active", expr: { op: "cast_boolean", value: { op: "field", name: "is_active" } } }
  ];
  const targetSchema = dest.targetSchema.filter(c => ["customer_id", "full_name", "monthly_fee", "joined_on", "is_active"].includes(c.name));
  const record = await svc.createMigration({
    workspaceId: f.ws.workspaceId, name: "m3", sourceProfile: profile,
    destination: { path: dest.path, table: dest.table, targetContractId: dest.targetContractId, targetSchema },
    mapping, mappingRevision: 1, planRevision: 1, batchSize: 100
  });
  await svc.plan(record.migrationId);
  // mutate the source after planning
  const { appendFile } = await import("node:fs/promises");
  await appendFile(f.sourcePath, "9,Changed,1.0,2024-01-01,true\n", "utf8");
  await assert.rejects(() => svc.dryRun(record.migrationId), error => error.code === "SOURCE_UNCHANGED_CHECK_FAILED");
  f.store.close();
  await f.svc.closeAll();
});
