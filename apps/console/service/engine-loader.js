// Loads the authoritative SPOOL engine as a module graph from an explicit root.
// Production resolves the root to the packaged engine bundle; tests resolve it
// to the repository `src/` tree. The Console never re-implements engine logic.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const cache = new Map();

export async function loadEngine(root) {
  if (typeof root !== 'string' || !root) throw new TypeError('loadEngine requires an engine root path');
  if (cache.has(root)) return cache.get(root);
  const load = relative => import(pathToFileURL(join(root, relative)).href);

  const [
    commandService, pathPolicy, streamCsv, schema, transforms, plan, approval,
    preflight, policy, canonical, redact, errors, checkpoint, receipt
  ] = await Promise.all([
    load('daemon/command-service.js'),
    load('platform/path-policy.js'),
    load('connectors/filesystem/stream-csv.js'),
    load('core/schema.js'),
    load('core/transforms.js'),
    load('platform/plan.js'),
    load('platform/approval.js'),
    load('connectors/sqlite/preflight.js'),
    load('platform/production-policy.js'),
    load('platform/canonical-json.js'),
    load('platform/redact.js'),
    load('core/errors.js'),
    load('execution/checkpoint.js'),
    load('execution/receipt.js')
  ]);

  const engine = Object.freeze({
    root,
    SpoolCommandService: commandService.SpoolCommandService,
    migrationRequestSemanticId: commandService.migrationRequestSemanticId,
    createPathPolicy: pathPolicy.createPathPolicy,
    inspectCsvStream: streamCsv.inspectCsvStream,
    streamCsvRows: streamCsv.streamCsvRows,
    inferSchema: schema.inferSchema,
    validateTargetSchema: schema.validateTargetSchema,
    validateOutputRow: schema.validateOutputRow,
    compileMapping: transforms.compileMapping,
    validateExpr: transforms.validateExpr,
    createMigrationPlan: plan.createMigrationPlan,
    validateMigrationPlan: plan.validateMigrationPlan,
    validateMigrationPlanInput: plan.validateMigrationPlanInput,
    inspectSqliteTarget: preflight.inspectSqliteTarget,
    sqliteTargetContractId: preflight.sqliteTargetContractId,
    PRODUCTION_POLICY: policy.PRODUCTION_POLICY,
    verifyProductionPolicy: policy.verifyProductionPolicy,
    canonicalJson: canonical.canonicalJson,
    sha256Canonical: canonical.sha256Canonical,
    redact: redact.redact,
    toErrorEnvelope: errors.toErrorEnvelope,
    SpoolError: errors.SpoolError,
    fail: errors.fail,
    ERROR_CATALOG: errors.ERROR_CATALOG,
    assertCheckpointBinding: checkpoint.assertCheckpointBinding,
    verifyReceipt: receipt.verifyReceipt ?? null
  });
  cache.set(root, engine);
  return engine;
}
