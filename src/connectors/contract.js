import { fail } from '../core/errors.js';

const CONNECTOR_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const ROLES = new Set(['source', 'target']);
export const CONNECTOR_ASSURANCE_LEVELS = Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
const ASSURANCE_INDEX = new Map(CONNECTOR_ASSURANCE_LEVELS.map((level, index) => [level, index]));

const CAPABILITIES = new Set([
  'streaming',
  'transactions',
  'atomicBatchLedger',
  'reconcileAfterCrash',
  'idempotentReplay',
  'snapshotBinding',
  'fencing',
  'readOnlySnapshot',
  'targetContractBinding',
  'exactCommitEvidence',
  'readAfterWriteVerification',
  'continuousChangeCapture'
]);

export const CONNECTOR_ASSURANCE_SEMANTICS = Object.freeze({
  C0: 'Discovery/read-only capability without deterministic mutation guarantees',
  C1: 'Deterministic source snapshot identity',
  C2: 'Validated target mutation bound to a target contract',
  C3: 'Idempotent and reconcilable target writes',
  C4: 'Transaction-bound commit evidence with target-enforced fencing',
  C5: 'Full verified mutation including read-after-write verification',
  C6: 'Continuous/CDC verified mutation semantics'
});

function plainObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function requireLevel(level) {
  if (!ASSURANCE_INDEX.has(level)) fail('INVALID_CONNECTOR_ASSURANCE', `Unsupported connector assurance level ${String(level)}`);
  return level;
}

export function validateConnectorCapabilities(input = {}) {
  plainObject(input, 'INVALID_CONNECTOR_CAPABILITIES', 'Connector capabilities');
  const out = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (!CAPABILITIES.has(key)) fail('INVALID_CONNECTOR_CAPABILITY', `Unsupported connector capability ${key}`);
    if (typeof value !== 'boolean') fail('INVALID_CONNECTOR_CAPABILITY', `Connector capability ${key} must be boolean`);
    out[key] = value;
  }
  for (const key of CAPABILITIES) if (!Object.hasOwn(out, key)) out[key] = false;
  return Object.freeze({ ...out });
}

function requireCapabilities(capabilities, required, level) {
  for (const capability of required) {
    if (capabilities[capability] !== true) {
      fail('CONNECTOR_ASSURANCE_OVERCLAIM', `${level} requires connector capability ${capability}`, { level, capability });
    }
  }
}

export function validateConnectorAssurance(input = { level: 'C0' }, role, capabilities) {
  plainObject(input, 'INVALID_CONNECTOR_ASSURANCE', 'Connector assurance');
  const unknown = Object.keys(input).filter(key => !['level'].includes(key));
  if (unknown.length) fail('INVALID_CONNECTOR_ASSURANCE', `Unsupported connector assurance field ${unknown[0]}`);
  const level = requireLevel(input.level ?? 'C0');

  if (role === 'source') {
    if (level === 'C1') requireCapabilities(capabilities, ['snapshotBinding', 'readOnlySnapshot'], level);
    else if (level === 'C6') requireCapabilities(capabilities, ['snapshotBinding', 'readOnlySnapshot', 'continuousChangeCapture'], level);
    else if (level !== 'C0') fail('CONNECTOR_ASSURANCE_ROLE_MISMATCH', `Source connectors cannot claim ${level}; use C1 for snapshots or C6 for CDC`);
  } else if (role === 'target') {
    if (level === 'C1') fail('CONNECTOR_ASSURANCE_ROLE_MISMATCH', 'Target connectors cannot claim source-snapshot level C1');
    if (ASSURANCE_INDEX.get(level) >= ASSURANCE_INDEX.get('C2')) requireCapabilities(capabilities, ['targetContractBinding'], level);
    if (ASSURANCE_INDEX.get(level) >= ASSURANCE_INDEX.get('C3')) requireCapabilities(capabilities, ['idempotentReplay', 'reconcileAfterCrash'], level);
    if (ASSURANCE_INDEX.get(level) >= ASSURANCE_INDEX.get('C4')) requireCapabilities(capabilities, ['transactions', 'atomicBatchLedger', 'fencing', 'exactCommitEvidence'], level);
    if (ASSURANCE_INDEX.get(level) >= ASSURANCE_INDEX.get('C5')) requireCapabilities(capabilities, ['readAfterWriteVerification'], level);
    if (level === 'C6') requireCapabilities(capabilities, ['continuousChangeCapture'], level);
  }

  return Object.freeze({ level, semantics: CONNECTOR_ASSURANCE_SEMANTICS[level] });
}

