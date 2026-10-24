// Electron-level harness: boots the same privileged graph as main.js and
// drives the full migration journey through the production IPC router.
// Usage: electron.exe scripts/harness.js
import { app } from "electron";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { loadEngine } from "../service/engine-loader.js";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createConsoleService } from "../service/console-service.js";
import { createEvidenceService } from "../service/evidence.js";
import { createSystemService } from "../service/system-service.js";
import { createSettingsService } from "../service/settings-service.js";
import { createIpcRouter } from "../service/ipc-router.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolvePath(HERE, "..");
const ENGINE_SRC = join(APP_ROOT, "engine", "src");
const ENGINE_ROOT = join(APP_ROOT, "engine");
const manifest = JSON.parse(readFileSync(join(ENGINE_ROOT, "manifest.json"), "utf8"));

async function main() {
  await app.whenReady();
  const engine = await loadEngine(ENGINE_SRC);
  const dir = mkdtempSync(join(tmpdir(), "spool-console-harness-"));
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const service = createConsoleService({
    engine, store,
    approvalSigningKey: "0123456789abcdef0123456789abcdef",
    release: { version: engine.PRODUCTION_POLICY.release, commitSha: manifest.engineCommitSha },
    maxSourceBytes: engine.PRODUCTION_POLICY.maxSourceBytes
  });
  const evidence = createEvidenceService({ store });
  const system = createSystemService({ engine, engineRoot: ENGINE_ROOT, releaseCommitSha: manifest.engineCommitSha, appVersion: "1.0.0-harness", store });
  const settings = createSettingsService({ store });
  const dialogs = {
    chooseDirectory: async () => null,
    chooseSourceCsv: async () => join(dir, "source.csv"),
    chooseSqliteDatabase: async () => join(dir, "crm.db")
  };
  const noop = {
    getInfo: async () => ({}), verifyRelease: async () => system.verifyRelease(),
    getCapabilities: async () => ({}), getEnvironmentStatus: async () => ({}),
    updatesUnavailable: async () => ({}), keyHealth: async () => ({})
  };
  const router = createIpcRouter({
    service, evidence,
    diagnostics: { get: async () => ({}), exportBundle: async () => ({}) },
    dialogs, system: noop, settings
  });

  const sourcePath = join(dir, "source.csv");
  let csv = "customer_id,full_name,monthly_fee,joined_on,is_active\n";
  for (let i = 1; i <= 40; i += 1) {
    csv += `${i}," Customer ${i} ",29.${i % 10}5,2024-0${(i % 9) + 1}-1${i % 9},${i % 2 === 0 ? "true" : "false"}\n`;
  }
  await writeFile(sourcePath, csv, "utf8");
  const targetPath = join(dir, "crm.db");
  const db = new Database(targetPath);
  db.exec("CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, monthly_fee REAL NOT NULL, joined_on TEXT NOT NULL, is_active INTEGER NOT NULL);");
  db.close();

  const verifyRelease = await router("system.verifyRelease", {});
  const space = await mkdir(join(dir, "ws"), { recursive: true }).then(() => "ok");
  const inspected = await router("source.inspect", { path: sourcePath });
  const tables = await router("destination.listTables", { path: targetPath });
  const tableInspect = await router("destination.inspect", { path: targetPath, table: "customers" });
  const ws = (await router("workspace.create", { name: "harness", directory: join(dir, "ws") })).result;

  const mapping = [
    { target: "customer_id", expr: { op: "cast_number", value: { op: "field", name: "customer_id" } } },
    { target: "full_name", expr: { op: "trim", value: { op: "field", name: "full_name" }, multiline: true } },
    { target: "monthly_fee", expr: { op: "cast_number", value: { op: "field", name: "monthly_fee" } } },
    { target: "joined_on", expr: { op: "parse_date", value: { op: "field", name: "joined_on" }, options: { outputFormat: "YYYY-MM-DD" } } },
    { target: "is_active", expr: { op: "cast_number", value: { op: "enum_map", value: { op: "trim", value: { op: "field", name: "is_active" } }, map: { "true": 1, "false": 0 } } } }
  ];
  const created = await router("migration.create", {
    workspaceId: ws.workspaceId,
    name: "harness journey",
    sourceProfile: inspected.result,
    destination: {
      path: targetPath, table: "customers",
      targetContractId: tableInspect.result.targetContractId,
      targetSchema: tableInspect.result.targetSchema
    },
    mapping, mappingRevision: 1, planRevision: 1, batchSize: 7
  });
  if (!created.ok) { console.error("CREATE_FAILED", JSON.stringify(created.error)); }
  const migrationId = created.result.migrationId;
  await router("migration.plan", { migrationId });
  const dry = await router("migration.dryRun", { migrationId });
  const approved = await router("migration.approve", { migrationId });
  const executed = await router("migration.execute", { migrationId });
  const receipt = await router("migration.receipt", { migrationId });
  const history = await router("migration.history", { workspaceId: ws.workspaceId });
  const db2 = new Database(targetPath, { readonly: true });
  const count = db2.prepare("SELECT COUNT(*) AS n FROM customers").get().n;
  db2.close();
  const bundle = await router("evidence.export", { migrationId, directory: join(dir, "evidence") });
  const verified = await router("evidence.verify", { path: bundle.result.manifestPath });
  const negative = await router("system.nuke", {});

  const out = {
    harness: "spool-console-ipc-v1",
    appRoot: APP_ROOT,
    engineCommitSha: manifest.engineCommitSha,
    verifyRelease: verifyRelease.result ?? verifyRelease.error ?? null,
    sourceRowCount: inspected.result?.rowCount ?? null,
    destinationTables: tables.result?.tables?.map(t => t.name) ?? null,
    workspace: space,
    migrationId,
    dryRun: dry.result?.dryRun ?? dry.error ?? null,
    approvalId: approved.result?.approval?.approvalId ?? approved.error ?? null,
    executeStatus: executed.result?.status ?? executed.error ?? null,
    receipt: receipt.result ? {
      receiptId: receipt.result.receiptId,
      verificationStatus: receipt.result.record?.verification?.status ?? null,
      writtenRows: receipt.result.record?.counts?.writtenRows ?? null,
      rejectedRows: receipt.result.record?.counts?.rejectedRows ?? null
    } : (receipt.error ?? null),
    targetRows: count,
    historyStatus: history.result?.items?.[0]?.status ?? history.error ?? null,
    evidenceVerified: verified.result?.valid ?? verified.error ?? null,
    unknownOpRejected: negative.error?.code ?? null
  };
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}

main().catch(error => {
  console.error("HARNESS_FAILED", error?.code ?? "", error?.message ?? error, "\n", error?.stack ?? "");
  app.exit(1);
});
