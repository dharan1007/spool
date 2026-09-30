import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  DISK_POLICY,
  DISK_POLICY_VERSION,
  assertDiskPreflight,
  checkDiskPreflight,
  classifyDiskHeadroom,
  measureDisk
} from '../scripts/qualify/disk-preflight.js';

const GIB = 1024 ** 3;

test('policy tiers enforce the published free-disk thresholds exactly', () => {
  // < 8 GiB: load/fault/correctness tiers refused; bounded conformance allowed
  // when the safety headroom still holds.
  const lowConformance = classifyDiskHeadroom({ kind: 'conformance', freeBytes: Math.floor(4.94 * GIB), estimatedPeakBytes: 100 * 1024 * 1024 });
  assert.equal(lowConformance.allowed, true, 'bounded conformance smoke must stay possible on a small disk');

  const lowCorrectness = classifyDiskHeadroom({ kind: 'correctness', freeBytes: Math.floor(4.94 * GIB), estimatedPeakBytes: 500 * 1024 * 1024 });
  assert.equal(lowCorrectness.allowed, false);
  assert.equal(lowCorrectness.code, 'DISK_INSUFFICIENT_HEADROOM');

  // Boundary: 8 GiB is the correctness floor.
  const atBoundary = classifyDiskHeadroom({ kind: 'correctness', freeBytes: 8 * GIB, estimatedPeakBytes: 0 });
  assert.equal(atBoundary.allowed, true);
  const belowBoundary = classifyDiskHeadroom({ kind: 'correctness', freeBytes: 8 * GIB - 1, estimatedPeakBytes: 0 });
  assert.equal(belowBoundary.allowed, false);

  // 8-15 GiB: correctness only; pilot refused until 15 GiB.
  const midPilot = classifyDiskHeadroom({ kind: 'pilot', freeBytes: Math.floor(14.99 * GIB), estimatedPeakBytes: 0 });
  assert.equal(midPilot.allowed, false);
  const atPilot = classifyDiskHeadroom({ kind: 'pilot', freeBytes: 15 * GIB, estimatedPeakBytes: 0 });
  assert.equal(atPilot.allowed, true);

  // 15-40 GiB: pilot only; large refused until 40 GiB.
  const midLarge = classifyDiskHeadroom({ kind: 'large', freeBytes: Math.floor(39.99 * GIB), estimatedPeakBytes: 0 });
  assert.equal(midLarge.allowed, false);
  const atLarge = classifyDiskHeadroom({ kind: 'large', freeBytes: 40 * GIB, estimatedPeakBytes: 0 });
  assert.equal(atLarge.allowed, true);
});

test('projected estimate must always preserve the 1 GiB safety headroom, even on a large disk', () => {
  const result = classifyDiskHeadroom({
    kind: 'conformance',
    freeBytes: 100 * GIB,
    estimatedPeakBytes: 100 * GIB - (DISK_POLICY.SAFETY_HEADROOM_BYTES - 1)
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'DISK_INSUFFICIENT_HEADROOM');
  assert.ok(result.projectedFreeBytes < DISK_POLICY.SAFETY_HEADROOM_BYTES);

  const ok = classifyDiskHeadroom({
    kind: 'conformance',
    freeBytes: 100 * GIB,
    estimatedPeakBytes: 100 * GIB - DISK_POLICY.SAFETY_HEADROOM_BYTES
  });
  assert.equal(ok.allowed, true, 'projected free exactly at the headroom floor is allowed');
});

test('classification fails closed on unknown kind, malformed bytes and malformed estimates', () => {
  assert.equal(classifyDiskHeadroom({ kind: 'industrial', freeBytes: 100 * GIB }).code, 'DISK_PREFLIGHT_UNKNOWN_KIND');
  assert.equal(classifyDiskHeadroom({ kind: null, freeBytes: 100 * GIB }).code, 'DISK_PREFLIGHT_UNKNOWN_KIND');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: undefined }).code, 'DISK_UNMEASURABLE');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: -1 }).code, 'DISK_UNMEASURABLE');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: NaN }).code, 'DISK_UNMEASURABLE');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: 100 * GIB, estimatedPeakBytes: -1 }).code, 'DISK_PREFLIGHT_UNKNOWN_ESTIMATE');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: 100 * GIB, estimatedPeakBytes: 1.5 }).code, 'DISK_PREFLIGHT_UNKNOWN_ESTIMATE');
  assert.equal(classifyDiskHeadroom({ kind: 'conformance', freeBytes: 100 * GIB, estimatedPeakBytes: NaN }).code, 'DISK_PREFLIGHT_UNKNOWN_ESTIMATE');
});

test('every refusal carries the policy version and structured evidence fields', () => {
  const result = classifyDiskHeadroom({ kind: 'large', freeBytes: 9 * GIB, estimatedPeakBytes: GIB });
  assert.equal(result.policyVersion, DISK_POLICY_VERSION);
  assert.equal(result.allowed, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 10);
  assert.equal(result.freeBytes, 9 * GIB);
  assert.equal(result.estimatedPeakBytes, GIB);
  assert.equal(result.requiredMinFreeBytes, DISK_POLICY.LARGE_MIN_FREE_BYTES);
});

test('measureDisk reports real filesystem capacity as safe integers', () => {
  const measurement = measureDisk(process.cwd());
  assert.equal(measurement.measurable, true, String(measurement.error));
  assert.ok(Number.isSafeInteger(measurement.freeBytes) && measurement.freeBytes >= 0);
  assert.ok(Number.isSafeInteger(measurement.totalBytes) && measurement.totalBytes > 0);
  assert.ok(measurement.freeBytes <= measurement.totalBytes);
  assert.ok(typeof measurement.measuredAt === 'string');
});

test('checkDiskPreflight measures and classifies in one fail-closed call', () => {
  const result = checkDiskPreflight({ kind: 'conformance', estimatedPeakBytes: 1024 * 1024 });
  assert.equal(result.policyVersion, DISK_POLICY_VERSION);
  assert.ok(['DISK_PREFLIGHT_OK', 'DISK_INSUFFICIENT_HEADROOM', 'DISK_UNMEASURABLE'].includes(result.code));
  if (result.allowed) {
    assert.ok(result.measurement.measurable === true);
    assert.ok(result.projectedFreeBytes >= DISK_POLICY.SAFETY_HEADROOM_BYTES);
  }
});

test('assertDiskPreflight refuses an unmeasurable path with DISK_PREFLIGHT_FAILED', () => {
  const missing = join(process.cwd(), '__spool_disk_preflight_missing_dir__');
  assert.throws(
    () => assertDiskPreflight({ kind: 'conformance', path: missing }),
    error => error?.code === 'DISK_PREFLIGHT_FAILED' && /cannot be measured|DISK_UNMEASURABLE|ENOENT|statfs/i.test(String(error?.message) + JSON.stringify(error?.details ?? {}))
  );
});

test('assertDiskPreflight returns the classification when allowed', () => {
  const measurement = measureDisk(process.cwd());
  if (!measurement.measurable || measurement.freeBytes < 2 * GIB) {
    // Deterministic fallback: never assert success on a disk that cannot pass.
    return;
  }
  const result = assertDiskPreflight({ kind: 'conformance', estimatedPeakBytes: 1024 * 1024 });
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'DISK_PREFLIGHT_OK');
});
