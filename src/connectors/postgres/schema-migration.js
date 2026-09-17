import { randomUUID } from 'node:crypto';
import { fail } from '../../core/errors.js';
import { validateTargetSchema } from '../../core/schema.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';
import { postgresTargetContractId, postgresTargetContractRecord } from './preflight.js';
import { acquirePostgresLease } from './target.js';

const PLAN_DOMAIN = 'spool-postgres-schema-migration-v1';
const MIGRATION_TABLE = 'schema_migrations';
const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFECT_DESTRUCTIVE = 'postgres:schema-migrate-destructive';

const CANONICAL_PG_TYPE = Object.freeze({
  string: 'text',
  integer: 'bigint',
  number: 'double precision',
  boolean: 'boolean',
  date: 'date',
  local_datetime: 'timestamp without time zone'
});

const ACCEPTED_PG_TYPES = Object.freeze({
  string: new Set(['text', 'varchar', 'bpchar']),
  integer: new Set(['int2', 'int4', 'int8']),
  number: new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']),
  boolean: new Set(['bool']),
  date: new Set(['date']),
  local_datetime: new Set(['timestamp'])
});

const TOTAL_CAST_TO_TEXT = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'timestamp']);

const STEP_ORDER = Object.freeze({
  PK_DROP: 0,
  DROP_COLUMN: 1,
  ALTER_COLUMN_TYPE: 2,
  ADD_COLUMN: 3,
  SET_NOT_NULL: 4,
  DROP_NOT_NULL: 5,
  PK_ADD: 6
});

function requireMigrationId(value) {
  if (typeof value !== 'string' || !MIGRATION_ID.test(value)) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'migrationId is invalid');
  return value;
}

function requireHash(name, value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_SCHEMA_MIGRATION_INPUT', `${name} must be a canonical sha256 identity`);
  return value;
}

function requireDatabaseRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'PostgreSQL target ref is required');
  const endpoint = parsePostgresEndpoint(ref.endpoint);
  if (typeof ref.database !== 'string' || !ref.database) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ref.database is required');
  if (typeof ref.schema !== 'string' || !IDENTIFIER.test(ref.schema)) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ref.schema must be a safe SQL identifier');
  if (typeof ref.table !== 'string' || !IDENTIFIER.test(ref.table)) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ref.table must be a safe SQL identifier');
  if (typeof ref.identity?.user !== 'string' || !ref.identity.user) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ref.identity.user is required');
  const secretRef = validateSecretRef(ref.secretRef);
  return Object.freeze({ endpoint: endpoint.endpoint, database: ref.database, schema: ref.schema, table: ref.table, identity: Object.freeze({ user: ref.identity.user }), secretRef });
}

function requireDesiredSchema(targetSchema) {
  validateTargetSchema(targetSchema);
  return targetSchema.map(field => {
    if (typeof field.nullable !== 'boolean') fail('INVALID_SCHEMA_MIGRATION_INPUT', `Desired field ${field.name} must declare nullable as a boolean`);
    return Object.freeze({ name: field.name, type: field.type, nullable: field.nullable });
  });
}

function requirePrimaryKey(primaryKey, desired) {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'primaryKey must be a non-empty array');
  const names = new Set(desired.map(field => field.name));
  for (const key of primaryKey) {
    if (typeof key !== 'string' || !names.has(key)) fail('INVALID_SCHEMA_MIGRATION_INPUT', `primaryKey field ${key} is not part of the desired schema`);
  }
  if (new Set(primaryKey).size !== primaryKey.length) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'primaryKey contains duplicates');
  return Object.freeze([...primaryKey]);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function livePrimaryKey(record) {
  const columns = record?.columns;
  if (!Array.isArray(columns)) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'liveRecord.columns is required for schema diff');
  const pkIndex = (record.indexes ?? []).find(index => index.primary === true);
  if (!pkIndex) return Object.freeze([]);
  const definition = String(pkIndex.definition ?? '');
  const match = /\(([^)]+)\)/.exec(definition);
  if (!match) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'live primary-key definition is unreadable');
  return Object.freeze(match[1].split(',').map(part => part.trim().replaceAll('"', '')).filter(Boolean));
}