export function validateConnectorDescriptor(input) {
  plainObject(input, 'INVALID_CONNECTOR_DESCRIPTOR', 'Connector descriptor');
  const unknown = Object.keys(input).filter(key => !['name', 'role', 'version', 'capabilities', 'assurance'].includes(key));
  if (unknown.length) fail('INVALID_CONNECTOR_DESCRIPTOR', `Unsupported connector descriptor field ${unknown[0]}`);
  if (!CONNECTOR_NAME.test(input.name ?? '')) fail('INVALID_CONNECTOR_NAME', 'Connector name is invalid');
  if (!ROLES.has(input.role)) fail('INVALID_CONNECTOR_ROLE', `Unsupported connector role ${input.role}`);
  if (!Number.isInteger(input.version) || input.version < 1) fail('INVALID_CONNECTOR_VERSION', 'Connector version must be a positive integer');
  const capabilities = validateConnectorCapabilities(input.capabilities ?? {});
  const assurance = validateConnectorAssurance(input.assurance ?? { level: 'C0' }, input.role, capabilities);
  return deepFreeze({ name: input.name, role: input.role, version: input.version, capabilities, assurance });
}

export function assertCapability(descriptor, capability) {
  const validated = validateConnectorDescriptor(descriptor);
  if (!CAPABILITIES.has(capability)) fail('INVALID_CONNECTOR_CAPABILITY', `Unknown connector capability ${capability}`);
  if (validated.capabilities[capability] !== true) fail('CONNECTOR_CAPABILITY_REQUIRED', `Connector ${validated.name} does not provide ${capability}`);
  return true;
}

export function assertAssuranceLevel(descriptor, minimumLevel) {
  const validated = validateConnectorDescriptor(descriptor);
  const required = requireLevel(minimumLevel);
  if (ASSURANCE_INDEX.get(validated.assurance.level) < ASSURANCE_INDEX.get(required)) {
    fail('CONNECTOR_ASSURANCE_REQUIRED', `Connector ${validated.name} provides ${validated.assurance.level} but ${required} is required`, {
      connector: validated.name,
      provided: validated.assurance.level,
      required
    });
  }
  return true;
}

export function deriveMutationAssurance({ source, target, protocolVerified = false } = {}) {
  const sourceDescriptor = validateConnectorDescriptor(source);
  const targetDescriptor = validateConnectorDescriptor(target);
  if (sourceDescriptor.role !== 'source' || targetDescriptor.role !== 'target') fail('INVALID_MUTATION_ASSURANCE_INPUT', 'Mutation assurance requires source and target descriptors');
  const sourceLevel = sourceDescriptor.assurance.level;
  const targetLevel = targetDescriptor.assurance.level;
  if (!['C1', 'C6'].includes(sourceLevel) || ASSURANCE_INDEX.get(targetLevel) < ASSURANCE_INDEX.get('C2')) return 'C0';
  if (targetLevel === 'C2') return 'C2';
  if (targetLevel === 'C3') return 'C3';
  if (targetLevel === 'C4') return protocolVerified ? 'C5' : 'C4';
  if (targetLevel === 'C5') return protocolVerified ? 'C5' : 'C4';
  if (targetLevel === 'C6') return protocolVerified && sourceLevel === 'C6' ? 'C6' : 'C5';
  return 'C0';
}
