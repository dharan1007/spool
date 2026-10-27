import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../service/workspace-store.js";
import { createSettingsService } from "../service/settings-service.js";
import { createIpcRouter } from "../service/ipc-router.js";

test("desktop first-run onboarding flow and settings qualification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spool-onboarding-test-"));
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const settings = createSettingsService({ store });

  // Initial state: onboarding is not complete
  const initial = settings.get();
  assert.equal(initial.onboardingComplete, false);

  // Complete onboarding
  const completed = settings.completeOnboarding({ workspaceRoot: dir });
  assert.equal(completed.onboardingComplete, true);

  // Subsequent get reflects completed state
  const updated = settings.get();
  assert.equal(updated.onboardingComplete, true);

  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("IPC router dispatches settings.completeOnboarding and validates contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spool-onboarding-ipc-"));
  const store = new WorkspaceStore({ path: join(dir, "meta.db") });
  const settings = createSettingsService({ store });

  const router = createIpcRouter({
    service: { store },
    settings
  });

  const res = await router("settings.completeOnboarding", { workspaceRoot: dir });
  assert.equal(res.ok, true);
  assert.equal(res.result.onboardingComplete, true);

  const current = await router("settings.get", {});
  assert.equal(current.ok, true);
  assert.equal(current.result.onboardingComplete, true);

  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("built desktop renderer bundle contains qualified onboarding UI", async () => {
  const bundleHtmlPath = join(process.cwd(), "dist", "renderer", "index.html");
  const html = await readFile(bundleHtmlPath, "utf8");
  assert.ok(html.length > 50, "Renderer index.html must be populated");

  // Check the built JS bundle for onboarding guarantees text
  const { readdir } = await import("node:fs/promises");
  const assetsDir = join(process.cwd(), "dist", "renderer", "assets");
  const files = await readdir(assetsDir);
  const jsBundle = files.find(f => f.endsWith(".js"));
  assert.ok(jsBundle, "Compiled JS bundle must exist");

  const bundleContent = await readFile(join(assetsDir, jsBundle), "utf8");
  assert.ok(bundleContent.includes("Zero data upload"), "Bundle must contain local-first onboarding guarantee");
  assert.ok(bundleContent.includes("Local-first safety invariants"), "Bundle must contain onboarding safety invariant text");
});
