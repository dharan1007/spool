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
    cdcDurationSeconds: 3600,
    largeTransactionRows: 100_000,
    maxRssBytes: 1536 * 1024 * 1024,
    description: 'SMALL: 1M rows, 5 writers, 1h CDC'
  }),
  MEDIUM: Object.freeze({
    name: 'MEDIUM',
    rows: 10_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 10,
    workers: 8,
    cdcDurationSeconds: 24 * 3600,
    largeTransactionRows: 500_000,
    maxRssBytes: 3072 * 1024 * 1024,
    description: 'MEDIUM: 10M rows, 24h CDC'
  }),
  LARGE: Object.freeze({
    name: 'LARGE',
    rows: 100_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 20,
    workers: 16,
    cdcDurationSeconds: 72 * 3600,
    largeTransactionRows: 1_000_000,
    maxRssBytes: 6144 * 1024 * 1024,
    description: 'LARGE: 100M rows, 72h CDC'
  }),
  INDUSTRIAL: Object.freeze({
    name: 'INDUSTRIAL',
    rows: 1_000_000_000,
    payloadBytes: 512,
    batchSize: 10000,
    writers: 50,
    workers: 32,
    cdcDurationSeconds: 7 * 24 * 3600,
    largeTransactionRows: 1_000_000,
    maxRssBytes: 12 * 1024 * 1024 * 1024,
    description: 'INDUSTRIAL: 1B rows, 7d CDC'
  })
});

// A seven-day immutable profile must be executable; custom longer soaks
// are bounded to 30 days and cannot inherit the immutable profile name.
const MAX_CDC_SOAK_SECONDS = 30 * 24 * 3600;
const OVERRIDE_KEYS = new Set(['rows', 'payloadBytes', 'batchSize', 'writers', 'workers', 'cdcDurationSeconds', 'largeTransactionRows', 'maxRssBytes']);

function parseOverride(key, value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_PROFILE_OVERRIDE', `Override ${key} must be a non-negative safe integer`);
  return n;
}

export const IMMUTABLE_PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_DEFINITIONS));

// Consistency validation: every field that scales the workload is bounded,
// and largeTransactionRows must be a positive executable size. Overrides
// never silently rename a run: any override produces a distinct
// <BASE>_CUSTOM profile whose requested config is the immutable base and
// whose effective config is the resolved override. The verifier rejects
// evidence where an immutable name carries a diverged configuration.
export function resolveProfile(name, overrides = {}) {
  const upper = String(name ?? 'CI').toUpperCase();
  const baseName = upper.endsWith('_CUSTOM') ? upper.slice(0, -'_CUSTOM'.length) : upper;
  const base = PROFILE_DEFINITIONS[baseName];
  if (!base) fail('UNKNOWN_PROFILE', `Unknown qualification profile ${name}. Valid: ${Object.keys(PROFILE_DEFINITIONS).join(', ')} (+ _CUSTOM variants by override only)`);
  const requested = { ...base };
  const resolved = { ...base };
  let customized = upper.endsWith('_CUSTOM');
  for (const [key, value] of Object.entries(overrides)) {
    if (!OVERRIDE_KEYS.has(key)) fail('INVALID_PROFILE_OVERRIDE', `Unknown override ${key}`);
    if (value == null || value === '') continue;
    resolved[key] = parseOverride(key, value);
    if (resolved[key] !== requested[key]) customized = true;
  }
  // Validate bounds
  if (resolved.rows < 1) fail('INVALID_PROFILE', 'rows must be >=1');
  if (resolved.payloadBytes < 1 || resolved.payloadBytes > 16 * 1024) fail('INVALID_PROFILE', 'payloadBytes must be 1..16384');
  if (resolved.batchSize < 1 || resolved.batchSize > 50000) fail('INVALID_PROFILE', 'batchSize must be 1..50000');
  if (resolved.batchSize > resolved.rows) fail('INVALID_PROFILE', 'batchSize must not exceed rows');
  if (resolved.writers < 1 || resolved.writers > 100) fail('INVALID_PROFILE', 'writers must be 1..100');
  if (resolved.workers < 1 || resolved.workers > 64) fail('INVALID_PROFILE', 'workers must be 1..64');
  if (resolved.cdcDurationSeconds < 5 || resolved.cdcDurationSeconds > MAX_CDC_SOAK_SECONDS) fail('INVALID_PROFILE', 'cdcDurationSeconds must be 5..2592000');
  if (!Number.isSafeInteger(resolved.largeTransactionRows) || resolved.largeTransactionRows < 1) fail('INVALID_PROFILE', 'largeTransactionRows must be >= 1');
  if (!Number.isSafeInteger(resolved.maxRssBytes) || resolved.maxRssBytes < 64 * 1024 * 1024) fail('INVALID_PROFILE', 'maxRssBytes must be >= 64MiB');
  const neededBytes = resolved.rows * (resolved.payloadBytes + 512) * 3;
  if (!Number.isSafeInteger(neededBytes)) fail('INVALID_PROFILE', 'profile disk requirement overflows the safe integer range');
  const effectiveName = customized ? `${baseName}_CUSTOM` : baseName;
  return Object.freeze({
    ...resolved,
    name: effectiveName,
    requestedProfile: baseName,
    requestedConfig: Object.freeze(requested),
    customized
  });
}

// Industrial-scale evidence is deliberately narrower than release integrity.
// A clean CI/SMALL/MEDIUM/LARGE run can be release-grade for that workload,
// but only the exact immutable INDUSTRIAL workload may claim scale proof.
export function qualifiesIndustrialScale({ result, dirty, profile, requestedProfile } = {}) {
  return result === 'PASS'
    && dirty === false
    && profile === 'INDUSTRIAL'
    && requestedProfile === 'INDUSTRIAL';
}

export function formatProfile(profile) {
  return `${profile.name} rows=${profile.rows} payload=${profile.payloadBytes}B batch=${profile.batchSize} writers=${profile.writers} workers=${profile.workers} cdc=${profile.cdcDurationSeconds}s`;
}