function livePkConstraintName(record) {
  const pk = (record.constraints ?? []).find(constraint => constraint.type === 'p');
  return pk?.name ?? null;
}

function typeChangeSafety(desiredType, live) {
  if ((ACCEPTED_PG_TYPES[desiredType] ?? new Set()).has(live.pgType)) return null;
  const canonical = CANONICAL_PG_TYPE[desiredType];
  if (canonical === 'text' && TOTAL_CAST_TO_TEXT.has(live.pgType)) return 'BLOCKING';
  return 'DESTRUCTIVE';
}

function unmanagedObjects(record) {
  const entries = [];
  for (const index of record.indexes ?? []) {
    if (index.primary === true) continue;
    entries.push({ kind: 'UNMANAGED_INDEX', name: index.name, definition: index.definition ?? null });
  }
  for (const trigger of record.triggers ?? []) {
    entries.push({ kind: 'UNMANAGED_TRIGGER', name: trigger.name, enabled: trigger.enabled ?? null });
  }
  for (const rule of record.rules ?? []) {
    entries.push({ kind: 'UNMANAGED_RULE', name: rule.name });
  }
  for (const constraint of record.constraints ?? []) {
    if (constraint.type === 'p') continue;
    entries.push({ kind: 'UNMANAGED_CONSTRAINT', name: constraint.name, type: constraint.type });
  }
  entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return entries;
}

export function diffPostgresSchema({ desiredSchema, primaryKey, liveRecord } = {}) {
  const desired = requireDesiredSchema(desiredSchema);
  const pk = requirePrimaryKey(primaryKey, desired);
  if (!liveRecord || typeof liveRecord !== 'object' || !Array.isArray(liveRecord.columns)) {
    fail('INVALID_SCHEMA_MIGRATION_INPUT', 'liveRecord must be a PostgreSQL contract record with columns');
  }
  const liveByName = new Map(liveRecord.columns.map(column => [column.name, column]));
  const desiredByName = new Map(desired.map(field => [field.name, field]));
  const entries = [];

  for (const field of desired) {
    const live = liveByName.get(field.name);
    if (!live) {
      entries.push({
        kind: 'ADD_COLUMN', column: field.name, desiredType: field.type, nullable: field.nullable,
        safety: field.nullable ? 'ONLINE' : 'BLOCKING'
      });
      continue;
    }
    if (live.identity || live.generated) {
      entries.push({ kind: 'UNMANAGED_GENERATED_COLUMN', column: field.name, safety: 'BLOCKING' });
      continue;
    }
    const typeSafety = typeChangeSafety(field.type, live);
    if (typeSafety) {
      entries.push({
        kind: 'ALTER_COLUMN_TYPE', column: field.name, fromType: live.formattedType ?? live.pgType,
        toType: CANONICAL_PG_TYPE[field.type], safety: typeSafety
      });
    }
    if (field.nullable === false && live.notNull !== true) {
      entries.push({ kind: 'SET_NOT_NULL', column: field.name, safety: 'BLOCKING' });
    } else if (field.nullable === true && live.notNull === true) {
      entries.push({ kind: 'DROP_NOT_NULL', column: field.name, safety: 'ONLINE' });
    }
  }

  for (const column of liveRecord.columns) {
    if (!desiredByName.has(column.name)) {
      entries.push({ kind: 'DROP_COLUMN', column: column.name, liveType: column.formattedType ?? column.pgType, safety: 'DESTRUCTIVE' });
    }
  }

  const livePk = livePrimaryKey(liveRecord);
  if (JSON.stringify([...livePk].sort()) !== JSON.stringify([...pk].sort())) {
    if (livePk.length > 0) entries.push({ kind: 'PK_DROP', columns: [...livePk], safety: 'BLOCKING' });
    if (pk.length > 0) entries.push({ kind: 'PK_ADD', columns: [...pk], safety: 'BLOCKING' });
  }

  for (const unmanaged of unmanagedObjects(liveRecord)) {
    entries.push({ ...unmanaged, safety: 'BLOCKING' });
  }

  const rank = entry => `${STEP_ORDER[entry.kind] ?? 9}:${entry.column ?? entry.name ?? ''}`;
  entries.sort((left, right) => rank(left).localeCompare(rank(right)));
  return Object.freeze(entries.map(entry => Object.freeze({ ...entry })));
}

