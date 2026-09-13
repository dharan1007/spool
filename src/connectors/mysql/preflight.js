import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { parseMysqlEndpoint, withMysqlConnection } from './connection.js';

const CONTRACT_DOMAIN = 'spool-mysql-target-contract-v1';
const FIELD = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_MYSQL_PREFLIGHT', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_MYSQL_PREFLIGHT', `${label} cannot contain NUL`);
  return value.trim();
}

function requireMysqlTargetRef(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) fail('INVALID_TARGET_REF', 'MySQL targetRef is required');
  if (targetRef.connector !== 'mysql') fail('UNSUPPORTED_TARGET_CONNECTOR', 'MySQL target preflight requires connector mysql');
  if (targetRef.path != null) fail('INVALID_TARGET_REF', 'MySQL targetRef must not contain a filesystem path');
  parseMysqlEndpoint(targetRef.endpoint);
  requireText(targetRef.database, 'targetRef.database');
  requireText(targetRef.table, 'targetRef.table');
  requireText(targetRef.identity?.user, 'targetRef.identity.user');
  validateSecretRef(targetRef.secretRef);
  return targetRef;
}

function requireTargetSchema(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_MYSQL_PREFLIGHT', 'targetSchema is required');
  const seen = new Set();
  return targetSchema.map(field => {
    if (!field || typeof field !== 'object' || !FIELD.test(field.name ?? '') || typeof field.type !== 'string') {
      fail('INVALID_MYSQL_PREFLIGHT', 'targetSchema contains an invalid field');
    }
    if (seen.has(field.name)) fail('INVALID_MYSQL_PREFLIGHT', `targetSchema contains duplicate field ${field.name}`);
    seen.add(field.name);
    return { name: field.name, type: field.type, nullable: field.nullable !== false };
  });
}

function compatible(fieldType, mysqlType) {
  const type = String(mysqlType ?? '').toLowerCase();
  if (fieldType === 'integer') return ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(type);
  if (fieldType === 'number') return ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'double'].includes(type);
  if (fieldType === 'boolean') return type === 'tinyint';
  if (fieldType === 'date') return type === 'date';
  if (fieldType === 'local_datetime') return ['datetime', 'timestamp'].includes(type);
  if (fieldType === 'string') return ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'].includes(type);
  return false;
}

async function describeTable(connection, database, table) {
  const [tables] = await connection.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = \'BASE TABLE\'',
    [database, table]
  );
  if (tables.length !== 1) fail('MYSQL_TARGET_NOT_FOUND', `MySQL target ${database}.${table} does not exist as an ordinary table`);
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS isNullable,
            COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, ORDINAL_POSITION AS position
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  if (!columns.length) fail('MYSQL_TARGET_EMPTY_SCHEMA', 'MySQL target table has no readable columns');
  const [keys] = await connection.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  return {
    table,
    columns: columns.map(row => Object.freeze({
      name: row.name,
      dataType: String(row.dataType).toLowerCase(),
      nullable: row.isNullable === 'YES',
      hasDefault: row.columnDefault !== null,
      generated: /GENERATED/i.test(String(row.extra ?? '')),
      position: Number(row.position)
    })),
    primaryKey: Object.freeze(keys.map(row => row.name))
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
    if (column.generated) problems.push({ field: field.name, problem: 'generated_column' });
    if (!compatible(field.type, column.dataType)) {
      problems.push({ field: field.name, problem: 'incompatible_type', expectedType: field.type, actualType: column.dataType });
    }
    if (field.nullable && !column.nullable) problems.push({ field: field.name, problem: 'target_is_stricter_not_null' });
  }
  for (const column of description.columns) {
    const declared = schema.some(field => field.name === column.name);
    if (!declared && !column.nullable && !column.hasDefault && !column.generated) {
      problems.push({ field: column.name, problem: 'extra_required_column_without_default' });
    }
  }
  if (problems.length) fail('TARGET_SCHEMA_INCOMPATIBLE', 'Live MySQL target does not satisfy the declared migration schema', { problems });
}

export async function mysqlTargetContractId(connection, ref) {
  const description = await describeTable(connection, ref.database, ref.table);
  return sha256Canonical(CONTRACT_DOMAIN, {
    schemaVersion: 1,
    database: ref.database,
    table: description.table,
    columns: description.columns,
    primaryKey: description.primaryKey
  });
}

export async function inspectMysqlTarget({ targetRef, targetSchema, credentialBroker } = {}) {
  requireMysqlTargetRef(targetRef);
  const schema = requireTargetSchema(targetSchema);
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_MYSQL_PREFLIGHT', 'credentialBroker.withSecret() is required');
  return withMysqlConnection({ targetRef, credentialBroker }, async connection => {
    const description = await describeTable(connection, targetRef.database, targetRef.table);
    checkSchema(schema, description);
    const targetContractId = await mysqlTargetContractId(connection, targetRef);
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
