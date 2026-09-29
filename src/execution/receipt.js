import { createPrivateKey, createPublicKey } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import { connectorIdentity } from '../platform/contracts.js';
import { publicKeyId, requirePublicKeyId, signCanonical, verifyCanonical } from '../platform/signing.js';

const RECEIPT_DOMAIN = 'spool-migration-receipt-v1';
const REPAIR_RECEIPT_DOMAIN = 'spool-repair-receipt-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function text(name, value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_RECEIPT_INPUT', `${name} must be a non-empty bounded string`);
  return value;
}
function hash(name, value) { text(name, value); if (!HASH.test(value)) fail('INVALID_RECEIPT_INPUT', `${name} must be a canonical sha256 identity`); return value; }
function nonNegative(name, value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RECEIPT_INPUT', `${name} must be a non-negative safe integer`); return value; }
function timestamp(name, value) { text(name, value, 64); const ms = Date.parse(value); if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('INVALID_RECEIPT_INPUT', `${name} must be canonical ISO UTC`); return value; }

function normalizeViolations(items) {
  if (!Array.isArray(items)) fail('INVALID_RECEIPT_INPUT', 'violationsSummary must be an array');
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INVALID_RECEIPT_INPUT', 'Violation summaries must be objects');
    return { code: text('violation code', item.code, 128), count: nonNegative('violation count', item.count) };
  }).sort((a, b) => a.code.localeCompare(b.code));
}

export function createMigrationReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_RECEIPT_INPUT', 'Receipt input must be an object');
  if (!input.release || typeof input.release !== 'object') fail('INVALID_RECEIPT_INPUT', 'Release identity is required');
  const commitSha = text('release commitSha', input.release.commitSha, 40);
  if (!COMMIT.test(commitSha)) fail('INVALID_RECEIPT_INPUT', 'release commitSha must be a 40-character lowercase git SHA');
  if (!input.verification || input.verification.status !== 'VERIFIED') fail('RECEIPT_REQUIRES_VERIFICATION', 'Receipt may only be created for a verified migration');
  if (!Array.isArray(input.batchIdentities)) fail('INVALID_RECEIPT_INPUT', 'batchIdentities must be an array');
  if (!input.counts || typeof input.counts !== 'object' || Array.isArray(input.counts)) fail('INVALID_RECEIPT_INPUT', 'counts are required');

  const record = {
    schemaVersion: 1,
    release: { version: text('release version', input.release.version, 64), commitSha },
    migrationId: text('migrationId', input.migrationId, 128),
    planId: hash('planId', input.planId),
    sourceSnapshotId: hash('sourceSnapshotId', input.sourceSnapshotId),
    targetIdentity: connectorIdentity(input.targetIdentity),
    targetContractId: input.targetContractId == null ? null : hash('targetContractId', input.targetContractId),
    batchIdentities: input.batchIdentities.map(value => hash('batchIdentity', value)),
    counts: {
      sourceRows: nonNegative('sourceRows', input.counts.sourceRows),
      writtenRows: nonNegative('writtenRows', input.counts.writtenRows),
      rejectedRows: nonNegative('rejectedRows', input.counts.rejectedRows),
      filteredRows: nonNegative('filteredRows', input.counts.filteredRows)
    },
    violationsSummary: normalizeViolations(input.violationsSummary),
    verification: JSON.parse(canonicalJson(input.verification)),
    startedAt: timestamp('startedAt', input.startedAt),
    completedAt: timestamp('completedAt', input.completedAt)
  };
  if (input.requestSemanticId != null) record.requestSemanticId = hash('requestSemanticId', input.requestSemanticId);
  if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) fail('INVALID_RECEIPT_INPUT', 'completedAt cannot precede startedAt');
  const canonicalRecord = JSON.parse(canonicalJson(record));
  const receiptId = sha256Canonical(RECEIPT_DOMAIN, canonicalRecord);
  return Object.freeze({ receiptId, record: Object.freeze(canonicalRecord) });
}