function requireDiffEntry(entry, index) {
  if (!entry || typeof entry !== 'object') fail('INVALID_SCHEMA_MIGRATION_INPUT', `diff entry ${index} must be an object`);
  if (typeof entry.kind !== 'string' || !(entry.kind in STEP_ORDER) && !entry.kind.startsWith('UNMANAGED')) {
    fail('INVALID_SCHEMA_MIGRATION_INPUT', `diff entry ${index} has an unsupported kind`);
  }
  if (!['ONLINE', 'BLOCKING', 'DESTRUCTIVE'].includes(entry.safety)) fail('INVALID_SCHEMA_MIGRATION_INPUT', `diff entry ${index} has an invalid safety class`);
  if (entry.kind === 'ADD_COLUMN' && typeof entry.nullable !== 'boolean') fail('INVALID_SCHEMA_MIGRATION_INPUT', `diff entry ${index} ADD_COLUMN requires a boolean nullable flag`);
  return entry;
}

function stepSql(schema, table, entry) {
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const column = quoteIdentifier(entry.column);
  switch (entry.kind) {
    case 'PK_DROP': return null;
    case 'DROP_COLUMN': return `ALTER TABLE ${qualified} DROP COLUMN ${column}`;
    case 'ALTER_COLUMN_TYPE': {
      const target = entry.toType;
      if (typeof target !== 'string' || !target) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ALTER step requires a canonical target type');
      const using = entry.safety === 'DESTRUCTIVE' ? ` USING ${column}::${target}` : '';
      return `ALTER TABLE ${qualified} ALTER COLUMN ${column} TYPE ${target}${using}`;
    }
    case 'ADD_COLUMN': {
      if (typeof entry.toType !== 'string' || !entry.toType) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'ADD step requires a canonical target type');
      const notNull = entry.nullable === false ? ' NOT NULL' : '';
      return `ALTER TABLE ${qualified} ADD COLUMN ${column} ${entry.toType}${notNull}`;
    }
    case 'SET_NOT_NULL': return `ALTER TABLE ${qualified} ALTER COLUMN ${column} SET NOT NULL`;
    case 'DROP_NOT_NULL': return `ALTER TABLE ${qualified} ALTER COLUMN ${column} DROP NOT NULL`;
    case 'PK_ADD': return `ALTER TABLE ${qualified} ADD PRIMARY KEY (${entry.columns.map(quoteIdentifier).join(', ')})`;
    default: fail('SCHEMA_MIGRATION_UNMANAGED', `Schema migration refuses unmanaged object ${entry.kind} ${entry.name ?? ''}`, { kind: entry.kind });
  }
}

