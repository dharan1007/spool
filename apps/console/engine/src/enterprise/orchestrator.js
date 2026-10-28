// Enterprise migration orchestrator for SPOOL API v2.
//
// Drives the REAL engine lifecycle (SpoolCommandService) per migration, with
// per-workspace path containment. The orchestrator adds no second parser,
// planner or executor: source discovery reuses the engine's streaming CSV
// parser and schema inference, plan construction uses the engine's own plan
// identity algorithm, and every mutating step runs through the command
// service. The Console orchestrator (apps/console) follows the same contract
// for its local single-user surfaces.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import { fail } from '../core/errors.js';
import { PRODUCTION_POLICY } from '../platform/production-policy.js';
import Database from 'better-sqlite3';
import { SpoolCommandService } from '../daemon/command-service.js';
import { createPathPolicy } from '../platform/path-policy.js';
import { inspectCsvStream } from '../connectors/filesystem/stream-csv.js';
import { inferSchema } from '../core/schema.js';
import { inspectSqliteTarget } from '../connectors/sqlite/preflight.js';
import { compileMapping } from '../core/transforms.js';

const OPERATOR_VERSION = 'spool-operators-v1';
const SAMPLE_ROWS = 500;
const CAST_FOR_TYPE = {
  integer: 'cast_number',
  number: 'cast_number',
  boolean: 'cast_boolean',
  date: 'parse_date',
  local_datetime: 'parse_local_datetime',
  string: 'trim'
};
async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export function transformFor(targetType, expr) {
  const op = CAST_FOR_TYPE[targetType];
  if (!op) fail('ENTERPRISE_VALIDATION_FAILED', `Unsupported target type ${targetType}`);
  if (op === 'trim' && expr.op === 'trim') return expr;
  return { op, value: expr };
}

// Structural mapping validation using ONLY engine operators.
export function validateMapping({ mapping, targetSchema, sourceHeaders = [] }) {
  try {
    compileMapping(mapping);
  } catch (error) {
    return { valid: false, problems: [{ code: error?.code ?? 'INVALID_MAPPING', message: String(error?.message ?? error) }] };
  }
  const targets = mapping.map(entry => entry.target);
  const targetNames = new Set(targetSchema.map(field => field.name));
  const problems = [];
  const duplicateTargets = targets.filter((name, index) => targets.indexOf(name) !== index);
  const unknownTargets = targets.filter(name => !targetNames.has(name));
  // Only required (non-nullable) targets must be mapped; nullable columns may
  // legitimately be left unmapped (the engine writes SQL NULL there).
  const unmappedTargets = targetSchema
    .filter(field => !targets.includes(field.name) && field.nullable === false)
    .map(field => field.name);
  if (duplicateTargets.length) problems.push({ code: 'DUPLICATE_TARGET', message: 'A target column is mapped more than once', fields: [...new Set(duplicateTargets)] });
  if (unknownTargets.length) problems.push({ code: 'UNKNOWN_TARGET', message: 'The mapping references target columns absent from the target schema', fields: unknownTargets });
  if (unmappedTargets.length) problems.push({ code: 'UNMAPPED_TARGET', message: 'Some target columns have no mapping', fields: unmappedTargets });
  return { valid: problems.length === 0, problems };
}