function normalizeRepairPlanIds(items) {
  if (!Array.isArray(items) || items.length === 0) fail('INVALID_REPAIR_RECEIPT_INPUT', 'repairPlanIds must be a non-empty array');
  const out = items.map(value => hash('repairPlanId', value));
  const unique = [...new Set(out)].sort();
  if (unique.length !== out.length) fail('INVALID_REPAIR_RECEIPT_INPUT', 'repairPlanIds must be unique');
  return unique;
}

function normalizeRepairCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) fail('INVALID_REPAIR_RECEIPT_INPUT', 'opCounts are required');
  return {
    insert: nonNegative('opCounts.insert', counts.insert),
    update: nonNegative('opCounts.update', counts.update),
    delete: nonNegative('opCounts.delete', counts.delete),
    alreadyApplied: nonNegative('opCounts.alreadyApplied', counts.alreadyApplied)
  };
}

export function createRepairReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REPAIR_RECEIPT_INPUT', 'Repair receipt input must be an object');
  if (!input.release || typeof input.release !== 'object') fail('INVALID_REPAIR_RECEIPT_INPUT', 'Release identity is required');
  const commitSha = text('release commitSha', input.release.commitSha, 40);
  if (!COMMIT.test(commitSha)) fail('INVALID_REPAIR_RECEIPT_INPUT', 'release commitSha must be a 40-character lowercase git SHA');
  if (!input.verification || input.verification.status !== 'VERIFIED') fail('REPAIR_RECEIPT_REQUIRES_REVERIFICATION', 'Repair receipt may only be created after exact re-verification');
  const record = {
    schemaVersion: 1,
    kind: 'repair',
    release: { version: text('release version', input.release.version, 64), commitSha },
    migrationId: text('migrationId', input.migrationId, 128),
    repairApprovalId: hash('repairApprovalId', input.repairApprovalId),
    repairPlanIds: normalizeRepairPlanIds(input.repairPlanIds),
    planId: hash('planId', input.planId),
    sourceSnapshotId: hash('sourceSnapshotId', input.sourceSnapshotId),
    targetIdentity: connectorIdentity(input.targetIdentity),
    targetContractId: input.targetContractId == null ? null : hash('targetContractId', input.targetContractId),
    opCounts: normalizeRepairCounts(input.opCounts),
    verification: JSON.parse(canonicalJson(input.verification)),
    startedAt: timestamp('startedAt', input.startedAt),
    completedAt: timestamp('completedAt', input.completedAt)
  };
  if (input.requestSemanticId != null) record.requestSemanticId = hash('requestSemanticId', input.requestSemanticId);
  if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) fail('INVALID_REPAIR_RECEIPT_INPUT', 'completedAt cannot precede startedAt');
  const canonicalRecord = JSON.parse(canonicalJson(record));
  const receiptId = sha256Canonical(REPAIR_RECEIPT_DOMAIN, canonicalRecord);
  return Object.freeze({ receiptId, record: Object.freeze(canonicalRecord) });
}

const RECEIPT_SIGNATURE_DOMAIN = 'spool-receipt-signature-v1';

