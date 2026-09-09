import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from './canonical-json.js';
import { connectorIdentity } from './contracts.js';

const APPROVAL_DOMAIN = 'spool-approval-v1';
const SIGNATURE_DOMAIN = 'spool-approval-signature-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(name, value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_APPROVAL_BINDING', `${name} must be a non-empty bounded string`);
  return value;
}

function hash(name, value) {
  text(name, value);
  if (!HASH.test(value)) fail('INVALID_APPROVAL_BINDING', `${name} must be a canonical sha256 identity`);
  return value;
}

function normalizeEffects(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_APPROVAL_BINDING', 'effects must be a non-empty array');
  const out = [];
  for (const item of value) {
    const effect = text('effect', item, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(effect)) fail('INVALID_APPROVAL_BINDING', `Invalid effect ${effect}`);
    if (!out.includes(effect)) out.push(effect);
  }
  return out.sort();
}

function normalizeStrategy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_APPROVAL_BINDING', 'writeStrategy must be an object');
  return JSON.parse(canonicalJson(value));
}

function normalizeExpiry(value) {
  text('expiresAt', value, 64);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('INVALID_APPROVAL_BINDING', 'expiresAt must be an ISO-compatible timestamp');
  const iso = new Date(ms).toISOString();
  if (iso !== value) fail('INVALID_APPROVAL_BINDING', 'expiresAt must use canonical ISO UTC format');
  return iso;
}

export function buildApprovalRecord(binding = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('INVALID_APPROVAL_BINDING', 'Approval binding must be an object');
  if (!Number.isInteger(binding.planRevision) || binding.planRevision < 1) fail('INVALID_APPROVAL_BINDING', 'planRevision must be >= 1');
  return {
    schemaVersion: 1,
    migrationId: text('migrationId', binding.migrationId, 128),
    planId: hash('planId', binding.planId),
    planRevision: binding.planRevision,
    sourceSnapshotId: hash('sourceSnapshotId', binding.sourceSnapshotId),
    targetIdentity: connectorIdentity(binding.targetIdentity),
    effects: normalizeEffects(binding.effects),
    writeStrategy: normalizeStrategy(binding.writeStrategy),
    principal: text('principal', binding.principal, 256),
    expiresAt: normalizeExpiry(binding.expiresAt),
    nonce: text('nonce', binding.nonce, 256)
  };
}

function signingBytes(signingKey) {
  if (!(typeof signingKey === 'string' || Buffer.isBuffer(signingKey) || signingKey instanceof Uint8Array)) {
    fail('INVALID_APPROVAL_SIGNING_KEY', 'Approval signing key must be bytes or string');
  }
  const bytes = Buffer.from(signingKey);
  if (bytes.length < 16) fail('INVALID_APPROVAL_SIGNING_KEY', 'Approval signing key must be at least 16 bytes');
  return bytes;
}

function signatureFor(record, signingKey) {
  const digest = createHmac('sha256', signingBytes(signingKey))
    .update(`SPOOL\0${SIGNATURE_DOMAIN}\0`, 'utf8')
    .update(canonicalJson(record), 'utf8')
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function safeEqualSignature(expected, actual) {
  if (!SIGNATURE.test(expected) || !SIGNATURE.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

export function createBoundApproval(binding, { signingKey } = {}) {
  const record = buildApprovalRecord(binding);
  const approvalId = sha256Canonical(APPROVAL_DOMAIN, record);
  const signature = signatureFor(record, signingKey);
  return deepFreeze({ schemaVersion: 1, approvalId, signature, record });
}

export function assertBoundApproval(approval, currentBinding, { signingKey, now = new Date().toISOString() } = {}) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval) || approval.schemaVersion !== 1) {
    fail('INVALID_APPROVAL', 'Bound approval envelope is invalid');
  }
  if (!HASH.test(approval.approvalId ?? '') || !SIGNATURE.test(approval.signature ?? '')) fail('INVALID_APPROVAL', 'Bound approval identity/signature is invalid');
  const expectedSignature = signatureFor(approval.record, signingKey);
  if (!safeEqualSignature(expectedSignature, approval.signature)) fail('APPROVAL_SIGNATURE_INVALID', 'Approval evidence signature does not verify');
  if (sha256Canonical(APPROVAL_DOMAIN, approval.record) !== approval.approvalId) fail('APPROVAL_ID_INVALID', 'Approval identity does not match its record');

  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('INVALID_APPROVAL_TIME', 'Current approval time is invalid');
  if (Date.parse(approval.record.expiresAt) < nowMs) fail('APPROVAL_EXPIRED', 'Approval has expired');

  const expectedRecord = buildApprovalRecord(currentBinding);
  if (canonicalJson(expectedRecord) !== canonicalJson(approval.record)) {
    fail('APPROVAL_BINDING_MISMATCH', 'Approval is not bound to the current migration semantics');
  }
  return true;
}
