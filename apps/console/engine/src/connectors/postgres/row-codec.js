import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_DOMAIN = 'spool-content-key-v1';
const ROW_DOMAIN = 'spool-content-row-v1';

export function normalizePostgresSchema(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_POSTGRES_VERIFICATION', 'targetSchema is required for PostgreSQL verification');
  const seen = new Set();
  return targetSchema.map(field => {
    if (!field || typeof field !== 'object' || !FIELD.test(field.name ?? '') || typeof field.type !== 'string') {
      fail('INVALID_POSTGRES_VERIFICATION', 'targetSchema contains an invalid field');
    }
    if (seen.has(field.name)) fail('INVALID_POSTGRES_VERIFICATION', `targetSchema contains duplicate field ${field.name}`);
    seen.add(field.name);
    return { name: field.name, type: field.type };
  });
}

export function normalizePostgresValue(value, field) {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'string': return String(value);
    case 'integer': {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not a safe integer`);
      return number;
    }
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not finite`);
      return number;
    }
    case 'boolean': {
      if (value === true || value === false) return value;
      if (value === 't' || value === 'true') return true;
      if (value === 'f' || value === 'false') return false;
      fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not boolean`);
      break;
    }
    case 'date': {
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `PostgreSQL field ${field.name} is not a canonical date`);
      return text;
    }
    case 'local_datetime': {
      const text = String(value).trim().replace(' ', 'T');
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/.exec(text);
      if (!match) fail('POSTGRES_VERIFICATION_VALUE_INVALID', `Unsupported local datetime value ${text}`);
      const fraction = (match[2] ?? '').replace(/0+$/, '');
      return fraction ? `${match[1]}.${fraction}` : match[1];
    }
    default: fail('POSTGRES_VERIFICATION_TYPE_UNSUPPORTED', `Unsupported verification type ${field.type}`);
  }
}

export function normalizePostgresRow(row, schema) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_POSTGRES_VERIFICATION', 'PostgreSQL row must be an object');
  const normalized = {};
  for (const field of schema) {
    if (!Object.hasOwn(row, field.name)) fail('CONTENT_PROJECTION_FIELD_MISSING', `PostgreSQL row is missing projected field ${field.name}`);
    normalized[field.name] = normalizePostgresValue(row[field.name], field);
  }
  return normalized;
}

export function postgresContentKeyId({ primaryKey, key } = {}) {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_POSTGRES_VERIFICATION', 'primaryKey is required for content identity');
  if (!key || typeof key !== 'object' || Array.isArray(key)) fail('INVALID_POSTGRES_VERIFICATION', 'key is required for content identity');
  return sha256Canonical(KEY_DOMAIN, { primaryKey, key });
}

export function postgresContentRowHash({ primaryKey, columns, key, row } = {}) {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) fail('INVALID_POSTGRES_VERIFICATION', 'primaryKey is required for content identity');
  if (!Array.isArray(columns) || columns.length === 0) fail('INVALID_POSTGRES_VERIFICATION', 'columns are required for content identity');
  return sha256Canonical(ROW_DOMAIN, { primaryKey, columns, key, row });
}
