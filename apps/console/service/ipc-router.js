// Single dispatch table from validated IPC operations to the service layer.
// The main process passes every request through contracts.validateRequest()
// before this router runs; the renderer can never reach an undeclared op.
import { validateRequest, OPERATION_NAMES } from "./contracts.js";
import { toEnvelope } from "./errors.js";

export const ALLOWED_OPERATIONS = Object.freeze([...OPERATION_NAMES]);

export function createIpcRouter({ service, evidence, diagnostics, dialogs, system, settings }) {
  const table = Object.freeze({
    "system.getInfo": () => system.getInfo(),
    "system.verifyRelease": () => system.verifyRelease(),
    "system.getCapabilities": () => system.getCapabilities(),
    "system.getEnvironmentStatus": () => system.getEnvironmentStatus(),

    "workspace.create": p => service.store.createWorkspace(p),
    "workspace.list": p => service.store.listWorkspaces(p),
    "workspace.get": p => service.store.getWorkspace(p.workspaceId),
    "workspace.update": p => service.store.updateWorkspace(p),
    "workspace.archive": p => service.store.setWorkspaceArchived(p.workspaceId, p.archived),
    "workspace.impact": p => service.store.workspaceImpact(p.workspaceId),

    "source.choose": () => dialogs.chooseSourceCsv(),
    "source.inspect": async p => service.store.saveCache?.("sourceProfile:" + p.path, await service.sourceDiscovery.inspect(p)) ?? service.sourceDiscovery.inspect(p),
    "source.preview": p => service.sourceDiscovery.preview(p),

    "destination.choose": () => dialogs.chooseSqliteDatabase(),
    "destination.listTables": p => service.sqliteCatalog.listTables(p),
    "destination.inspect": p => service.sqliteCatalog.inspect(p),
    "destination.preflight": p => service.sqliteCatalog.preflight(p),

    "mapping.validate": p => service.mapping.validate(p),
    "mapping.saveDraft": p => service.store.saveDraft(p),
    "mapping.getDraft": p => service.store.getDraft(p.draftId),
    "mapping.listDrafts": p => service.store.listDrafts({ workspaceId: p.workspaceId ?? null }),
    "mapping.deleteDraft": p => service.store.deleteDraft(p.draftId),
    "mapping.listRecipes": p => service.recipes.list({ query: p.query ?? null }),
    "mapping.saveRecipe": p => service.recipes.save(p),
    "mapping.exportRecipe": p => service.recipes.exportRecipe(p),
    "mapping.importRecipe": p => service.recipes.importRecipe(p),

    "migration.create": p => service.createMigration(p),
    "migration.plan": p => service.plan(p.migrationId),
    "migration.dryRun": p => service.dryRun(p.migrationId),
    "migration.approve": p => service.approve(p.migrationId, { expiresMinutes: p.expiresMinutes }),
    "migration.execute": async p => {
      const record = service.getMigration(p.migrationId);
      const approval = record.approval ?? null;
      return await service.execute(p.migrationId, { approval });
    },
    "migration.status": p => service.status(p.migrationId),
    "migration.recoveryDecision": p => service.recoveryDecision(p.migrationId),
    "migration.history": p => service.history(p),
    "migration.events": p => service.store.listActivity({ migrationId: p.migrationId, limit: p.limit ?? 100 }),
    "migration.transitions": p => service.transitions(p.migrationId),
    "migration.verification": p => service.verification(p.migrationId),
    "migration.receipt": p => service.receipt(p.migrationId),

    "evidence.export": p => evidence.exportBundle(p),
    "evidence.verify": p => evidence.verifyBundle(p),

    "diagnostics.get": () => diagnostics.get(),
    "diagnostics.export": p => diagnostics.exportBundle(p),

    "settings.get": () => settings.get(),
    "settings.update": p => settings.update(p),

    "updates.check": () => system.updatesUnavailable("check"),
    "updates.verify": () => system.updatesUnavailable("verify"),
    "updates.stage": () => system.updatesUnavailable("stage"),

    "dialog.chooseDirectory": p => dialogs.chooseDirectory(p),
    "dialog.chooseSourceCsv": () => dialogs.chooseSourceCsv(),
    "dialog.chooseSqliteDatabase": () => dialogs.chooseSqliteDatabase(),

    "settings.completeOnboarding": p => settings.completeOnboarding(p),
    "security.keyHealth": () => system.keyHealth()
  });

  return async function handle(op, payload) {
    const handler = table[op];
    if (!handler) {
      return { ok: false, error: { code: "CONSOLE_VALIDATION_FAILED", message: `Unknown operation ${op}` } };
    }
    try {
      const data = validateRequest(op, payload);
      const result = await handler(data);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: toEnvelope(error) };
    }
  };
}
