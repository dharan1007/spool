// Versioned, runtime-validated IPC contract. Every privileged operation is
// declared here once; the Electron main process and the console service both
// validate against this single definition, so a compromised renderer cannot
// reach an undeclared capability and cannot smuggle extra fields.
import { z } from 'zod';
import { consoleFail } from './errors.js';

export const CONTRACT_VERSION = 1;

const id = z.string().min(1).max(160);
const path = z.string().min(1).max(32_768);
const nullableText = z.string().max(4096).nullable();

const targetField = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Field names must be SQL identifiers'),
  type: z.enum(['string', 'integer', 'number', 'boolean', 'date', 'local_datetime']),
  nullable: z.boolean()
}).strict();

const expr = z.any().refine(value => value !== undefined, 'Transform expression is required');

const mappingEntry = z.object({
  target: z.string().min(1).max(128),
  expr
}).strict();

const sourceProfile = z.object({
  path,
  name: z.string().min(1).max(512),
  sizeBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  sourceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  columns: z.array(z.object({
    name: z.string().min(1).max(256),
    inferredType: z.string().max(32),
    nullable: z.boolean()
  }).strict()).min(1)
}).strict();

const destination = z.object({
  path,
  table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  targetContractId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  targetSchema: z.array(targetField).min(1)
}).strict();

const settingsPatch = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  reducedMotion: z.boolean().optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  batchSize: z.number().int().min(1).max(10_000).optional(),
  approvalMinutes: z.number().int().min(1).max(720).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  diagnosticsRetentionDays: z.number().int().min(1).max(365).optional(),
  supportConsent: z.boolean().optional()
}).strict();

export const OPERATIONS = Object.freeze({
  'system.getInfo': z.object({}).strict(),
  'system.verifyRelease': z.object({}).strict(),
  'system.getCapabilities': z.object({}).strict(),
  'system.getEnvironmentStatus': z.object({}).strict(),

  'workspace.create': z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    directory: path.optional()
  }).strict(),
  'workspace.list': z.object({ query: z.string().max(200).optional(), includeArchived: z.boolean().optional() }).strict(),
  'workspace.get': z.object({ workspaceId: id }).strict(),
  'workspace.update': z.object({
    workspaceId: id,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional()
  }).strict(),
  'workspace.archive': z.object({ workspaceId: id, archived: z.boolean() }).strict(),
  'workspace.impact': z.object({ workspaceId: id }).strict(),

  'source.choose': z.object({}).strict(),
  'source.inspect': z.object({ workspaceId: id.optional(), path }).strict(),
  'source.preview': z.object({ path, offset: z.number().int().min(0).max(10_000_000).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),

  'destination.choose': z.object({}).strict(),
  'destination.listTables': z.object({ path }).strict(),
  'destination.inspect': z.object({ path, table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  'destination.preflight': z.object({ path, table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), targetSchema: z.array(targetField).min(1) }).strict(),

  'mapping.validate': z.object({
    mapping: z.array(mappingEntry).min(1),
    targetSchema: z.array(targetField).min(1),
    sourceHeaders: z.array(z.string().max(256)).optional()
  }).strict(),
  'mapping.saveDraft': z.object({
    draftId: id.optional(),
    workspaceId: id,
    name: z.string().min(1).max(200),
    state: z.record(z.string(), z.unknown())
  }).strict(),
  'mapping.getDraft': z.object({ draftId: id }).strict(),
  'mapping.listDrafts': z.object({ workspaceId: id.optional() }).strict(),
  'mapping.deleteDraft': z.object({ draftId: id }).strict(),
  'mapping.listRecipes': z.object({ query: z.string().max(200).optional() }).strict(),
  'mapping.saveRecipe': z.object({
    recipeId: id.optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    targetSchema: z.array(targetField).min(1),
    mapping: z.array(mappingEntry).min(1)
  }).strict(),
  'mapping.exportRecipe': z.object({ recipeId: id }).strict(),
  'mapping.importRecipe': z.object({ text: z.string().min(2).max(1_000_000) }).strict(),

  'migration.create': z.object({
    workspaceId: id,
    name: z.string().min(1).max(200),
    sourceProfile,
    destination,
    mapping: z.array(mappingEntry).min(1),
    mappingRevision: z.number().int().min(1).max(1_000_000),
    planRevision: z.number().int().min(1).max(1_000_000),
    batchSize: z.number().int().min(1).max(10_000)
  }).strict(),
  'migration.plan': z.object({ migrationId: id }).strict(),
  'migration.dryRun': z.object({ migrationId: id }).strict(),
  'migration.approve': z.object({ migrationId: id, expiresMinutes: z.number().int().min(1).max(720).optional() }).strict(),
  'migration.execute': z.object({ migrationId: id }).strict(),
  'migration.status': z.object({ migrationId: id }).strict(),
  'migration.recoveryDecision': z.object({ migrationId: id }).strict(),
  'migration.history': z.object({
    workspaceId: id.optional(),
    status: z.string().max(64).optional(),
    query: z.string().max(200).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional()
  }).strict(),
  'migration.events': z.object({ migrationId: id, limit: z.number().int().min(1).max(500).optional() }).strict(),
  'migration.transitions': z.object({ migrationId: id }).strict(),
  'migration.verification': z.object({ migrationId: id }).strict(),
  'migration.receipt': z.object({ migrationId: id }).strict(),

  'evidence.export': z.object({ migrationId: id, directory: path.optional() }).strict(),
  'evidence.verify': z.object({ path }).strict(),

  'diagnostics.get': z.object({}).strict(),
  'diagnostics.export': z.object({ directory: path.optional() }).strict(),

  'settings.get': z.object({}).strict(),
  'settings.update': settingsPatch,

  'updates.check': z.object({}).strict(),
  'updates.verify': z.object({}).strict(),
  'updates.stage': z.object({}).strict(),

  // Internal-only operations routed to the OS dialog layer in the main process.
  'dialog.chooseDirectory': z.object({ title: z.string().max(200).optional() }).strict(),
  'dialog.chooseSourceCsv': z.object({ title: z.string().max(200).optional() }).strict(),
  'dialog.chooseSqliteDatabase': z.object({ title: z.string().max(200).optional() }).strict(),

  // Lifecycle operations used by first-launch onboarding.
  'settings.completeOnboarding': z.object({ workspaceRoot: path.optional() }).strict(),
  'security.keyHealth': z.object({}).strict()
});

export const OPERATION_NAMES = Object.freeze(Object.keys(OPERATIONS));

export function validateRequest(op, payload) {
  const schema = OPERATIONS[op];
  if (!schema) {
    consoleFail('CONSOLE_VALIDATION_FAILED', `Unknown operation ${String(op).slice(0, 64)}`, { operation: String(op).slice(0, 64) });
  }
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    const issues = result.error.issues.slice(0, 8).map(issue => ({
      path: issue.path.join('.'),
      message: issue.message
    }));
    consoleFail('CONSOLE_VALIDATION_FAILED', 'Request does not match the operation contract', { operation: op, issues });
  }
  return result.data;
}

export { nullableText };