export function createEnterpriseOrchestrator({ registry, approvalSigningKey, release, maxSourceBytes = 256 * 1024 * 1024 } = {}) {
  if (!registry || typeof registry.getWorkspace !== 'function') {
    fail('ENTERPRISE_CONFIG_INVALID', 'An enterprise registry is required');
  }
  if (typeof approvalSigningKey !== 'string' || approvalSigningKey.length < 32) {
    fail('ENTERPRISE_CONFIG_INVALID', 'approvalSigningKey must be at least 32 bytes');
  }
  if (!release || typeof release.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(release.commitSha)) {
    fail('ENTERPRISE_CONFIG_INVALID', 'Release must carry an exact 40-character commit SHA');
  }
  // Production engine mode binds the release identity to the shipped policy pin.
  const engineRelease = Object.freeze({
    version: release.version ?? PRODUCTION_POLICY.release,
    commitSha: release.commitSha
  });
  if (engineRelease.version !== PRODUCTION_POLICY.release) {
    fail('ENTERPRISE_CONFIG_INVALID', `Release version must match the shipped production policy release ${PRODUCTION_POLICY.release}`);
  }

  const services = new Map(); // migrationId -> SpoolCommandService
  const running = new Set();

  function isRootPrincipal(principalId) {
    return principalId === 'spool:root';
  }

  function requestFor(record, principalId) {
    return {
      migrationId: record.migrationId,
      principal: principalId,
      planInput: structuredClone(record.planInput)
    };
  }

  // Source inspection reuses the engine parser; path is contained to the
  // workspace directory by the engine path policy.
  async function inspectSource({ workspaceId, path, principalId }) {
    const workspace = registry.getWorkspace(workspaceId);
    if (!isRootPrincipal(principalId)) ensureMembership(registry, workspaceId, principalId);
    const policy = await createPathPolicy(workspace.directory);
    const resolved = await policy.resolve(path, { mustExist: true });
    const info = await stat(resolved);
    if (!info.isFile()) fail('ENTERPRISE_VALIDATION_FAILED', 'Source must be a regular file', { path: null });
    if (info.size > maxSourceBytes) fail('SOURCE_TOO_LARGE', `Source exceeds the ${maxSourceBytes} byte ceiling`);
    if (info.size === 0) fail('ENTERPRISE_VALIDATION_FAILED', 'Source file is empty');
    const inspected = await inspectCsvStream(resolved, { sampleSize: SAMPLE_ROWS, maxInputBytes: maxSourceBytes });
    if (inspected.rowCount === 0) fail('ENTERPRISE_VALIDATION_FAILED', 'CSV source contains no data rows');
    const fields = inferSchema(inspected.sampleRows, { sampleSize: Math.min(SAMPLE_ROWS, inspected.sampleRows.length) });
    const sourceFingerprint = await sha256File(resolved);
    return Object.freeze({
      path: resolved,
      name: resolved.split(/[\\/]/).pop(),
      sizeBytes: info.size,
      rowCount: inspected.rowCount,
      rowCountBasis: 'exact',
      headers: [...inspected.headers],
      columns: fields,
      sampleRows: inspected.sampleRows.length,
      sourceFingerprint,
      maxSourceBytes
    });
  }

  // Destination inspection verifies the claimed target contract against the
  // real SQLite database, then validates the AUTHORED contract through the
  // engine's authoritative preflight.
  async function inspectDestination({ workspaceId, path, table, principalId, claimedTargetSchema = null }) {
    const workspace = registry.getWorkspace(workspaceId);
    if (!isRootPrincipal(principalId)) ensureMembership(registry, workspaceId, principalId);
    const policy = await createPathPolicy(workspace.directory);
    const resolved = await policy.resolve(path, { mustExist: true });
    const derivedTargetSchema = await sqliteTargetSchema(resolved, table);
    if (claimedTargetSchema) {
      const provided = new Map(claimedTargetSchema.map(f => [f.name, f]));
      const mismatches = [];
      const actual = new Map(derivedTargetSchema.map(f => [f.name, f]));
      for (const [name, field] of actual) {
        const claimed = provided.get(name);
        if (!claimed) continue; // unmapped optional fields are not a drift
        if (String(claimed.type).toLowerCase() !== String(field.type).toLowerCase() || !!claimed.nullable !== !!field.nullable) {
          mismatches.push({ column: name, problem: 'TYPE_NULLABILITY_DRIFT' });
        }
      }
      for (const name of provided.keys()) {
        if (!actual.has(name)) mismatches.push({ column: name, problem: 'ABSENT_IN_TARGET' });
      }
      if (mismatches.length) {
        fail('TARGET_CONTRACT_DRIFT', 'Declared target schema does not match the real destination database', { mismatches });
      }
    }
    // Authoritative engine contract validation.
    const contract = inspectSqliteTarget({ path: resolved, table, targetSchema: claimedTargetSchema ?? derivedTargetSchema });
    return Object.freeze({
      path: resolved,
      table,
      targetContractId: contract.targetContractId,
      targetSchema: derivedTargetSchema
    });
  }

  function suggestTargetType(column) {
    const declared = String(column ?? '').trim().toUpperCase();
    let affinityName;
    if (declared.includes('INT')) affinityName = 'INTEGER';
    else if (declared.includes('CHAR') || declared.includes('CLOB') || declared.includes('TEXT')) affinityName = 'TEXT';
    else if (!declared || declared.includes('BLOB')) affinityName = 'BLOB';
    else if (declared.includes('REAL') || declared.includes('FLOA') || declared.includes('DOUB')) affinityName = 'REAL';
    else affinityName = 'NUMERIC';
    if (affinityName === 'BLOB') return null;
    if (/BOOL/.test(declared)) return 'boolean';
    if (affinityName === 'TEXT' && /DATE|TIME/.test(declared)) return /TIME/.test(declared) ? 'local_datetime' : 'date';
    if (affinityName === 'INTEGER') return 'integer';
    if (affinityName === 'REAL' || affinityName === 'NUMERIC') return 'number';
    return 'string';
  }

  const INTERNAL_TABLES = new Set(['__spool_batch_ledger', 'spool_execution_leases']);

  function sqliteTargetSchema(path, table) {
    let db;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
      if (INTERNAL_TABLES.has(table) || table.startsWith('sqlite_')) {
        fail('TABLE_NOT_AVAILABLE', 'SPOOL internal tables cannot be migration targets', { table });
      }
      const row = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ? AND type = 'table'").get(table);
      if (!row) fail('TABLE_NOT_AVAILABLE', 'Table does not exist as an ordinary table', {});
      if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? '')) {
        fail('TABLE_NOT_AVAILABLE', 'Virtual SQLite tables are not supported', {});
      }
      const columns = db.prepare('SELECT cid, name, type, "notnull" AS is_not_null, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table)
        .map(column => ({
          name: column.name,
          declaredType: column.type ?? '',
          notNull: Number(column.is_not_null) === 1,
          primaryKeyOrder: Number(column.pk),
          hidden: Number(column.hidden),
          suggestedType: suggestTargetType(column.type)
        }));
      const targetSchema = columns
        .filter(column => Number(column.hidden) === 0 && column.suggestedType !== null)
        .map(column => ({
          name: column.name,
          type: column.suggestedType,
          nullable: !column.notNull && Number(column.primaryKeyOrder) === 0
        }));
      return targetSchema;
    } catch (error) {
      if (error?.code) throw error;
      fail('TARGET_PREFLIGHT_FAILED', `SQLite target preflight failed: ${error?.message ?? String(error)}`, {});
    } finally {
      if (db) db.close();
    }
  }

  function validateMappingOrThrow({ mapping, targetSchema, sourceHeaders }) {
    const validation = validateMapping({ mapping, targetSchema, sourceHeaders });
    if (!validation.valid) {
      fail('MAPPING_INCOMPLETE', 'Mapping does not cover the target schema', { problems: validation.problems });
    }
  }

  async function createMigration({ workspaceId, name, principalId, sourcePath, destination, mapping, mappingRevision = 1, planRevision = 1, batchSize = 1000 }) {
    if (!isRootPrincipal(principalId)) ensureMembership(registry, workspaceId, principalId);
    const workspace = registry.getWorkspace(workspaceId);
    if (workspace.archivedAt) fail('WORKSPACE_ARCHIVED', 'Restore the workspace before starting new work');
    if (typeof name !== 'string' || !name.trim()) fail('ENTERPRISE_VALIDATION_FAILED', 'A migration name is required');
    if (!destination || typeof destination.path !== 'string' || typeof destination.table !== 'string') {
      fail('ENTERPRISE_VALIDATION_FAILED', 'A destination with path and table is required');
    }
    const policy = await createPathPolicy(workspace.directory);
    const resolvedSource = await policy.resolve(sourcePath, { mustExist: true });
    const profile = await inspectSource({ workspaceId, path: resolvedSource, principalId });
    const targetSchema = Array.isArray(destination.targetSchema) ? destination.targetSchema : null;
    if (!targetSchema || !targetSchema.length) fail('ENTERPRISE_VALIDATION_FAILED', 'destination.targetSchema is required');
    validateMappingOrThrow({ mapping, targetSchema, sourceHeaders: profile.headers });
    const dest = await inspectDestination({
      workspaceId, path: destination.path, table: destination.table, principalId, claimedTargetSchema: targetSchema
    });
    const migrationId = `mig_${randomUUID()}`;
    const migrationDir = join(workspace.directory, 'migrations', migrationId);
    await mkdir(join(migrationDir, 'snapshots'), { recursive: true });
    await writeFile(join(migrationDir, 'source-profile.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
    const planInput = {
      planRevision,
      sourceRef: {
        connector: 'filesystem',
        connectionId: `enterprise-source:${profile.sourceFingerprint.slice(7, 19)}`,
        resource: profile.name,
        path: profile.path
      },
      targetRef: {
        connector: 'sqlite',
        connectionId: `enterprise-target:${dest.targetContractId.slice(7, 19)}`,
        resource: destination.table,
        path: dest.path,
        table: destination.table
      },
      targetSchema,
      mapping,
      mappingRevision,
      writeStrategy: { mode: 'insert', batchSize },
      verification: { checks: ['row_accounting', 'ledger_complete'] },
      risk: { level: 'medium', approvals: ['target_write'] },
      capabilityAssumptions: {
        source: { snapshotBinding: true },
        target: {
          transactions: true,
          atomicBatchLedger: true,
          reconcileAfterCrash: true,
          idempotentReplay: true,
          fencing: true
        }
      }
    };
    const record = registry.createMigrationRecord({
      migrationId, workspaceId, name: name.trim(),
      sourcePath: profile.path, sourceRoot: dirname(profile.path),
      targetPath: dest.path, targetRoot: dirname(dest.path),
      tableName: destination.table, migrationDir,
      planInput, targetSchema, mapping,
      mappingRevision, planRevision
    });
    registry.updateMigrationStatus(record.migrationId, { status: 'CREATED', state: 'CREATED' });
    registry.recordActivity({
      category: 'migration', actor: principalId, workspaceId, migrationId,
      code: 'MIGRATION_CREATED', detail: { name: name.trim(), batchSize }, severity: 'info'
    });
    return Object.freeze({
      migrationId: record.migrationId,
      workspaceId: record.workspaceId,
      name: record.name,
      sourceProfile: profile,
      targetContractId: dest.targetContractId,
      status: 'CREATED'
    });
  }

  async function getRecord(migrationId, principalId, allowedRoles = null) {
    if (typeof migrationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(migrationId)) {
      fail('ENTERPRISE_VALIDATION_FAILED', 'Invalid migrationId');
    }
    const record = registry.getMigrationRecord(migrationId);
    // Fail closed without leaking existence across workspaces: an unknown
    // migration and an unauthorized workspace reference collapse to the same
    // MIGRATION_NOT_FOUND response.
    if (!record) fail('MIGRATION_NOT_FOUND', 'Migration does not exist in an authorized workspace');
    if (!isRootPrincipal(principalId)) {
      const membership = registry.membership(record.workspaceId, principalId);
      if (!membership) fail('MIGRATION_NOT_FOUND', 'Migration does not exist in an authorized workspace');
      if (allowedRoles && !allowedRoles.includes(membership.role)) {
        fail('FORBIDDEN', 'Caller role may not perform this action');
      }
    }
    return record;
  }

  async function assertSourceUnchanged(record) {
    let profile;
    try {
      profile = JSON.parse(await readFile(join(record.migrationDir, 'source-profile.json'), 'utf8'));
    } catch {
      fail('SOURCE_PROFILE_NOT_FOUND', 'Source profile is missing; re-create the migration with an inspected source', { migrationId: record.migrationId });
    }
    let currentFingerprint;
    try {
      currentFingerprint = await sha256File(profile.path);
    } catch {
      fail('SOURCE_MODIFIED', 'The source file is no longer readable', { migrationId: record.migrationId });
    }
    if (currentFingerprint !== profile.sourceFingerprint) {
      fail('SOURCE_MODIFIED', 'The source file changed after inspection; re-create the migration', { migrationId: record.migrationId });
    }
  }

  async function getOrCreateService(record) {
    const existing = services.get(record.migrationId);
    if (existing) return existing;
    await mkdir(record.migrationDir, { recursive: true });
    const service = await SpoolCommandService.create({
      sourceRoot: record.sourceRoot,
      targetRoot: record.targetRoot,
      statePath: join(record.migrationDir, 'state.db'),
      snapshotDir: join(record.migrationDir, 'snapshots'),
      approvalSigningKey,
      maxSourceBytes,
      release: engineRelease
    });
    services.set(record.migrationId, service);
    return service;
  }

  function setLocalState(migrationId, status, state) {
    registry.updateMigrationStatus(migrationId, { status, state });
  }

  async function plan({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator']);
    await assertSourceUnchanged(record);
    const service = await getOrCreateService(record);
    const plan = await service.plan(requestFor(record, principalId));
    registry.updateMigrationPlan(record.migrationId, { plan });
    registry.recordActivity({
      category: 'migration', actor: principalId, workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: 'PLAN_CREATED', detail: { planId: plan.planId, planRevision: plan.planRevision }, severity: 'info'
    });
    setLocalState(record.migrationId, 'PLANNED', 'PLANNED');
    return Object.freeze(plan);
  }

  async function dryRun({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator']);
    if (!record.plan) fail('MIGRATION_STEP_OUT_OF_ORDER', 'Generate the plan before the dry-run');
    await assertSourceUnchanged(record);
    const service = await getOrCreateService(record);
    const result = await service.dryRun(requestFor(record, principalId));
    if (result.planId !== record.plan.planId) {
      fail('MIGRATION_STEP_OUT_OF_ORDER', 'Dry-run used a different plan; regenerate the plan and retry');
    }
    registry.updateMigrationPlan(record.migrationId, { dryRun: result });
    registry.recordActivity({
      category: 'migration', actor: principalId, workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: 'DRY_RUN_COMPLETE', detail: { validRows: result.validRows, invalidRows: result.invalidRows }, severity: 'info'
    });
    setLocalState(record.migrationId, 'DRY_RUN', 'DRY_RUN');
    return Object.freeze(result);
  }

  async function approve({ migrationId, principalId, role, expiresMinutes = 60 }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator']);
    if (!record.plan || !record.dryRun) {
      fail('MIGRATION_STEP_OUT_OF_ORDER', 'Plan and dry-run must be recorded before approval');
    }
    await assertSourceUnchanged(record);
    const service = await getOrCreateService(record);
    const request = requestFor(record, principalId);
    const currentPlan = await service.plan(request);
    if (currentPlan.planId !== record.plan.planId) {
      registry.updateMigrationPlan(record.migrationId, { plan: currentPlan });
      fail('MIGRATION_STEP_OUT_OF_ORDER', 'Source or design changed since the recorded plan; review the new plan and dry-run again');
    }
    if (role != null && !['admin', 'operator'].includes(role)) {
      fail('FORBIDDEN', 'Caller role may not approve migrations');
    }
    const expiresAt = new Date(Date.now() + expiresMinutes * 60_000).toISOString();
    const nonce = randomUUID();
    const approval = await service.approve(request, { expiresAt, nonce });
    registry.updateMigrationPlan(record.migrationId, { approval });
    registry.recordActivity({
      category: 'approval', actor: principalId, workspaceId: record.workspaceId, migrationId: record.migrationId,
      code: 'MIGRATION_APPROVED', detail: { approvalId: approval.approvalId ?? approval.record?.approvalId ?? null, expiresAt }, severity: 'info'
    });
    setLocalState(record.migrationId, 'APPROVED', 'APPROVED');
    return Object.freeze(approval);
  }

  async function execute({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator']);
    if (running.has(record.migrationId)) fail('MIGRATION_ALREADY_RUNNING', 'A run is already active for this migration');
    if (!record.approval) fail('MIGRATION_STEP_OUT_OF_ORDER', 'Approval must be recorded before execution', { migrationId: record.migrationId });
    if (record.lastStatus === 'RUNNING') fail('MIGRATION_ALREADY_RUNNING', 'A run is already active for this migration');
    await assertSourceUnchanged(record);
    const service = await getOrCreateService(record);
    const approval = structuredClone(record.approval);
    running.add(record.migrationId);
    setLocalState(record.migrationId, 'RUNNING', 'RUNNING');
    try {
      const result = await service.run(requestFor(record, principalId), { approval });
      const complete = result.status === 'COMPLETE';
      setLocalState(record.migrationId, complete ? 'COMPLETE' : String(result.status), complete ? 'COMPLETE' : String(result.status));
      registry.recordActivity({
        category: 'execution', actor: principalId, workspaceId: record.workspaceId, migrationId: record.migrationId,
        code: complete ? 'MIGRATION_COMPLETE' : 'MIGRATION_RUN_RESULT',
        detail: { status: result.status }, severity: complete ? 'info' : 'warning'
      });
      return Object.freeze(result);
    } catch (error) {
      let durable = null;
      try { durable = service.migrationState(record.migrationId)?.currentState ?? null; } catch {}
      setLocalState(record.migrationId, durable ?? 'FAILED', durable ?? 'FAILED');
      registry.recordActivity({
        category: 'execution', actor: principalId, workspaceId: record.workspaceId, migrationId: record.migrationId,
        code: 'MIGRATION_RUN_FAILED', detail: { code: error?.code ?? null, durableState: durable }, severity: 'error'
      });
      throw error;
    } finally {
      running.delete(record.migrationId);
    }
  }

  async function status({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId);
    let runStatus = null;
    const service = services.get(record.migrationId);
    try { runStatus = service?.status(record.migrationId) ?? null; } catch { runStatus = { error: 'STATUS_UNAVAILABLE' }; }
    return Object.freeze({
      migrationId: record.migrationId,
      workspaceId: record.workspaceId,
      name: record.name,
      status: record.lastStatus,
      state: record.lastState,
      runStatus,
      hasPlan: Boolean(record.plan),
      hasApproval: Boolean(record.approval)
    });
  }

  async function verification({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator', 'viewer']);
    const service = services.get(record.migrationId);
    if (!service) return null;
    try { return Object.freeze(service.verification(record.migrationId)); }
    catch (error) { return Object.freeze({ error: error?.code ?? 'VERIFICATION_NOT_AVAILABLE' }); }
  }

  async function receipt({ migrationId, principalId }) {
    const record = await getRecord(migrationId, principalId, ['admin', 'operator', 'viewer']);
    const service = services.get(record.migrationId);
    if (!service) return null;
    try { return Object.freeze(service.receipt(record.migrationId)); }
    catch (error) { return Object.freeze({ error: error?.code ?? 'RECEIPT_NOT_AVAILABLE' }); }
  }

  async function history({ principalId, workspaceId = null, limit = 50, offset = 0 }) {
    if (isRootPrincipal(principalId)) {
      return registry.listMigrations({ workspaceIds: workspaceId ? [workspaceId] : null, limit, offset });
    }
    const memberships = registry.listWorkspacesForPrincipal(principalId);
    let ids = memberships.map(entry => entry.workspaceId);
    if (workspaceId) {
      if (!ids.includes(workspaceId)) fail('WORKSPACE_NOT_FOUND', 'Workspace does not exist or is not authorized for this principal');
      ids = [workspaceId];
    }
    return registry.listMigrations({ workspaceIds: ids, limit, offset });
  }

  async function workspaceActivity({ principalId, workspaceId, limit = 100, offset = 0 }) {
    if (!isRootPrincipal(principalId)) ensureMembership(registry, workspaceId, principalId);
    registry.getWorkspace(workspaceId);
    return registry.listActivity({ workspaceIds: [workspaceId], limit, offset });
  }

  async function closeAll() {
    for (const service of services.values()) { try { service.close(); } catch {} }
    services.clear();
    running.clear();
  }

  return Object.freeze({
    inspectSource, inspectDestination, createMigration, plan, dryRun, approve,
    execute, status, verification, receipt, history, workspaceActivity, closeAll,
    validateMapping
  });
}

export { OPERATOR_VERSION };

function ensureMembership(registry, workspaceId, principalId) {
  const membership = registry.membership(workspaceId, principalId);
  if (!membership) fail('WORKSPACE_NOT_FOUND', 'Workspace does not exist or is not authorized for this principal');
  return membership;
}
