import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { loadEngine } from "../service/engine-loader.js";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createConsoleService } from "../service/console-service.js";

test("console service creates migration through engine path", async () => {
  const repoRoot = join(process.cwd(), "..", "..");
  const engine = await loadEngine(join(repoRoot, "src"));
  const dir = await mkdtemp(join(tmpdir(), "spool-console-test-"));
  const wsDir = join(dir, "ws");
  await mkdir(wsDir);
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const svc = createConsoleService({
    engine,
    store,
    approvalSigningKey: "0123456789abcdef0123456789abcdef",
    release: { version: "1.1.2", commitSha: "0123456789abcdef0123456789abcdef01234567" },
    maxSourceBytes: 256 * 1024 * 1024
  });
  const ws = store.createWorkspace({ name: "test", directory: wsDir });
  const sourcePath = join(dir, "source.csv");
  await writeFile(sourcePath, "id,name\n1,alice\n2,bob\n", "utf8");
  const targetPath = join(dir, "target.db");
  const db = new Database(targetPath);
  db.exec("CREATE TABLE people (id INTEGER, name TEXT);");
  db.close();
  const sourceProfile = await svc.sourceDiscovery.inspect({ path: sourcePath });
  const dest = await svc.sqliteCatalog.inspect({ path: targetPath, table: "people" });
  const mapping = [
    { target: "id", expr: { op: "cast_number", value: { op: "field", name: "id" } } },
    { target: "name", expr: { op: "trim", value: { op: "field", name: "name" } } }
  ];
  const record = await svc.createMigration({
    workspaceId: ws.workspaceId,
    name: "m1",
    sourceProfile,
    destination: { path: dest.path, table: dest.table, targetContractId: dest.targetContractId, targetSchema: dest.targetSchema },
    mapping,
    mappingRevision: 1,
    planRevision: 1,
    batchSize: 100
  });
  const plan = await svc.plan(record.migrationId);
  assert.equal(plan.planId, plan.planId);
  const dry = await svc.dryRun(record.migrationId);
  assert.equal(dry.validRows, 2);
  store.close();
  svc.closeAll();
});
