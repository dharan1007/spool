import { fail, SpoolError } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { parsePostgresEndpoint, withPostgresClient } from './connection.js';

const CONTRACT_DOMAIN = 'spool-postgres-target-contract-v1';
const METADATA_SCHEMA = 'spool_internal';

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_PREFLIGHT', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_PREFLIGHT', `${label} cannot contain NUL`);
  return value.trim();
}

function compatible(fieldType, pgType) {
  if (fieldType === 'integer') return ['int2', 'int4', 'int8'].includes(pgType);
  if (fieldType === 'number') return ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'].includes(pgType);
  if (fieldType === 'boolean') return pgType === 'bool';
  if (fieldType === 'date') return pgType === 'date';
  if (fieldType === 'local_datetime') return pgType === 'timestamp';
  if (fieldType === 'string') return ['text', 'varchar', 'bpchar'].includes(pgType);
  return false;
}

async function metadataPrivilegeRecord(client) {
  const result = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
      CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)
        THEN has_schema_privilege(current_user, $1, 'USAGE') ELSE false END AS can_use_schema,
      CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)
        THEN has_schema_privilege(current_user, $1, 'CREATE') ELSE false END AS can_create_in_schema
  `, [METADATA_SCHEMA]);
  const row = result.rows[0] ?? {};
  return {
    schemaExists: row.schema_exists === true,
    canCreateSchema: row.can_create_schema === true,
    canUseSchema: row.can_use_schema === true,
    canCreateInSchema: row.can_create_in_schema === true
  };
}

export async function postgresTargetContractRecord(client, { database, schema, table } = {}) {
  requireText(database, 'database');
  requireText(schema, 'schema');
  requireText(table, 'table');
  if (!client || typeof client.query !== 'function') fail('INVALID_POSTGRES_PREFLIGHT', 'An open PostgreSQL client is required');

  const identityResult = await client.query(`
    SELECT current_database() AS database, current_user AS current_user,
           current_setting('server_version_num')::int AS server_version_num
  `);
  const identity = identityResult.rows[0];
  if (!identity || identity.database !== database) {
    fail('POSTGRES_DATABASE_MISMATCH', 'Connected PostgreSQL database does not match targetRef.database', {
      expected: database,
      actual: identity?.database ?? null
    });
  }

  const tableResult = await client.query(`
    SELECT c.oid::text AS oid, c.relkind, c.relpersistence,
           c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
  `, [schema, table]);
  const relation = tableResult.rows[0];
  if (!relation || relation.relkind !== 'r') fail('TARGET_TABLE_NOT_FOUND', `PostgreSQL target ${schema}.${table} does not exist as an ordinary table`);
  if (relation.relpersistence !== 'p') fail('UNSUPPORTED_TARGET_TABLE', 'PostgreSQL target must be a permanent table; temporary and unlogged tables are not supported');
  if (relation.relrowsecurity === true || relation.relforcerowsecurity === true) {
    fail('TARGET_ROW_SECURITY_UNSUPPORTED', 'PostgreSQL targets with row-level security are rejected because policy-dependent writes cannot yet be proven');
  }

  const oid = relation.oid;
  const columnsResult = await client.query(`
    SELECT a.attnum, a.attname,
           t.typname,
           format_type(a.atttypid, a.atttypmod) AS formatted_type,
           a.attnotnull,
           a.attidentity,
           a.attgenerated,
           pg_get_expr(ad.adbin, ad.adrelid) AS default_sql
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [oid]);
  const columns = columnsResult.rows.map(row => ({
    ordinal: Number(row.attnum),
    name: row.attname,
    pgType: row.typname,
    formattedType: row.formatted_type,
    notNull: row.attnotnull === true,
    identity: row.attidentity || '',
    generated: row.attgenerated || '',
    defaultSql: row.default_sql ?? null
  }));

  const indexesResult = await client.query(`
    SELECT ci.relname AS name, i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
           pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class ci ON ci.oid = i.indexrelid
    WHERE i.indrelid = $1::oid
    ORDER BY ci.relname
  `, [oid]);
  const indexes = indexesResult.rows.map(row => ({
    name: row.name,
    unique: row.indisunique === true,
    primary: row.indisprimary === true,
    valid: row.indisvalid === true,
    ready: row.indisready === true,
    definition: row.definition
  }));

  const constraintsResult = await client.query(`
    SELECT conname AS name, contype AS type, convalidated AS validated,
           condeferrable AS deferrable, condeferred AS deferred,
           pg_get_constraintdef(oid, true) AS definition
    FROM pg_constraint
    WHERE conrelid = $1::oid
    ORDER BY conname
  `, [oid]);
  const constraints = constraintsResult.rows.map(row => ({
    name: row.name,
    type: row.type,
    validated: row.validated === true,
    deferrable: row.deferrable === true,
    deferred: row.deferred === true,
    definition: row.definition
  }));

  const triggersResult = await client.query(`
    SELECT tgname AS name, tgenabled AS enabled, pg_get_triggerdef(oid, true) AS definition
    FROM pg_trigger
    WHERE tgrelid = $1::oid AND NOT tgisinternal
    ORDER BY tgname
  `, [oid]);
  const triggers = triggersResult.rows.map(row => ({ name: row.name, enabled: row.enabled, definition: row.definition }));

  const rulesResult = await client.query(`
    SELECT rulename AS name, definition
    FROM pg_rules
    WHERE schemaname = $1 AND tablename = $2
    ORDER BY rulename
  `, [schema, table]);
  const rules = rulesResult.rows.map(row => ({ name: row.name, definition: row.definition }));

  return {
    database,
    schema,
    table,
    relation: {
      kind: relation.relkind,
      persistence: relation.relpersistence,
      rowSecurity: false,
      forceRowSecurity: false
    },
    columns,
    indexes,
    constraints,
    triggers,
    rules
  };
}

