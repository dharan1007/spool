import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { parseMssqlEndpoint, withMssqlConnection } from './connection.js';

const CONTRACT_DOMAIN = 'spool-mssql-target-contract-v1';
const FIELD = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SCHEMA = 'dbo';

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MSSQL_PREFLIGHT', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MSSQL_PREFLIGHT', `${label} cannot contain NUL`);
  return value.trim();
}

export async function mssqlQuery(queryable, text, values = []) {
  const request = queryable.request();
  values.forEach((value, index) => {
    request.input(`p${index + 1}`, value === undefined ? null : value);
  });
  return request.query(text);
}

function requireMssqlTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'SQL Server targetRef is required');
  if (targetRef.connector !== 'mssql') fail('UNSUPPORTED_TARGET_CONNECTOR', 'SQL Server target preflight requires connector mssql');
  if (targetRef.path != null) fail('INVALID_TARGET_REF', 'SQL Server targetRef must not contain a filesystem path');
  parseMssqlEndpoint(targetRef.endpoint);
  requireText(targetRef.database, 'targetRef.database');
  requireText(targetRef.table, 'targetRef.table');
  requireText(targetRef.identity?.user, 'targetRef.identity.user');
  validateSecretRef(targetRef.secretRef);
  return targetRef;
}

function requireTargetSchema(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_MSSQL_PREFLIGHT', 'targetSchema is required');
  const seen = new Set();
  return targetSchema.map(field => {
    if (!field || typeof field !== 'object' || !FIELD.test(field.name ?? '') || typeof field.type !== 'string') {
      fail('INVALID_MSSQL_PREFLIGHT', 'targetSchema contains an invalid field');
    }
    if (seen.has(field.name)) fail('INVALID_MSSQL_PREFLIGHT', `targetSchema contains duplicate field ${field.name}`);
    seen.add(field.name);
    return { name: field.name, type: field.type, nullable: field.nullable !== false };
  });
}

function compatible(fieldType, mssqlType) {
  const type = String(mssqlType ?? '').toLowerCase();
  if (fieldType === 'integer') return ['tinyint', 'smallint', 'int', 'bigint'].includes(type);
  if (fieldType === 'number') return ['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(type);
  if (fieldType === 'boolean') return type === 'bit';
  if (fieldType === 'date') return type === 'date';
  if (fieldType === 'local_datetime') return ['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(type);
  if (fieldType === 'string') return ['char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext'].includes(type);
  return false;
}

async function describeTable(queryable, database, table) {
  const tables = await mssqlQuery(queryable,
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = @p1 AND TABLE_SCHEMA = @p2 AND TABLE_NAME = @p3 AND TABLE_TYPE = \'BASE TABLE\'',
    [database, SCHEMA, table]
  );
  if (tables.recordset.length !== 1) fail('MSSQL_TARGET_NOT_FOUND', `SQL Server target ${database}.${SCHEMA}.${table} does not exist as an ordinary table`);
  const columns = await mssqlQuery(queryable,
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType,
            CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS isNullable,
            COLUMN_DEFAULT AS columnDefault, ORDINAL_POSITION AS position
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG = @p1 AND TABLE_SCHEMA = @p2 AND TABLE_NAME = @p3 ORDER BY ORDINAL_POSITION`,
    [database, SCHEMA, table]
  );
  if (!columns.recordset.length) fail('MSSQL_TARGET_EMPTY_SCHEMA', 'SQL Server target table has no readable columns');
  const keys = await mssqlQuery(queryable,
    `SELECT kcu.COLUMN_NAME AS name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.TABLE_CATALOG = @p1 AND tc.TABLE_SCHEMA = @p2 AND tc.TABLE_NAME = @p3 AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
     ORDER BY kcu.ORDINAL_POSITION`,
    [database, SCHEMA, table]
  );
  return {
    table,
    columns: columns.recordset.map(row => Object.freeze({
      name: row.name,
      dataType: String(row.dataType).toLowerCase(),
      nullable: Number(row.isNullable) === 1,
      hasDefault: row.columnDefault !== null,
      position: Number(row.position)
    })),
    primaryKey: Object.freeze(keys.recordset.map(row => row.name))
  };
}

function checkSchema(schema, description) {
  const problems = [];
  const actual = new Map(description.columns.map(column => [column.name, column]));
  for (const field of schema) {
    const column = actual.get(field.name);
    if (!column) {
      problems.push({ field: field.name, problem: 'missing_column' });
      continue;
    }
    if (!compatible(field.type, column.dataType)) {
      problems.push({ field: field.name, problem: 'incompatible_type', expectedType: field.type, actualType: column.dataType });
    }
    if (field.nullable && !column.nullable) problems.push({ field: field.name, problem: 'target_is_stricter_not_null' });
  }
  for (const column of description.columns) {
    const declared = schema.some(field => field.name === column.name);
    if (!declared && !column.nullable && !column.hasDefault) {
      problems.push({ field: column.name, problem: 'extra_required_column_without_default' });
    }
  }
  if (problems.length) fail('TARGET_SCHEMA_INCOMPATIBLE', 'Live SQL Server target does not satisfy the declared migration schema', { problems });
}

export async function mssqlTargetContractId(queryable, ref) {
  const description = await describeTable(queryable, ref.database, ref.table);
  return sha256Canonical(CONTRACT_DOMAIN, {
    schemaVersion: 1,
    database: ref.database,
    schema: SCHEMA,
    table: description.table,
    columns: description.columns,
    primaryKey: description.primaryKey
  });
}

export async function inspectMssqlTarget({ targetRef, targetSchema, credentialBroker } = {}) {
  requireMssqlTargetRef(targetRef);
  const schema = requireTargetSchema(targetSchema);
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MSSQL_PREFLIGHT', 'credentialBroker.withSecret() is required');
  return withMssqlConnection({ targetRef, credentialBroker }, async pool => {
    const description = await describeTable(pool, targetRef.database, targetRef.table);
    checkSchema(schema, description);
    const targetContractId = await mssqlTargetContractId(pool, targetRef);
    return Object.freeze({
      status: 'READY',
      targetContractId,
      columns: Object.freeze(description.columns),
      primaryKey: description.primaryKey,
      indexes: Object.freeze([]),
      foreignKeys: Object.freeze([])
    });
  });
}