// Cryptographic execution evidence: a detached Ed25519 signature over the
// domain-separated canonical {receiptId, record} binding. Key lifecycle:
// keyId IS the SPKI fingerprint (ed25519:fpr:...); verification accepts a
// trust-roots set of {keyId, publicKey} entries so retired keys keep
// verifying old receipts while only active keys sign new ones. Provider
// support is local PEM only — no KMS/HSM is claimed.
export function signReceiptEnvelope({ receipt, privateKey, keyId = null } = {}) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.receiptId !== 'string' || !receipt.record || typeof receipt.record !== 'object') {
    fail('INVALID_RECEIPT_INPUT', 'signReceiptEnvelope requires a {receiptId, record} receipt');
  }
  if (typeof privateKey !== 'string' || !privateKey) fail('INVALID_SIGNING_KEY', 'A PEM private key is required to sign a receipt');
  const parsed = createPrivateKey(privateKey);
  const derived = createPublicKey(parsed).export({ type: 'spki', format: 'pem' });
  const fingerprint = publicKeyId(derived);
  if (keyId != null && requirePublicKeyId(keyId) !== fingerprint) {
    fail('KEY_FINGERPRINT_MISMATCH', 'Claimed keyId does not match the signing key');
  }
  const payload = { receiptId: receipt.receiptId, record: receipt.record };
  const signed = signCanonical(RECEIPT_SIGNATURE_DOMAIN, payload, privateKey);
  return Object.freeze({
    kind: 'spool-signed-receipt-v1',
    receiptId: receipt.receiptId,
    record: receipt.record,
    signature: Object.freeze({
      algorithm: signed.algorithm,
      domain: RECEIPT_SIGNATURE_DOMAIN,
      keyId: fingerprint,
      keyFingerprint: fingerprint,
      signature: signed.signature,
      signedAt: new Date().toISOString()
    })
  });
}

// Offline verification: recompute the content identity from the record,
// then verify the detached signature against the trust roots. No daemon,
// no network, no database. Any semantic tampering (record field, receiptId
// swap, signature, keyId) fails closed.
export function verifySignedReceiptEnvelope(envelope, { trustRoots = [] } = {}) {
  if (!envelope || typeof envelope !== 'object' || envelope.kind !== 'spool-signed-receipt-v1') {
    fail('INVALID_SIGNED_RECEIPT', 'Envelope kind must be spool-signed-receipt-v1');
  }
  if (typeof envelope.receiptId !== 'string' || !envelope.record || typeof envelope.record !== 'object') {
    fail('INVALID_SIGNED_RECEIPT', 'Envelope must carry receiptId and record');
  }
  const signature = envelope.signature;
  if (!signature || typeof signature !== 'object' || signature.domain !== RECEIPT_SIGNATURE_DOMAIN) {
    fail('INVALID_SIGNED_RECEIPT', 'Envelope signature must use the receipt signature domain');
  }
  if (!Array.isArray(trustRoots) || trustRoots.length === 0) fail('RECEIPT_TRUST_ROOTS_REQUIRED', 'Offline verification requires at least one trusted public key');
  // Content identity first: a record edit invalidates the receiptId binding
  // even if the signature somehow verified.
  const domain = envelope.record?.kind === 'repair' ? REPAIR_RECEIPT_DOMAIN : RECEIPT_DOMAIN;
  const recomputed = sha256Canonical(domain, JSON.parse(canonicalJson(envelope.record)));
  if (recomputed !== envelope.receiptId) {
    fail('RECEIPT_IDENTITY_MISMATCH', 'Envelope record does not match its receiptId; the record was modified', {
      recomputed, claimed: envelope.receiptId
    });
  }
  const keyFingerprint = requirePublicKeyId(signature.keyFingerprint ?? signature.keyId);
  const root = trustRoots.find(entry => entry && entry.keyId === keyFingerprint);
  if (!root) fail('RECEIPT_KEY_UNTRUSTED', 'Envelope signing key is not in the trust roots', { keyId: keyFingerprint });
  if (!root.publicKey) fail('RECEIPT_TRUST_ROOTS_REQUIRED', 'Trust root entry must carry its public key');
  const payload = { receiptId: envelope.receiptId, record: envelope.record };
  let authentic = false;
  try {
    authentic = verifyCanonical(RECEIPT_SIGNATURE_DOMAIN, payload, signature.signature, root.publicKey, { keyFingerprint });
  } catch {
    authentic = false;
  }
  if (authentic !== true) fail('RECEIPT_SIGNATURE_INVALID', 'Envelope signature does not verify against the trusted key', { keyId: keyFingerprint });
  return Object.freeze({ authentic: true, receiptId: envelope.receiptId, keyId: keyFingerprint });
}
