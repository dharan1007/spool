import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from './canonical-json.js';
import { connectorIdentity } from './contracts.js';

const REPAIR_APPROVAL_DOMAIN = 'spool-repair-approval-v1';
const REPAIR_SIGNATURE_DOMAIN = 'spool-repair-approval-signature-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(name, value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_REPAIR_APPROVAL_BINDING', `${name} must be a non-empty bounded string`);
  return value;
}

function hash(name, value) {
  text(name, value);
  if (!HASH.test(value)) fail('INVALID_REPAIR_APPROVAL_BINDING', `${name} must be a canonical sha256 identity`);
  return value;
}

function normalizeRepairPlanIds(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_REPAIR_APPROVAL_BINDING', 'repairPlanIds must be a non-empty array');
  const out = value.map(item => hash('repairPlanId', item));
  const unique = [...new Set(out)].sort();
  if (unique.length !== out.length) fail('INVALID_REPAIR_APPROVAL_BINDING', 'repairPlanIds must be unique');
  return unique;
}

function normalizeEffects(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_REPAIR_APPROVAL_BINDING', 'effects must be a non-empty array');
  const out = [];
  for (const item of value) {
    const effect = text('effect', item, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(effect)) fail('INVALID_REPAIR_APPROVAL_BINDING', `Invalid effect ${effect}`);
    if (!out.includes(effect)) out.push(effect);
  }
  return out.sort();
}

function normalizeExpiry(value) {
  text('expiresAt', value, 64);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('INVALID_REPAIR_APPROVAL_BINDING', 'expiresAt must be an ISO-compatible timestamp');
  const iso = new Date(ms).toISOString();
  if (iso !== value) fail('INVALID_REPAIR_APPROVAL_BINDING', 'expiresAt must use canonical ISO UTC format');
  return iso;
}

export function buildRepairApprovalRecord(binding = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('INVALID_REPAIR_APPROVAL_BINDING', 'Repair approval binding must be an object');
  if (binding.kind !== undefined && binding.kind !== 'repair') fail('INVALID_REPAIR_APPROVAL_BINDING', 'Repair approval kind must be repair');
  if (!MIGRATION_ID.test(binding.migrationId ?? '')) fail('INVALID_REPAIR_APPROVAL_BINDING', 'migrationId is invalid');
  return {
    schemaVersion: 1,
    kind: 'repair',
    migrationId: binding.migrationId,
    repairPlanIds: normalizeRepairPlanIds(binding.repairPlanIds),
    planId: hash('planId', binding.planId),
    sourceSnapshotId: hash('sourceSnapshotId', binding.sourceSnapshotId),
    targetIdentity: connectorIdentity(binding.targetIdentity),
    targetContractId: binding.targetContractId == null ? null : hash('targetContractId', binding.targetContractId),
    effects: normalizeEffects(binding.effects),
    principal: text('principal', binding.principal, 256),
    expiresAt: normalizeExpiry(binding.expiresAt),
    nonce: text('nonce', binding.nonce, 256)
  };
}

function signingBytes(signingKey) {
  if (!(typeof signingKey === 'string' || Buffer.isBuffer(signingKey) || signingKey instanceof Uint8Array)) {
    fail('INVALID_REPAIR_APPROVAL_SIGNING_KEY', 'Repair approval signing key must be bytes or string');
  }
  const bytes = Buffer.from(signingKey);
  if (bytes.length < 16) fail('INVALID_REPAIR_APPROVAL_SIGNING_KEY', 'Repair approval signing key must be at least 16 bytes');
  return bytes;
}

function signatureFor(record, signingKey) {
  const digest = createHmac('sha256', signingBytes(signingKey))
    .update(`SPOOL\0${REPAIR_SIGNATURE_DOMAIN}\0`, 'utf8')
    .update(canonicalJson(record), 'utf8')
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function safeEqualSignature(expected, actual) {
  if (!SIGNATURE.test(expected) || !SIGNATURE.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

export function createRepairApproval(binding, { signingKey } = {}) {
  const record = buildRepairApprovalRecord(binding);
  const approvalId = sha256Canonical(REPAIR_APPROVAL_DOMAIN, record);
  const signature = signatureFor(record, signingKey);
  return deepFreeze({ schemaVersion: 1, kind: 'repair', approvalId, signature, record });
}

export function assertRepairApproval(approval, currentBinding, { signingKey, now = new Date().toISOString() } = {}) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval) || approval.schemaVersion !== 1 || approval.kind !== 'repair') {
    fail('INVALID_REPAIR_APPROVAL', 'Repair approval envelope is invalid: a separately-authorized repair approval is required');
  }
  if (!HASH.test(approval.approvalId ?? '') || !SIGNATURE.test(approval.signature ?? '')) fail('INVALID_REPAIR_APPROVAL', 'Repair approval identity/signature is invalid');
  const expectedSignature = signatureFor(approval.record, signingKey);
  if (!safeEqualSignature(expectedSignature, approval.signature)) fail('REPAIR_APPROVAL_SIGNATURE_INVALID', 'Repair approval evidence signature does not verify');
  if (sha256Canonical(REPAIR_APPROVAL_DOMAIN, approval.record) !== approval.approvalId) fail('REPAIR_APPROVAL_ID_INVALID', 'Repair approval identity does not match its record');

  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('INVALID_REPAIR_APPROVAL_TIME', 'Current repair approval time is invalid');
  if (Date.parse(approval.record.expiresAt) < nowMs) fail('REPAIR_APPROVAL_EXPIRED', 'Repair approval has expired');

  const expectedRecord = buildRepairApprovalRecord(currentBinding);
  if (canonicalJson(expectedRecord) !== canonicalJson(approval.record)) {
    fail('REPAIR_APPROVAL_BINDING_MISMATCH', 'Repair approval is not bound to the current repair semantics');
  }
  return true;
}
