import { sha256Canonical } from '../platform/canonical-json.js';

export const SVMP_PROTOCOL = Object.freeze({
  name: 'SPOOL Verified Mutation Protocol',
  shortName: 'SVMP',
  version: 1
});

export const SVMP_STATES = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  SNAPSHOTTED: 'SNAPSHOTTED',
  PLANNED: 'PLANNED',
  VALIDATED: 'VALIDATED',
  AUTHORIZED: 'AUTHORIZED',
  EXECUTING: 'EXECUTING',
  RECONCILING: 'RECONCILING',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  SOURCE_DRIFT: 'SOURCE_DRIFT',
  TARGET_DRIFT: 'TARGET_DRIFT',
  AUTHORITY_EXPIRED: 'AUTHORITY_EXPIRED',
  LEASE_LOST: 'LEASE_LOST',
  COMMIT_UNKNOWN: 'COMMIT_UNKNOWN',
  RECONCILIATION_CONFLICT: 'RECONCILIATION_CONFLICT',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  COMPENSATION_REQUIRED: 'COMPENSATION_REQUIRED'
});

export const SVMP_SUCCESS_PATH = Object.freeze([
  SVMP_STATES.DISCOVERED,
  SVMP_STATES.SNAPSHOTTED,
  SVMP_STATES.PLANNED,
  SVMP_STATES.VALIDATED,
  SVMP_STATES.AUTHORIZED,
  SVMP_STATES.EXECUTING,
  SVMP_STATES.RECONCILING,
  SVMP_STATES.VERIFYING,
  SVMP_STATES.VERIFIED
]);

export const SVMP_EXCEPTION_STATES = Object.freeze([
  SVMP_STATES.SOURCE_DRIFT,
  SVMP_STATES.TARGET_DRIFT,
  SVMP_STATES.AUTHORITY_EXPIRED,
  SVMP_STATES.LEASE_LOST,
  SVMP_STATES.COMMIT_UNKNOWN,
  SVMP_STATES.RECONCILIATION_CONFLICT,
  SVMP_STATES.VERIFICATION_FAILED,
  SVMP_STATES.COMPENSATION_REQUIRED
]);

export const SVMP_SEMANTICS = Object.freeze({
  authorized: 'A mutation is authorized only when the exact bound authority remains valid for the current source state, plan, target state, requested effects, limits, principal, policy decision, environment, and execution boundary.',
  committed: 'A mutation is committed only when durability of the exact external effect is proven by authoritative target-native evidence; a successful client response or missing error is never sufficient proof by itself.',
  idempotent: 'A mutation is idempotent when replay of the same immutable mutation identity cannot create a second distinct external effect, while reuse of that identity with conflicting semantics fails closed.',
  reconciled: 'A mutation is reconciled when authoritative target evidence resolves an uncertain execution outcome for the exact mutation identity; conflicting or insufficient evidence remains unresolved and is never treated as success.',
  verified: 'A mutation is verified only after every verification obligation bound into the approved plan has completed against the resulting target state and durable evidence, with all required invariants satisfied.'
});

const ALL_STATES = new Set(Object.values(SVMP_STATES));
const EXCEPTION_SET = new Set(SVMP_EXCEPTION_STATES);
const HASH_ID = /^sha256:[a-f0-9]{64}$/;
const IDENTITY_DOMAIN = 'spool-svmp-identity-set-v1';
const IDENTITY_FIELDS = Object.freeze([
  'sourceStateId',
  'planId',
  'targetStateId',
  'authorityId',
  'executionId',
  'evidenceId',
  'verificationId',
  'receiptId'
]);
const IDENTITY_FIELD_SET = new Set(IDENTITY_FIELDS);

const transitions = new Map();
function allow(from, ...to) {
  transitions.set(from, new Set(to));
}

for (let index = 0; index < SVMP_SUCCESS_PATH.length - 1; index += 1) {
  allow(SVMP_SUCCESS_PATH[index], SVMP_SUCCESS_PATH[index + 1]);
}

