// Approval signing key storage. The key only exists inside the Electron main
// process: it is generated at first launch, encrypted with the OS credential
// store (Windows DPAPI through safeStorage) and never exposed to the renderer,
// neither in plaintext nor in encrypted form, via IPC.
//
// The pairing of approval-key.bin with approval-key.json protects against
// pre-marker artifacts: without a marker the bin is not trusted and is
// regenerated once. Once a marked pair exists, a decryption failure always
// fails closed (APPROVAL_KEY_UNAVAILABLE) - never a plaintext fallback.
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { consoleFail } from "../service/errors.js";

const MARKER_SCHEMA = 1;

export function createKeyStore() {
  const dataDir = app.getPath("userData");
  const binFile = join(dataDir, "approval-key.bin");
  const markerFile = join(dataDir, "approval-key.json");

  function encryptedAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      consoleFail("APPROVAL_KEY_UNAVAILABLE", "The OS credential store is required to protect the approval signing key");
    }
    return true;
  }

  function loadOrCreate() {
    encryptedAvailable();
    const marker = readMarker();
    if (!existsSync(binFile)) return createFresh();
    if (!marker) {
      // Bin without marker predates the pairing scheme: not trusted, not
      // user data (the key only ever protected console approvals).
      try { unlinkSync(binFile); } catch {}
      return createFresh();
    }
    if (marker.schema !== MARKER_SCHEMA || marker.provider !== "safeStorage") {
      consoleFail("APPROVAL_KEY_UNAVAILABLE", "Stored approval key was created by an unsupported mechanism");
    }
    try {
      const encrypted = readFileSync(binFile);
      if (!safeStorage.isEncrypted(encrypted)) {
        consoleFail("APPROVAL_KEY_UNAVAILABLE", "Stored approval key is not OS-protected; refusing plaintext fallback");
      }
      return safeStorage.decryptString(encrypted);
    } catch {
      consoleFail("APPROVAL_KEY_UNAVAILABLE", "Stored approval key cannot be decrypted with this Windows profile");
    }
  }

  function createFresh() {
    const key = randomBytes(32).toString("hex");
    writeFileSync(binFile, safeStorage.encryptString(key), { mode: 0o600 });
    writeFileSync(markerFile, JSON.stringify({
      schema: MARKER_SCHEMA,
      provider: "safeStorage",
      createdAt: new Date().toISOString()
    }, null, 2) + "\n", { mode: 0o600 });
    return key;
  }

  function readMarker() {
    if (!existsSync(markerFile)) return null;
    try {
      return JSON.parse(readFileSync(markerFile, "utf8"));
    } catch {
      return null;
    }
  }

  function health() {
    return {
      provider: safeStorage.isEncryptionAvailable() ? "safeStorage" : "UNAVAILABLE",
      paired: existsSync(binFile) && existsSync(markerFile)
    };
  }

  return Object.freeze({ loadOrCreate, health });
}
