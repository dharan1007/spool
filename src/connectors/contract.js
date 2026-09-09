import { fail } from '../core/errors.js';

const CONNECTOR_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const ROLES = new Set(['source', 'target']);
const CAPABILITIES = new Set([
  'streaming',
  'transactions',
  'atomicBatchLedger',
  'reconcileAfterCrash',
  'idempotentReplay',
  'snapshotBinding',
  'fencing',
  'readOnlySnapshot'
]);

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

export function validateConnectorDescriptor(input) {
  plainObject(input, 'INVALID_CONNECTOR_DESCRIPTOR', 'Connector descriptor');
  const unknown = Object.keys(input).filter(key => !['name', 'role', 'version', 'capabilities'].includes(key));
  if (unknown.length) fail('INVALID_CONNECTOR_DESCRIPTOR', `Unsupported connector descriptor field ${unknown[0]}`);
  if (!CONNECTOR_NAME.test(input.name ?? '')) fail('INVALID_CONNECTOR_NAME', 'Connector name is invalid');
  if (!ROLES.has(input.role)) fail('INVALID_CONNECTOR_ROLE', `Unsupported connector role ${input.role}`);
  if (!Number.isInteger(input.version) || input.version < 1) fail('INVALID_CONNECTOR_VERSION', 'Connector version must be a positive integer');
  return deepFreeze({
    name: input.name,
    role: input.role,
    version: input.version,
    capabilities: validateConnectorCapabilities(input.capabilities ?? {})
  });
}

export function assertCapability(descriptor, capability) {
  const validated = validateConnectorDescriptor(descriptor);
  if (!CAPABILITIES.has(capability)) fail('INVALID_CONNECTOR_CAPABILITY', `Unknown connector capability ${capability}`);
  if (validated.capabilities[capability] !== true) fail('CONNECTOR_CAPABILITY_REQUIRED', `Connector ${validated.name} does not provide ${capability}`);
  return true;
}