transitions.get(SVMP_STATES.DISCOVERED).add(SVMP_STATES.SOURCE_DRIFT);
transitions.get(SVMP_STATES.SNAPSHOTTED).add(SVMP_STATES.SOURCE_DRIFT);
for (const state of [SVMP_STATES.PLANNED, SVMP_STATES.VALIDATED]) {
  transitions.get(state).add(SVMP_STATES.SOURCE_DRIFT);
  transitions.get(state).add(SVMP_STATES.TARGET_DRIFT);
}
for (const state of [SVMP_STATES.AUTHORIZED, SVMP_STATES.EXECUTING]) {
  transitions.get(state).add(SVMP_STATES.SOURCE_DRIFT);
  transitions.get(state).add(SVMP_STATES.TARGET_DRIFT);
  transitions.get(state).add(SVMP_STATES.AUTHORITY_EXPIRED);
}
transitions.get(SVMP_STATES.EXECUTING).add(SVMP_STATES.LEASE_LOST);
transitions.get(SVMP_STATES.EXECUTING).add(SVMP_STATES.COMMIT_UNKNOWN);
transitions.get(SVMP_STATES.EXECUTING).add(SVMP_STATES.RECONCILIATION_CONFLICT);
transitions.get(SVMP_STATES.RECONCILING).add(SVMP_STATES.LEASE_LOST);
transitions.get(SVMP_STATES.RECONCILING).add(SVMP_STATES.COMMIT_UNKNOWN);
transitions.get(SVMP_STATES.RECONCILING).add(SVMP_STATES.RECONCILIATION_CONFLICT);
transitions.get(SVMP_STATES.VERIFYING).add(SVMP_STATES.VERIFICATION_FAILED);
transitions.get(SVMP_STATES.VERIFYING).add(SVMP_STATES.COMPENSATION_REQUIRED);
allow(SVMP_STATES.COMMIT_UNKNOWN, SVMP_STATES.RECONCILING);
allow(SVMP_STATES.VERIFICATION_FAILED, SVMP_STATES.COMPENSATION_REQUIRED);
for (const state of SVMP_EXCEPTION_STATES) {
  if (!transitions.has(state)) allow(state);
}
allow(SVMP_STATES.VERIFIED);

function protocolError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireKnownState(state, field) {
  if (!ALL_STATES.has(state)) {
    throw protocolError('SVMP_UNKNOWN_STATE', `${field} is not a known SVMP state`, { field, state });
  }
}

export function assertSvmpTransition(from, to) {
  requireKnownState(from, 'from');
  requireKnownState(to, 'to');
  if (!transitions.get(from)?.has(to)) {
    throw protocolError('SVMP_INVALID_TRANSITION', `${from} -> ${to} is not allowed by SVMP v${SVMP_PROTOCOL.version}`, { from, to });
  }
  return true;
}

export function listSvmpTransitions(state) {
  requireKnownState(state, 'state');
  return Object.freeze([...transitions.get(state)].sort());
}

export function isSvmpExceptionState(state) {
  requireKnownState(state, 'state');
  return EXCEPTION_SET.has(state);
}

function requirePlainDataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('SVMP_INVALID_IDENTITY', 'SVMP identity input must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError('SVMP_INVALID_IDENTITY', 'SVMP identity input must use a plain-object prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw protocolError('SVMP_INVALID_IDENTITY', `SVMP identity field ${key} must be inert data, not an accessor`);
    }
  }
}

export function createSvmpIdentitySet(input) {
  requirePlainDataObject(input);
  for (const key of Object.keys(input)) {
    if (!IDENTITY_FIELD_SET.has(key)) {
      throw protocolError('SVMP_UNKNOWN_IDENTITY_FIELD', `Unknown SVMP identity field ${key}`, { field: key });
    }
  }

  const identities = {};
  for (const field of IDENTITY_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || !HASH_ID.test(value)) {
      throw protocolError('SVMP_INVALID_IDENTITY', `${field} must be a canonical sha256 identity`, { field });
    }
    identities[field] = value;
  }
  Object.freeze(identities);

  const identityRecord = {
    schemaVersion: 1,
    protocol: SVMP_PROTOCOL.shortName,
    protocolVersion: SVMP_PROTOCOL.version,
    identities
  };
  const identitySetId = sha256Canonical(IDENTITY_DOMAIN, identityRecord);
  return Object.freeze({
    schemaVersion: 1,
    protocol: SVMP_PROTOCOL.shortName,
    protocolVersion: SVMP_PROTOCOL.version,
    identitySetId,
    identities
  });
}
