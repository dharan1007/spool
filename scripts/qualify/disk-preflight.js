import { statfsSync } from 'node:fs';
import { fail } from '../../src/core/errors.js';

// Reusable disk preflight for qualification and load work. Policy is a hard
// qualification constraint, not a best-effort warning: an environment that
// cannot demonstrate headroom must refuse the workload instead of risking a
// host-disk PANIC or silently downsizing a class.
//
// spool-disk-preflight-v1 policy (2026-09-30):
//   < 8 GiB free   : refuse live PostgreSQL load/fault qualification that can
//                    materially expand storage; bounded conformance smoke is
//                    allowed only with an explicit small peak estimate.
//   8-15 GiB free  : bounded correctness-sized workloads only.
//   15-40 GiB free : bounded pilot workloads only, with explicit ceilings.
//   >= 40 GiB free : larger workloads subject to measured per-test estimates.
// Every classification additionally requires projected free bytes after the
// caller's estimate to stay above the safety headroom floor.

export const DISK_POLICY_VERSION = 'spool-disk-preflight-v1';
export const DISK_POLICY = Object.freeze({
  SAFETY_HEADROOM_BYTES: 1024 ** 3,          // always keep >= 1 GiB free
  CORRECTNESS_MIN_FREE_BYTES: 8 * 1024 ** 3, // correctness/load-fault tier
  PILOT_MIN_FREE_BYTES: 15 * 1024 ** 3,      // pilot tier
  LARGE_MIN_FREE_BYTES: 40 * 1024 ** 3,      // larger tiers
  ALLOWED_KINDS: Object.freeze(['conformance', 'correctness', 'pilot', 'large'])
});

const GIB = 1024 ** 3;

export function measureDisk(path = process.cwd()) {
  let stats;
  try {
    stats = statfsSync(path);
  } catch (error) {
    return { measurable: false, path, error: String(error?.message ?? error) };
  }
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0 || !Number.isSafeInteger(totalBytes)) {
    return { measurable: false, path, error: 'statfs returned non-numeric capacity' };
  }
  return {
    measurable: true,
    measuredAt: new Date().toISOString(),
    path,
    freeBytes,
    totalBytes,
    freeGiB: Number((freeBytes / GIB).toFixed(2))
  };
}

// Pure policy classification. Fail-closed: any malformed input refuses.
export function classifyDiskHeadroom({
  kind,
  freeBytes,
  estimatedPeakBytes = 0,
  measurement = null
} = {}) {
  const base = {
    policyVersion: DISK_POLICY_VERSION,
    kind: kind ?? null,
    freeBytes: freeBytes ?? null,
    estimatedPeakBytes: estimatedPeakBytes ?? null,
    allowed: false
  };

  if (!DISK_POLICY.ALLOWED_KINDS.includes(kind)) {
    return Object.freeze({ ...base, code: 'DISK_PREFLIGHT_UNKNOWN_KIND', reason: `Unknown workload kind '${String(kind)}'; refusing (fail closed)` });
  }
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
    return Object.freeze({ ...base, code: 'DISK_UNMEASURABLE', reason: 'Free disk bytes are missing or non-numeric; refusing (fail closed)' });
  }
  if (!Number.isSafeInteger(estimatedPeakBytes) || estimatedPeakBytes < 0) {
    return Object.freeze({ ...base, code: 'DISK_PREFLIGHT_UNKNOWN_ESTIMATE', reason: 'estimatedPeakBytes must be a non-negative safe integer; refusing (fail closed)' });
  }

  const projectedFreeBytes = freeBytes - estimatedPeakBytes;
  const safetyHeadroomBytes = DISK_POLICY.SAFETY_HEADROOM_BYTES;
  const shared = {
    ...base,
    measurement,
    projectedFreeBytes,
    safetyHeadroomBytes,
    requiredMinFreeBytes: null
  };

  if (projectedFreeBytes < safetyHeadroomBytes) {
    return Object.freeze({
      ...shared,
      code: 'DISK_INSUFFICIENT_HEADROOM',
      reason: `Projected free ${(projectedFreeBytes / GIB).toFixed(2)} GiB after an estimated ${(estimatedPeakBytes / GIB).toFixed(2)} GiB peak is below the ${(safetyHeadroomBytes / GIB).toFixed(2)} GiB safety headroom`
    });
  }

  const requiredMinFreeBytes = kind === 'correctness'
    ? DISK_POLICY.CORRECTNESS_MIN_FREE_BYTES
    : kind === 'pilot'
      ? DISK_POLICY.PILOT_MIN_FREE_BYTES
      : kind === 'large'
        ? DISK_POLICY.LARGE_MIN_FREE_BYTES
        : null; // 'conformance' has no tier floor beyond the headroom rule

  if (requiredMinFreeBytes !== null && freeBytes < requiredMinFreeBytes) {
    return Object.freeze({
      ...shared,
      requiredMinFreeBytes,
      code: 'DISK_INSUFFICIENT_HEADROOM',
      reason: `Free ${(freeBytes / GIB).toFixed(2)} GiB is below the ${(requiredMinFreeBytes / GIB).toFixed(0)} GiB minimum for '${kind}' workloads`
    });
  }

  return Object.freeze({
    ...shared,
    requiredMinFreeBytes,
    allowed: true,
    code: 'DISK_PREFLIGHT_OK',
    reason: `Free ${(freeBytes / GIB).toFixed(2)} GiB, projected ${(projectedFreeBytes / GIB).toFixed(2)} GiB after estimate, satisfies '${kind}' policy`
  });
}

// Measure + classify in one call. Does NOT throw; callers decide.
export function checkDiskPreflight({ kind, estimatedPeakBytes = 0, path = process.cwd() } = {}) {
  const measurement = measureDisk(path);
  if (!measurement.measurable) {
    return Object.freeze({
      policyVersion: DISK_POLICY_VERSION,
      kind: kind ?? null,
      allowed: false,
      code: 'DISK_UNMEASURABLE',
      reason: `Disk headroom cannot be measured at ${path}: ${measurement.error}`,
      measurement
    });
  }
  return classifyDiskHeadroom({
    kind,
    freeBytes: measurement.freeBytes,
    estimatedPeakBytes,
    measurement
  });
}

// Throwing wrapper for harnesses that must fail closed.
export function assertDiskPreflight(options = {}) {
  const result = checkDiskPreflight(options);
  if (!result.allowed) {
    fail('DISK_PREFLIGHT_FAILED', result.reason, {
      code: result.code,
      policyVersion: result.policyVersion,
      kind: result.kind ?? null,
      freeBytes: result.freeBytes ?? result.measurement?.freeBytes ?? null,
      estimatedPeakBytes: result.estimatedPeakBytes ?? null
    });
  }
  return result;
}
