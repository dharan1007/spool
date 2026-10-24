// SPOOL Console � Electron main process.
//
// Single window, sandboxed renderer, one validated IPC bridge. The privileged
// side (this process) owns: the engine bundle, the console service layer, the
// workspace metadata store and the approval signing key. The renderer holds no
// authority of any kind.
import { app, BrowserWindow } from "electron";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { loadEngine } from "../service/engine-loader.js";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createConsoleService } from "../service/console-service.js";
import { createEvidenceService } from "../service/evidence.js";
import { createDiagnosticsService } from "../service/diagnostics.js";
import { createSystemService } from "../service/system-service.js";
import { createSettingsService } from "../service/settings-service.js";
import { createIpcRouter } from "../service/ipc-router.js";
import { createKeyStore } from "./key-store.js";
import { createDialogService } from "./dialogs.js";
import { registerIpc } from "./ipc.js";
import { hardenWindow, setContentSecurityPolicy } from "./security.js";
import { toEnvelope, ConsoleError } from "../service/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolvePath(HERE, "..");
// Packaged builds place the engine bundle (and its manifest, which the release
// binding is verified against) under resources/ outside the asar; development
// runs read it straight from the app directory.
const ENGINE_ROOT = app.isPackaged ? join(process.resourcesPath, "engine") : join(APP_ROOT, "engine");
// The loader resolves engine modules relative to the src tree; the manifest
// and capability matrix stay at the engine root.
const ENGINE_SRC_ROOT = join(ENGINE_ROOT, "src");
const RELEASE_COMMIT_SHA = expectReleaseSha();

function expectReleaseSha() {
  // The packaged engine bundle records the exact engine commit it was built
  // from; it is bound into the release by sync-engine.mjs at packaging time.
  const manifestPath = join(ENGINE_ROOT, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!/^[a-f0-9]{40}$/.test(manifest.engineCommitSha ?? "")) {
      failStartup("RELEASE_BUNDLE_UNVERIFIED", "Packaged engine manifest lacks a valid engine commit SHA");
    }
    return manifest.engineCommitSha;
  } catch (error) {
    failStartup("RELEASE_BUNDLE_UNVERIFIED", "Packaged engine manifest is missing or unreadable � reinstall the verified application");
  }
}


function failStartup(code, message) {
  const envelope = toEnvelope(new ConsoleError(code, message, {}));
  app.whenReady().then(() => app.quit());
  throw new Error(`${envelope.code}: ${envelope.message}`);
}

const win = () => BrowserWindow.getAllWindows()[0] ?? null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(APP_ROOT, "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: false,
      spellcheck: false
    }
  });
  hardenWindow(window);
  setContentSecurityPolicy(window);
  const indexFile = join(APP_ROOT, "dist", "renderer", "index.html");
  window.once("ready-to-show", () => window.show());
  window.loadFile(indexFile);
  return window;
}

async function boot() {
  await app.whenReady();
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.on("window-all-closed", () => app.quit());

  const engine = await loadEngine(ENGINE_SRC_ROOT);
  const userData = app.getPath("userData");
  const workspaceRoot = join(userData, "workspaces");
  const store = new WorkspaceStore({ path: join(userData, "console-meta.db") });
  const keyStore = createKeyStore();
  const approvalSigningKey = keyStore.loadOrCreate();

  const service = createConsoleService({
    engine, store, approvalSigningKey,
    release: { version: engine.PRODUCTION_POLICY.release, commitSha: RELEASE_COMMIT_SHA },
    maxSourceBytes: engine.PRODUCTION_POLICY.maxSourceBytes
  });
  const evidence = createEvidenceService({ store });
  const diagnostics = createDiagnosticsService({ store, engineRoot: ENGINE_ROOT });
  const system = createSystemService({
    engine, engineRoot: ENGINE_ROOT, releaseCommitSha: RELEASE_COMMIT_SHA,
    appVersion: app.getVersion(), store
  });
  const settings = createSettingsService({ store });
  const dialogs = createDialogService({ getWindow: win });

  const router = createIpcRouter({
    service, evidence, diagnostics, dialogs, system, settings,
    activity: args => store.recordActivity(args)
  });
  registerIpc({ router, activity: args => store.recordActivity(args) });

  createWindow();
}

boot();