export function createSchemaMigrationPlan({ migrationId, targetIdentity, fromContractId, desiredSchema, primaryKey, diff } = {}) {
  const migration = requireMigrationId(migrationId);
  if (!targetIdentity || typeof targetIdentity !== 'object') fail('INVALID_SCHEMA_MIGRATION_INPUT', 'targetIdentity is required');
  requireHash('fromContractId', fromContractId);
  const desired = requireDesiredSchema(desiredSchema);
  const pk = requirePrimaryKey(primaryKey, desired);
  if (!Array.isArray(diff) || diff.length === 0) fail('SCHEMA_MIGRATION_EMPTY', 'Schema migration requires a non-empty diff');
  const entries = diff.map(requireDiffEntry);
  if (entries.some(entry => entry.kind.startsWith('UNMANAGED'))) {
    fail('SCHEMA_MIGRATION_UNMANAGED', 'Schema migration refuses tables with unmanaged indexes, triggers, rules or constraints', {
      unmanaged: entries.filter(entry => entry.kind.startsWith('UNMANAGED'))
    });
  }
  const steps = entries.map((entry, index) => Object.freeze({
    stepId: index + 1,
    kind: entry.kind,
    column: entry.column ?? null,
    columns: entry.columns ? Object.freeze([...entry.columns]) : null,
    fromType: entry.fromType ?? null,
    toType: entry.toType ?? CANONICAL_PG_TYPE[entry.desiredType] ?? null,
    nullable: entry.nullable ?? null,
    safety: entry.safety
  }));
  const requiresDestructiveApproval = steps.some(step => step.safety === 'DESTRUCTIVE');
  const record = {
    schemaVersion: 1,
    migrationId: migration,
    targetIdentity: JSON.parse(JSON.stringify(targetIdentity)),
    fromContractId,
    desiredSchema: desired.map(field => ({ ...field })),
    primaryKey: [...pk],
    steps
  };
  const planId = sha256Canonical(PLAN_DOMAIN, record);
  return Object.freeze({ ...record, planId, requiresDestructiveApproval });
}

function requireBroker(credentialBroker) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_SCHEMA_MIGRATION_INPUT', 'credentialBroker.withSecret() is required');
  return credentialBroker;
}

