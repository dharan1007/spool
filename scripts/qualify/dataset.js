import { createHash } from 'node:crypto';
import { sha256Canonical } from '../../src/platform/canonical-json.js';

const GENERATOR_VERSION = 'spool-dataset-v1';
const SCHEMA = Object.freeze([
  { name: 'id', type: 'integer' },
  { name: 'tenant_id', type: 'integer' },
  { name: 'external_id', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'email', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'integer_value', type: 'integer' },
  { name: 'decimal_value', type: 'number' },
  { name: 'boolean_value', type: 'boolean' },
  { name: 'timestamp_value', type: 'string' },
  { name: 'nullable_value', type: 'string' },
  { name: 'unicode_value', type: 'string' },
  { name: 'json_value', type: 'string' },
  { name: 'payload', type: 'string' },
  { name: 'updated_at', type: 'string' }
]);

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashToSeed(seed) {
  const h = createHash('sha256').update(String(seed)).digest();
  return h.readUInt32BE(0) ^ h.readUInt32BE(4) ^ h.readUInt32BE(8) ^ h.readUInt32BE(12);
}

function deterministicChoice(seed, id, field, choices) {
  const rng = mulberry32(hashToSeed(`${seed}:${id}:${field}`));
  return choices[Math.floor(rng() * choices.length)];
}

function deterministicInt(seed, id, field, min, max) {
  const rng = mulberry32(hashToSeed(`${seed}:${id}:${field}:int`));
  return Math.floor(rng() * (max - min + 1)) + min;
}

function deterministicFloat(seed, id, field, min, max, decimals = 2) {
  const rng = mulberry32(hashToSeed(`${seed}:${id}:${field}:float`));
  const v = rng() * (max - min) + min;
  return Number(v.toFixed(decimals));
}

function deterministicString(seed, id, field, len) {
  const rng = mulberry32(hashToSeed(`${seed}:${id}:${field}:str`));
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(rng() * chars.length)];
  return out;
}

function deterministicUnicode(seed, id) {
  const samples = ['café', 'naïve', 'résumé', '北京', 'Москва', 'مرحبا', '🙂🚀', 'Ω≈ç√', 'nil→null', 'a\u0301'];
  return deterministicChoice(seed, id, 'unicode', samples) + deterministicString(seed, id, 'unicode2', 8);
}

export function generateRow(seed, id, { payloadBytes = 256 } = {}) {
  const tenantId = deterministicInt(seed, id, 'tenant', 1, 1000);
  // Skewed: 10% of tenants get 50% of rows
  const skewedTenant = id % 10 === 0 ? deterministicInt(seed, id, 'skewed', 1, 100) : tenantId;
  const externalId = createHash('sha256').update(`${seed}:external:${id}`).digest('hex').slice(0, 16);
  const name = `user_${deterministicString(seed, id, 'name', 12)}`;
  const email = `${deterministicString(seed, id, 'email', 8).toLowerCase()}@example.com`;
  const status = deterministicChoice(seed, id, 'status', ['active', 'inactive', 'pending', 'suspended']);
  const integerValue = deterministicInt(seed, id, 'int', -1000000, 1000000);
  const decimalValue = deterministicFloat(seed, id, 'dec', -1e6, 1e6, 4);
  const booleanValue = deterministicChoice(seed, id, 'bool', [true, false]);
  const ts = new Date(Date.UTC(2020, 0, 1) + deterministicInt(seed, id, 'ts', 0, 1_000_000_000)).toISOString();
  // 10% NULLs
  const nullableValue = (id % 10 === 0) ? null : deterministicString(seed, id, 'nullable', 12);
  const unicodeValue = deterministicUnicode(seed, id);
  const jsonValue = JSON.stringify({ id, tenant: skewedTenant, nested: { a: deterministicInt(seed, id, 'json', 1, 100), b: deterministicString(seed, id, 'json2', 6) } });
  const payloadLen = Math.max(0, payloadBytes - (name.length + email.length + 32));
  const payload = deterministicString(seed, id, 'payload', payloadLen);
  const updatedAt = new Date(Date.UTC(2023, 0, 1) + deterministicInt(seed, id, 'updated', 0, 1_000_000_000)).toISOString();
  return {
    id,
    tenant_id: skewedTenant,
    external_id: externalId,
    name,
    email,
    status,
    integer_value: integerValue,
    decimal_value: decimalValue,
    boolean_value: booleanValue,
    timestamp_value: ts,
    nullable_value: nullableValue,
    unicode_value: unicodeValue,
    json_value: jsonValue,
    payload,
    updated_at: updatedAt
  };
}

export function datasetId({ seed, rowCount, payloadBytes, schema = SCHEMA, generatorVersion = GENERATOR_VERSION } = {}) {
  if (seed == null) throw new Error('seed is required');
  if (!Number.isSafeInteger(rowCount) || rowCount < 1) throw new Error('rowCount required');
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1) throw new Error('payloadBytes required');
  return sha256Canonical('spool-dataset-identity-v1', {
    generatorVersion,
    seed: String(seed),
    schema: schema.map(f => ({ name: f.name, type: f.type })),
    rowCount,
    payloadBytes
  });
}

export function* generateRows({ seed, rowCount, payloadBytes }) {
  for (let id = 1; id <= rowCount; id++) {
    yield generateRow(seed, id, { payloadBytes });
  }
}

export async function writeDatasetCsv({ seed, rowCount, payloadBytes, filePath }) {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  const headers = SCHEMA.map(f => f.name).join(',');
  const rows = generateRows({ seed, rowCount, payloadBytes });
  const stream = Readable.from((function* () {
    yield headers + '\n';
    for (const row of rows) {
      const cols = SCHEMA.map(f => {
        const v = row[f.name];
        if (v == null) return '';
        const s = String(v).replaceAll('"', '""');
        // Quote if needed
        if (s.includes(',') || s.includes('"') || s.includes('\n') || f.type === 'string') return `"${s}"`;
        return s;
      });
      yield cols.join(',') + '\n';
    }
  })());
  const out = createWriteStream(filePath, { encoding: 'utf8' });
  await pipeline(stream, out);
  return { filePath, rowCount, payloadBytes, datasetId: datasetId({ seed, rowCount, payloadBytes }) };
}

export const DATASET_SCHEMA = SCHEMA;
export const DATASET_GENERATOR_VERSION = GENERATOR_VERSION;
