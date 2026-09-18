import { fail } from '../../src/core/errors.js';

export const PROFILE_DEFINITIONS = Object.freeze({
  CI: Object.freeze({
    name: 'CI',
    rows: 100_000,
    payloadBytes: 256,
    batchSize: 5000,
    writers: 2,
    workers: 2,
    cdcDurationSeconds: 30,
    largeTransactionRows: 10_000,
    maxRssBytes: 768 * 1024 * 1024,
    description: 'CI: minimal sustained load for PR gate (30s CDC)'
  }),
  SMALL: Object.freeze({
    name: 'SMALL',
    rows: 1_000_000,
    payloadBytes: 512,
    batchSize: 5000,
    writers: 5,
    workers: 4,
    cdcDurationSeconds: 300,
    largeTransactionRows: 100_000,
    maxRssBytes: 1536 * 1024 * 1024,
    description: 'SMALL: 1M rows, 5 writers, 5 min CDC'
  }),
  MEDIUM: Object.freeze({
    name: 'MEDIUM',
    rows: 10_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 10,
    workers: 8,
    cdcDurationSeconds: 3600,
    largeTransactionRows: 500_000,
    maxRssBytes: 3072 * 1024 * 1024,
    description: 'MEDIUM: 10M rows, 1h CDC'
  }),
  LARGE: Object.freeze({
    name: 'LARGE',
    rows: 100_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 20,
    workers: 16,
    cdcDurationSeconds: 6 * 3600,
    largeTransactionRows: 1_000_000,
    maxRssBytes: 6144 * 1024 * 1024,
    description: 'LARGE: 100M rows, 6h CDC'
  }),
  INDUSTRIAL: Object.freeze({
    name: 'INDUSTRIAL',
    rows: 1_000_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 50,
    workers: 32,
    cdcDurationSeconds: 24 * 3600,
    largeTransactionRows: 1_000_000,
    maxRssBytes: 12 * 1024 * 1024 * 1024,
    description: 'INDUSTRIAL: 1B rows, 24h CDC'
  })
});

const OVERRIDE_KEYS = new Set(['rows', 'payloadBytes', 'batchSize', 'writers', 'workers', 'cdcDurationSeconds', 'largeTransactionRows', 'maxRssBytes']);

function parseOverride(key, value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_PROFILE_OVERRIDE', `Override ${key} must be a non-negative safe integer`);
  return n;
}

export function resolveProfile(name, overrides = {}) {
  const upper = String(name ?? 'CI').toUpperCase();
  const base = PROFILE_DEFINITIONS[upper];
  if (!base) fail('UNKNOWN_PROFILE', `Unknown qualification profile ${name}. Valid: ${Object.keys(PROFILE_DEFINITIONS).join(', ')}`);
  const resolved = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!OVERRIDE_KEYS.has(key)) fail('INVALID_PROFILE_OVERRIDE', `Unknown override ${key}`);
    if (value == null || value === '') continue;
    resolved[key] = parseOverride(key, value);
  }
  // Validate bounds
  if (resolved.rows < 1) fail('INVALID_PROFILE', 'rows must be >=1');
  if (resolved.payloadBytes < 1 || resolved.payloadBytes > 16 * 1024) fail('INVALID_PROFILE', 'payloadBytes must be 1..16384');
  if (resolved.batchSize < 1 || resolved.batchSize > 50000) fail('INVALID_PROFILE', 'batchSize must be 1..50000');
  if (resolved.writers < 1 || resolved.writers > 100) fail('INVALID_PROFILE', 'writers must be 1..100');
  if (resolved.workers < 1 || resolved.workers > 64) fail('INVALID_PROFILE', 'workers must be 1..64');
  if (resolved.cdcDurationSeconds < 5 || resolved.cdcDurationSeconds > 72 * 3600) fail('INVALID_PROFILE', 'cdcDurationSeconds must be 5..259200');
  return Object.freeze(resolved);
}

export function profileFromEnv() {
  const name = process.env.SPOOL_QUALIFY_PROFILE ?? 'CI';
  const overrides = {};
  for (const key of OVERRIDE_KEYS) {
    const envKey = `SPOOL_QUALIFY_${key.toUpperCase()}`;
    // also support SQUALIFY_ etc? just use upper snake
    // Map camelCase to env: rows -> ROWS, payloadBytes -> PAYLOAD_BYTES
    const mapped = {
      rows: 'ROWS',
      payloadBytes: 'PAYLOAD_BYTES',
      batchSize: 'BATCH_SIZE',
      writers: 'WRITERS',
      workers: 'WORKERS',
      cdcDurationSeconds: 'CDC_DURATION_SECONDS',
      largeTransactionRows: 'LARGE_TRANSACTION_ROWS',
      maxRssBytes: 'MAX_RSS_BYTES'
    }[key];
    const envVal = process.env[`SPOOL_QUALIFY_${mapped}`] ?? process.env[envKey];
    if (envVal != null && envVal !== '') overrides[key] = Number(envVal);
  }
  return resolveProfile(name, overrides);
}

export function formatProfile(profile) {
  return `${profile.name} rows=${profile.rows} payload=${profile.payloadBytes}B batch=${profile.batchSize} writers=${profile.writers} workers=${profile.workers} cdc=${profile.cdcDurationSeconds}s`;
}
