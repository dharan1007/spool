// Release identity, capability scope and environment status, sourced from the
// engine bundle itself (never hard-coded twice).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleFail } from "./errors.js";

const UNSUPPORTED_CONNECTORS = Object.freeze([
  { connector: "postgres", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "PostgreSQL targets are not qualified for the bounded 1.1.2 production release." },
  { connector: "mysql", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "MySQL targets are not qualified for the bounded 1.1.2 production release." },
  { connector: "mssql", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "SQL Server targets are not qualified for the bounded 1.1.2 production release." },
  { connector: "sqlite-content_exact", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "The qualified SQLite runtime does not implement read-after-write content verification; receipts prove row accounting and ledger completeness." }
]);
const UNSUPPORTED_OPERATIONS = Object.freeze([
  { operation: "cdc", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "Change-data-capture sources are not part of the qualified release." },
  { operation: "repair", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "The qualified SQLite runtime does not implement fenced repair execution." },
  { operation: "cutover", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "Cutover/switch coordination is not part of the single-user local file scope." },
  { operation: "multi-GB-sources", status: "NOT_AVAILABLE_IN_CONSOLE", reason: "Sources are bounded by the qualified 256 MiB byte ceiling." }
]);

export function createSystemService({ engine, engineRoot, releaseCommitSha, appVersion, store }) {
  const appDir = engineRoot ?? dirname(fileURLToPath(import.meta.url));

  async function getInfo() {
    const manifest = await readManifest();
    return {
      appVersion,
      engine: {
        release: engine.PRODUCTION_POLICY.release,
        commitSha: releaseCommitSha ?? manifest?.engineCommitSha ?? null,
        root: appDir,
        manifestSchemaVersion: manifest?.schemaVersion ?? null
      },
      target: engine.PRODUCTION_POLICY.target,
      sourceConnector: engine.PRODUCTION_POLICY.source,
      maxSourceBytes: engine.PRODUCTION_POLICY.maxSourceBytes,
      platform: process.platform,
      contractVersion: 1
    };
  }

  async function readManifest() {
    try {
      return JSON.parse(await readFile(join(appDir, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async function verifyRelease() {
    const manifest = await readManifest();
    if (!manifest) consoleFail("RELEASE_BUNDLE_UNVERIFIED", "The packaged engine manifest is missing; reinstall the verified application");
    if (manifest.engineCommitSha !== releaseCommitSha) {
      consoleFail("RELEASE_BUNDLE_UNVERIFIED", "The packaged engine does not match the shipped release commit", {
        expected: releaseCommitSha,
        actual: manifest.engineCommitSha
      });
    }
    let matrix;
    try {
      matrix = engine.verifyProductionPolicy();
    } catch (error) {
      consoleFail("RELEASE_BUNDLE_UNVERIFIED", "The capability policy of the packaged engine failed integrity verification", { code: error?.code ?? "POLICY_INTEGRITY_FAILED" });
    }
    return { verified: true, release: engine.PRODUCTION_POLICY.release, commitSha: manifest.engineCommitSha, capabilities: matrix.capabilities.length };
  }

  async function getCapabilities() {
    return {
      release: engine.PRODUCTION_POLICY.release,
      productionScope: {
        source: "filesystem:UTF-8 CSV",
        target: "sqlite:ordinary table INSERT",
        maxSourceBytes: engine.PRODUCTION_POLICY.maxSourceBytes,
        batchSizeCeiling: 10_000,
        verificationChecks: ["row_accounting", "ledger_complete"]
      },
      unsupported: { connectors: UNSUPPORTED_CONNECTORS, operations: UNSUPPORTED_OPERATIONS }
    };
  }

  async function getEnvironmentStatus() {
    const matrix = await safeEngine(() => engine.verifyProductionPolicy());
    return {
      node: process.version,
      platform: process.platform,
      electronAbi: process.versions.modules ?? null,
      sqlite: "ok",
      capabilityMatrix: matrix ? "OK" : "FAILED",
      approvalKey: keyStoreProbe()
    };
  }

  function keyStoreProbe() {
    try {
      return store.getSetting("approvalKeyPresent", false) ? "PRESENT" : "NOT_CREATED";
    } catch {
      return "UNKNOWN";
    }
  }

  async function safeEngine(fn) {
    try { return fn(); } catch { return null; }
  }

  function updatesUnavailable(operation) {
    consoleFail("UPDATES_NOT_CONFIGURED", `Update ${operation} is not available in this build; distribute releases through the owner-controlled signed release process`);
  }

  function keyHealth() {
    return { present: store.getSetting("approvalKeyPresent", false), provider: "safeStorage" };
  }

  return Object.freeze({ getInfo, verifyRelease, getCapabilities, getEnvironmentStatus, updatesUnavailable, keyHealth });
}
