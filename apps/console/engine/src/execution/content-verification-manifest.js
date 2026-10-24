import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';

const SEED_DOMAIN = 'spool-content-verification-manifest-seed-v1';
const LINK_DOMAIN = 'spool-content-verification-manifest-link-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function requireRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) fail('INVALID_CONTENT_VERIFICATION_RANGE', 'sourceRange is required');
  if (!Number.isSafeInteger(range.start) || range.start < 0 || !Number.isSafeInteger(range.endExclusive) || range.endExclusive < range.start) {
    fail('INVALID_CONTENT_VERIFICATION_RANGE', 'sourceRange must be a non-negative half-open range');
  }
  return { start: range.start, endExclusive: range.endExclusive };
}

function requireVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.level !== 'CONTENT_EXACT') {
    fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'CONTENT_EXACT verification evidence is required');
  }
  if (!HASH.test(value.verificationId ?? '')) fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'verificationId must be canonical sha256');
  if (!['VERIFIED', 'DIFF'].includes(value.status)) fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'verification status must be VERIFIED or DIFF');
  if (!Array.isArray(value.primaryKey) || value.primaryKey.length === 0 || !Array.isArray(value.columns) || value.columns.length === 0) {
    fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'verification primaryKey and columns are required');
  }
  if (!Number.isSafeInteger(value.expected?.rowCount) || value.expected.rowCount < 0 || !HASH.test(value.expected?.rootHash ?? '')) {
    fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'expected verification summary is invalid');
  }
  if (!Number.isSafeInteger(value.actual?.rowCount) || value.actual.rowCount < 0 || !HASH.test(value.actual?.rootHash ?? '')) {
    fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'actual verification summary is invalid');
  }
  const counts = value.diff?.counts;
  if (!counts || ['missing', 'mismatch', 'unexpected'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    fail('INVALID_CONTENT_VERIFICATION_EVIDENCE', 'verification diff counts are invalid');
  }
  return value;
}

export function createContentVerificationAccumulator({ targetReadState } = {}) {
  if (!targetReadState || typeof targetReadState !== 'object' || Array.isArray(targetReadState)) {
    fail('INVALID_CONTENT_VERIFICATION_TARGET_STATE', 'targetReadState is required');
  }
  const state = canonicalClone(targetReadState);
  let rootHash = sha256Canonical(SEED_DOMAIN, state);
  let batchCount = 0;
  let rowCount = 0;
  let nextOffset = 0;
  let primaryKey = null;
  let columns = null;
  const diffCounts = { missing: 0, mismatch: 0, unexpected: 0, total: 0 };

  return Object.freeze({
    add({ sourceRange, verification } = {}) {
      const range = requireRange(sourceRange);
      const proof = requireVerification(verification);
      if (range.start !== nextOffset) {
        fail('CONTENT_VERIFICATION_RANGE_DISCONTINUITY', 'Verification batch ranges must be contiguous and ordered', {
          expectedStart: nextOffset,
          actualStart: range.start
        });
      }
      if (primaryKey === null) {
        primaryKey = canonicalClone(proof.primaryKey);
        columns = canonicalClone(proof.columns);
      } else if (canonicalJson(primaryKey) !== canonicalJson(proof.primaryKey) || canonicalJson(columns) !== canonicalJson(proof.columns)) {
        fail('CONTENT_VERIFICATION_CONTRACT_CHANGED', 'Primary key or verification projection changed between batches');
      }

      const evidence = {
        ordinal: batchCount,
        sourceRange: range,
        verificationId: proof.verificationId,
        status: proof.status,
        expected: { rowCount: proof.expected.rowCount, rootHash: proof.expected.rootHash },
        actual: { rowCount: proof.actual.rowCount, rootHash: proof.actual.rootHash },
        diffCounts: {
          missing: proof.diff.counts.missing,
          mismatch: proof.diff.counts.mismatch,
          unexpected: proof.diff.counts.unexpected
        }
      };
      rootHash = sha256Canonical(LINK_DOMAIN, { previousRootHash: rootHash, evidence });
      batchCount += 1;
      rowCount += proof.expected.rowCount;
      nextOffset = range.endExclusive;
      diffCounts.missing += proof.diff.counts.missing;
      diffCounts.mismatch += proof.diff.counts.mismatch;
      diffCounts.unexpected += proof.diff.counts.unexpected;
      diffCounts.total = diffCounts.missing + diffCounts.mismatch + diffCounts.unexpected;
      return rootHash;
    },
    summary() {
      return Object.freeze({
        schemaVersion: 1,
        level: 'CONTENT_EXACT',
        status: diffCounts.total === 0 ? 'VERIFIED' : 'DIFF',
        targetReadState: Object.freeze(canonicalClone(state)),
        primaryKey: Object.freeze(primaryKey ? [...primaryKey] : []),
        columns: Object.freeze(columns ? [...columns] : []),
        batchCount,
        rowCount,
        sourceRowsCovered: nextOffset,
        diffCounts: Object.freeze({ ...diffCounts }),
        rootHash
      });
    }
  });
}
