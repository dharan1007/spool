import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { consoleFail } from "./errors.js";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function createEvidenceService({ store }) {
  async function exportBundle({ migrationId, directory }) {
    const record = store.getMigrationRecord(migrationId);
    const dir = directory ?? join(record.migrationDir, "evidence");
    await mkdir(dir, { recursive: true });
    const bundle = {
      format: "spool-console-evidence-v1",
      migrationId: record.migrationId,
      workspaceId: record.workspaceId,
      exportedAt: new Date().toISOString(),
      planInput: record.planInput,
      plan: record.plan,
      dryRun: record.dryRun,
      approval: record.approval,
      targetSchema: record.targetSchema,
      mapping: record.mapping,
      mappingRevision: record.mappingRevision,
      planRevision: record.planRevision,
      lastStatus: record.lastStatus,
      lastState: record.lastState
    };
    const text = JSON.stringify(bundle, null, 2) + "\n";
    const buf = Buffer.from(text, "utf8");
    const manifest = {
      format: "spool-console-evidence-manifest-v1",
      bundleFile: "evidence.json",
      bundleSha256: sha256(buf),
      bytes: buf.length,
      exportedAt: bundle.exportedAt
    };
    const bundlePath = join(dir, "evidence.json");
    const manifestPath = join(dir, "manifest.json");
    await writeFile(bundlePath, buf);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    if (store.recordActivity) {
      store.recordActivity({ category: "evidence", workspaceId: record.workspaceId, migrationId, code: "EVIDENCE_EXPORTED", detail: { bundlePath }, severity: "info" });
    }
    return { path: bundlePath, manifestPath, bytes: buf.length, manifest };
  }

  async function verifyBundle({ path }) {
    try {
      const manifestPath = String(path).endsWith("manifest.json") ? path : join(path, "manifest.json");
      const baseDir = dirname(manifestPath);
      const bundlePath = join(baseDir, "evidence.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const bundleBuf = await readFile(bundlePath);
      const actual = sha256(bundleBuf);
      if (manifest.bundleSha256 !== actual) {
        consoleFail("EVIDENCE_BUNDLE_INVALID", "Evidence bundle hash does not match manifest", { expected: manifest.bundleSha256, actual });
      }
      const bundle = JSON.parse(bundleBuf.toString("utf8"));
      if (bundle.format !== "spool-console-evidence-v1") {
        consoleFail("EVIDENCE_BUNDLE_INVALID", "Evidence bundle format is invalid");
      }
      return { valid: true, bundle, manifest };
    } catch (error) {
      if (error?.code) throw error;
      consoleFail("EVIDENCE_BUNDLE_INVALID", "Evidence bundle could not be verified");
    }
  }

  return Object.freeze({ exportBundle, verifyBundle });
}