function validateDeclaredTarget(record, targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_POSTGRES_PREFLIGHT', 'targetSchema must contain fields');
  if (record.triggers.some(trigger => trigger.enabled !== 'D')) {
    fail('TARGET_TRIGGER_UNSUPPORTED', 'PostgreSQL targets with enabled user triggers are rejected because they introduce undeclared side effects', {
      triggers: record.triggers.filter(trigger => trigger.enabled !== 'D').map(trigger => trigger.name)
    });
  }
  if (record.rules.length) {
    fail('TARGET_RULE_UNSUPPORTED', 'PostgreSQL targets with rewrite rules are rejected because they introduce undeclared write semantics', {
      rules: record.rules.map(rule => rule.name)
    });
  }

  const actual = new Map(record.columns.map(column => [column.name, column]));
  const declared = new Set();
  const problems = [];
  for (const field of targetSchema) {
    if (!field || typeof field !== 'object' || typeof field.name !== 'string' || typeof field.type !== 'string' || typeof field.nullable !== 'boolean') {
      fail('INVALID_POSTGRES_PREFLIGHT', 'targetSchema contains an invalid field');
    }
    declared.add(field.name);
    const column = actual.get(field.name);
    if (!column) {
      problems.push({ field: field.name, problem: 'missing_column' });
      continue;
    }
    if (column.identity || column.generated) problems.push({ field: field.name, problem: 'generated_or_identity_column' });
    if (!compatible(field.type, column.pgType)) problems.push({ field: field.name, problem: 'incompatible_type', expectedType: field.type, actualType: column.formattedType });
    if (field.nullable && column.notNull) problems.push({ field: field.name, problem: 'target_is_stricter_not_null' });
  }

  for (const column of record.columns) {
    if (declared.has(column.name)) continue;
    const requiredWithoutDefault = column.notNull && column.defaultSql == null && !column.identity && !column.generated;
    if (requiredWithoutDefault) problems.push({ field: column.name, problem: 'extra_required_column_without_default' });
  }
  if (problems.length) fail('TARGET_SCHEMA_INCOMPATIBLE', 'Live PostgreSQL target does not satisfy the declared migration schema', { problems });
}

function validateMetadataPrivileges(privileges) {
  if (privileges.schemaExists) {
    if (!privileges.canUseSchema || !privileges.canCreateInSchema) {
      fail('POSTGRES_METADATA_PRIVILEGE_REQUIRED', `PostgreSQL principal requires USAGE and CREATE on ${METADATA_SCHEMA}`);
    }
    return;
  }
  if (!privileges.canCreateSchema) {
    fail('POSTGRES_METADATA_PRIVILEGE_REQUIRED', `PostgreSQL principal must be able to create ${METADATA_SCHEMA}, or an administrator must pre-create and grant it`);
  }
}

export async function inspectPostgresTarget({ targetRef, targetSchema, credentialBroker } = {}) {
  try {
    parsePostgresEndpoint(targetRef?.endpoint);
    const database = requireText(targetRef?.database, 'database');
    const schema = requireText(targetRef?.schema, 'schema');
    const table = requireText(targetRef?.table, 'table');
    const expectedUser = requireText(targetRef?.identity?.user, 'identity.user');
    if (!targetRef?.secretRef) fail('POSTGRES_SECRET_REF_REQUIRED', 'PostgreSQL target requires secretRef');

    const result = await withPostgresClient({ targetRef, credentialBroker }, async client => {
      const identity = await client.query('SELECT current_user AS current_user, current_setting(\'server_version_num\')::int AS server_version_num');
      const record = await postgresTargetContractRecord(client, { database, schema, table });
      const privileges = await metadataPrivilegeRecord(client);
      return { identity: identity.rows[0], record, privileges };
    });
    if (result.identity?.current_user !== expectedUser) {
      fail('POSTGRES_USER_MISMATCH', 'Connected PostgreSQL user does not match targetRef.identity.user', {
        expected: expectedUser,
        actual: result.identity?.current_user ?? null
      });
    }
    validateDeclaredTarget(result.record, targetSchema);
    validateMetadataPrivileges(result.privileges);
    const targetContractId = sha256Canonical(CONTRACT_DOMAIN, result.record);
    return Object.freeze({
      status: 'READY',
      targetContractId,
      database,
      schema,
      table,
      serverVersionNum: Number(result.identity.server_version_num),
      columns: Object.freeze(result.record.columns.map(value => Object.freeze({ ...value }))),
      indexes: Object.freeze(result.record.indexes.map(value => Object.freeze({ ...value }))),
      foreignKeys: Object.freeze(result.record.constraints.filter(value => value.type === 'f').map(value => Object.freeze({ ...value })))
    });
  } catch (error) {
    if (error instanceof SpoolError) throw error;
    fail('TARGET_PREFLIGHT_FAILED', `PostgreSQL target preflight failed: ${error?.message ?? String(error)}`);
  }
}

export async function postgresTargetContractId(client, targetRef) {
  const record = await postgresTargetContractRecord(client, {
    database: targetRef?.database,
    schema: targetRef?.schema,
    table: targetRef?.table
  });
  return sha256Canonical(CONTRACT_DOMAIN, record);
}

export const POSTGRES_METADATA_SCHEMA = METADATA_SCHEMA;
