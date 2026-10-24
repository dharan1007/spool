import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createEvidenceService } from "../service/evidence.js";

test("evidence export and verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spool-evidence-"));
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const ws = store.createWorkspace({ name: "t", directory: dir });
  const migrationDir = join(dir, "m");
  const record = store.createMigrationRecord({
    migrationId: "mig_test",
    workspaceId: ws.workspaceId,
    name: "m",
    sourcePath: join(dir, "s.csv"),
    sourceRoot: dir,
    targetPath: join(dir, "t.db"),
    targetRoot: dir,
    tableName: "t",
    migrationDir,
    planInput: { planRevision: 1 },
    targetSchema: [{ name: "id", type: "integer", nullable: false }],
    mapping: [{ target: "id", expr: { op: "cast_number", value: { op: "field", name: "id" } } }],
    mappingRevision: 1,
    planRevision: 1
  });
  const evidence = createEvidenceService({ store });
  const res = await evidence.exportBundle({ migrationId: record.migrationId, directory: join(dir, "ev") });
  const verified = await evidence.verifyBundle({ path: res.manifestPath });
  assert.equal(verified.valid, true);
  store.close();
});