async function ensureMigrationLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS spool_internal.schema_migrations (
      plan_id text PRIMARY KEY,
      migration_id text NOT NULL,
      target_database text NOT NULL,
      target_schema text NOT NULL,
      target_table text NOT NULL,
      from_contract_id text NOT NULL,
      to_contract_id text NOT NULL,
      destructive boolean NOT NULL,
      approval_id text NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  const description = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'spool_internal' AND table_name = 'schema_migrations'
  `);
  const columns = new Set(description.rows.map(row => row.column_name));
  const required = ['plan_id', 'migration_id', 'target_database', 'target_schema', 'target_table', 'from_contract_id', 'to_contract_id', 'destructive', 'approval_id', 'applied_at'];
  if (required.some(name => !columns.has(name))) {
    fail('POSTGRES_METADATA_CONTRACT_INVALID', 'Existing spool_internal.schema_migrations does not match the required contract');
  }
}

function migrationLeaseResource(ref) {
  return `postgres:${ref.endpoint}:${ref.database}:${ref.schema}.${ref.table}:schema-migration`;
}

function assertDestructiveApproval(plan, destructiveApproval) {
  if (!plan.requiresDestructiveApproval) return null;
  if (!destructiveApproval || typeof destructiveApproval !== 'object') {
    fail('APPROVAL_REQUIRED', 'Destructive schema migration requires a bound destructive approval', { planId: plan.planId });
  }
  const record = destructiveApproval.record;
  if (typeof destructiveApproval.approvalId !== 'string' || !destructiveApproval.approvalId) {
    fail('INVALID_APPROVAL', 'Destructive approval envelope is invalid', { planId: plan.planId });
  }
  if (!record || record.migrationId !== plan.migrationId) {
    fail('APPROVAL_BINDING_MISMATCH', 'Destructive approval is not bound to this migration', { planId: plan.planId });
  }
  if (!Array.isArray(record.effects) || !record.effects.includes(EFFECT_DESTRUCTIVE)) {
    fail('APPROVAL_BINDING_MISMATCH', `Destructive approval must include the ${EFFECT_DESTRUCTIVE} effect`, { planId: plan.planId });
  }
  if (record.targetContractId !== plan.fromContractId) {
    fail('APPROVAL_BINDING_MISMATCH', 'Destructive approval is not bound to the migration source contract', { planId: plan.planId });
  }
  if (!Number.isFinite(Date.parse(record.expiresAt ?? '')) || Date.parse(record.expiresAt) <= Date.now()) {
    fail('APPROVAL_EXPIRED', 'Destructive approval has expired', { planId: plan.planId });
  }
  return destructiveApproval.approvalId;
}

function stepSatisfied(step, record, desiredByName) {
  const live = new Map(record.columns.map(column => [column.name, column]));
  switch (step.kind) {
    case 'ADD_COLUMN': return live.has(step.column);
    case 'DROP_COLUMN': return !live.has(step.column);
    case 'ALTER_COLUMN_TYPE': {
      const column = live.get(step.column);
      if (!column) return false;
      const desired = desiredByName.get(step.column);
      return typeChangeSafety(desired.type, column) == null;
    }
    case 'SET_NOT_NULL': return live.get(step.column)?.notNull === true;
    case 'DROP_NOT_NULL': return live.get(step.column)?.notNull !== true;
    case 'PK_DROP': return livePrimaryKey(record).length === 0;
    case 'PK_ADD': {
      const livePk = livePrimaryKey(record);
      return JSON.stringify([...livePk].sort()) === JSON.stringify([...(step.columns ?? [])].sort());
    }
    default: return false;
  }
}

async function executeStep(client, ref, step, record) {
  if (step.kind === 'PK_DROP') {
    const name = livePkConstraintName(record);
    if (!name) fail('SCHEMA_MIGRATION_STEP_UNPROVEN', 'Live primary-key constraint disappeared before the drop step', { stepId: step.stepId });
    await client.query(`ALTER TABLE ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.table)} DROP CONSTRAINT ${quoteIdentifier(name)}`);
    return;
  }
  const sql = stepSql(ref.schema, ref.table, {
    kind: step.kind,
    column: step.column,
    columns: step.columns,
    toType: step.toType,
    nullable: step.nullable,
    safety: step.safety
  });
  await client.query(sql);
}

export async function captureSchemaContract({ targetRef, credentialBroker } = {}) {
  const ref = requireDatabaseRef(targetRef);
  requireBroker(credentialBroker);
  return withPostgresClient({ targetRef: ref, credentialBroker }, async client => {
    const record = await postgresTargetContractRecord(client, { database: ref.database, schema: ref.schema, table: ref.table });
    const contractId = await postgresTargetContractId(client, ref);
    return Object.freeze({ record: Object.freeze(record), contractId });
  });
}

export async function describeSchemaDrift({ targetRef, credentialBroker, expectedContractId, desiredSchema, primaryKey } = {}) {
  const ref = requireDatabaseRef(targetRef);
  requireBroker(credentialBroker);
  requireHash('expectedContractId', expectedContractId);
  const captured = await captureSchemaContract({ targetRef: ref, credentialBroker });
  const diff = diffPostgresSchema({ desiredSchema, primaryKey, liveRecord: captured.record });
  const contractChanged = captured.contractId !== expectedContractId;
  return Object.freeze({
    status: contractChanged || diff.length > 0 ? 'DRIFTED' : 'IN_SYNC',
    liveContractId: captured.contractId,
    expectedContractId,
    contractChanged,
    diff
  });
}

export async function applySchemaMigration({ targetRef, credentialBroker, plan, leaseTtlMs = 60_000, destructiveApproval = null } = {}) {
  const ref = requireDatabaseRef(targetRef);
  requireBroker(credentialBroker);
  if (!plan || typeof plan !== 'object' || typeof plan.planId !== 'string' || !HASH.test(plan.planId)) {
    fail('INVALID_SCHEMA_MIGRATION_INPUT', 'A valid schema migration plan is required');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail('SCHEMA_MIGRATION_EMPTY', 'Schema migration plan has no steps');
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) fail('INVALID_SCHEMA_MIGRATION_INPUT', 'leaseTtlMs must be a positive safe integer');
  const approvalId = assertDestructiveApproval(plan, destructiveApproval);
  const desiredByName = new Map((plan.desiredSchema ?? []).map(field => [field.name, field]));

  const replay = await withPostgresClient({ targetRef: ref, credentialBroker }, async client => {
    try {
      const existing = await client.query('SELECT to_contract_id FROM spool_internal.schema_migrations WHERE plan_id = $1', [plan.planId]);
      if (!existing.rows[0]) return null;
      const liveId = await postgresTargetContractId(client, ref);
      if (existing.rows[0].to_contract_id !== liveId) return null;
      return Object.freeze({ status: 'ALREADY_APPLIED', planId: plan.planId, migrationId: plan.migrationId, toContractId: liveId, stepsApplied: 0 });
    } catch (error) {
      if (error?.code === '42P01') return null;
      throw error;
    }
  });
  if (replay) return replay;

  const lease = await acquirePostgresLease({
    targetRef: ref, credentialBroker,
    resource: migrationLeaseResource(ref),
    owner: `migration:${plan.migrationId}:${randomUUID()}`,
    ttlMs: leaseTtlMs
  });

  return withPostgresClient({ targetRef: ref, credentialBroker }, async client => {
    await client.query('BEGIN');
    try {
      await ensureMigrationLedger(client);
      const existing = await client.query('SELECT plan_id, to_contract_id FROM spool_internal.schema_migrations WHERE plan_id = $1', [plan.planId]);
      const liveId = await postgresTargetContractId(client, ref);
      if (existing.rows[0]) {
        if (existing.rows[0].to_contract_id === liveId) {
          await client.query('COMMIT');
          return Object.freeze({ status: 'ALREADY_APPLIED', planId: plan.planId, migrationId: plan.migrationId, toContractId: liveId, stepsApplied: 0 });
        }
        await client.query('ROLLBACK');
        fail('SCHEMA_MIGRATION_LEDGER_CONFLICT', 'Schema migration plan was applied before but the live contract has since changed', { planId: plan.planId });
      }
      if (liveId !== plan.fromContractId) {
        await client.query('ROLLBACK');
        const drift = await describeSchemaDrift({
          targetRef: ref, credentialBroker,
          expectedContractId: plan.fromContractId,
          desiredSchema: plan.desiredSchema, primaryKey: plan.primaryKey
        });
        fail('SCHEMA_DRIFT', 'Live PostgreSQL contract changed before schema migration; re-plan before applying', {
          planId: plan.planId, liveContractId: liveId, fromContractId: plan.fromContractId, drift
        });
      }

      let applied = 0;
      for (const step of plan.steps) {
        const before = await postgresTargetContractRecord(client, { database: ref.database, schema: ref.schema, table: ref.table });
        if (stepSatisfied(step, before, desiredByName)) continue;
        await executeStep(client, ref, step, before);
        applied += 1;
      }

      const after = await postgresTargetContractRecord(client, { database: ref.database, schema: ref.schema, table: ref.table });
      const residual = diffPostgresSchema({ desiredSchema: plan.desiredSchema, primaryKey: plan.primaryKey, liveRecord: after })
        .filter(entry => !entry.kind.startsWith('UNMANAGED'));
      if (residual.length > 0) {
        await client.query('ROLLBACK');
        fail('SCHEMA_MIGRATION_UNPROVEN', 'Live PostgreSQL shape does not match the desired schema after migration', { planId: plan.planId, residual });
      }
      const toContractId = await postgresTargetContractId(client, ref);
      await client.query(`
        INSERT INTO spool_internal.schema_migrations
          (plan_id, migration_id, target_database, target_schema, target_table, from_contract_id, to_contract_id, destructive, approval_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [plan.planId, plan.migrationId, ref.database, ref.schema, ref.table, plan.fromContractId, toContractId, plan.requiresDestructiveApproval === true, approvalId]);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'APPLIED', planId: plan.planId, migrationId: plan.migrationId,
        fromContractId: plan.fromContractId, toContractId, stepsApplied: applied,
        destructive: plan.requiresDestructiveApproval === true, approvalId,
        fencingToken: lease.fencingToken
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* primary error wins */ }
      throw error;
    }
  });
}
