import { fail } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function classify(value) {
  const text = String(value ?? '').trim();
  if (text === '') return 'empty';
  if (/^[+-]?\d+$/.test(text) && Number.isSafeInteger(Number(text))) return 'integer';
  if (/^[+-]?(?:\d+\.\d+|\d+\.?)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))) return 'number';
  if (/^(?:true|false)$/i.test(text)) return 'boolean';
  if (ISO_DATE.test(text) && !Number.isNaN(Date.parse(text))) return 'date';
  return 'string';
}

export function inferSchema(rows, { sampleSize = 1000 } = {}) {
  const sample = rows.slice(0, sampleSize);
  const fields = sample.length ? Object.keys(sample[0]) : [];
  return fields.map(name => {
    const seen = new Set(sample.map(row => classify(row[name])).filter(t => t !== 'empty'));
    let type = 'string';
    if (seen.size === 1) type = [...seen][0];
    else if ([...seen].every(t => ['integer', 'number'].includes(t))) type = 'number';
    return {
      name,
      type,
      nullable: sample.some(row => String(row[name] ?? '').trim() === ''),
      samples: [...new Set(sample.map(row => row[name]).filter(v => String(v ?? '').trim() !== ''))].slice(0, 3)
    };
  });
}

export function validateTargetSchema(schema) {
  if (!Array.isArray(schema) || schema.length === 0) fail('INVALID_TARGET_SCHEMA', 'Target schema must contain at least one field');
  const allowedTypes = new Set(['string', 'integer', 'number', 'boolean', 'date']);
  const names = new Set();
  for (const field of schema) {
    if (!field || typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) fail('INVALID_FIELD_NAME', `Invalid field name ${field?.name}`);
    if (names.has(field.name)) fail('DUPLICATE_TARGET_FIELD', `Duplicate field ${field.name}`);
    names.add(field.name);
    if (!allowedTypes.has(field.type)) fail('INVALID_FIELD_TYPE', `Unsupported type ${field.type}`);
  }
  return schema;
}

export async function fingerprintText(text) {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateOutputRow(row, schema) {
  if (!schema?.length) return row;
  for (const field of schema) {
    const value = row[field.name];
    const empty = value === null || value === undefined || value === '';
    if (empty) {
      if (field.nullable === false) fail('REQUIRED_VALUE', `Target field ${field.name} cannot be empty`, { field: field.name });
      continue;
    }
    let valid = false;
    switch (field.type) {
      case 'string': valid = typeof value === 'string'; break;
      case 'integer': valid = typeof value === 'number' && Number.isInteger(value); break;
      case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'date': valid = typeof value === 'string' && !Number.isNaN(Date.parse(value)); break;
      default: valid = false;
    }
    if (!valid) fail('TYPE_MISMATCH', `Target field ${field.name} expected ${field.type}`, { field: field.name, expected: field.type, actual: typeof value, value });
  }
  return row;
}
