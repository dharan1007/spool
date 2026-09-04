import { fail } from '../core/errors.js';

const FORBIDDEN_SECRET_KEYS = new Set(['secret', 'password', 'token', 'apikey', 'api_key', 'authorization', 'credential']);

function containsForbiddenSecretKey(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) return true;
    if (containsForbiddenSecretKey(child)) return true;
  }
  return false;
}

export function validateConnectorRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('INVALID_CONNECTOR_REF', 'Connector reference must be an object');
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(ref.connector ?? '')) {
    fail('INVALID_CONNECTOR_REF', 'Invalid connector name');
  }
  if (typeof ref.resource !== 'string' || !ref.resource.trim()) {
    fail('INVALID_CONNECTOR_REF', 'Connector resource is required');
  }
  if (containsForbiddenSecretKey(ref)) {
    fail('SECRET_IN_REFERENCE', 'Connector references may contain secretRef handles only, never secret values');
  }
  return structuredClone(ref);
}
