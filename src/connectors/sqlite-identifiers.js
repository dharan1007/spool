import { fail } from '../core/errors.js';

export function quoteSqliteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('INVALID_SQLITE_IDENTIFIER', 'SQLite identifier must be a non-empty string without NUL bytes');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function validateNewSqliteIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    fail('INVALID_SQLITE_RESOURCE', `New SQLite ${label} must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return value;
}

export function sqliteTypeForTarget(type) {
  switch (type) {
    case 'integer': return 'INTEGER';
    case 'number': return 'REAL';
    case 'boolean': return 'INTEGER';
    case 'date':
    case 'string': return 'TEXT';
    default: fail('UNSUPPORTED_SQLITE_TYPE', `Unsupported target type ${type}`);
  }
}

export function spoolTypeForSqlite(declaredType = '') {
  const type = String(declaredType).trim().toUpperCase();
  if (type.includes('INT')) return 'integer';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB') || type.includes('NUM') || type.includes('DEC')) return 'number';
  return 'string';
}
