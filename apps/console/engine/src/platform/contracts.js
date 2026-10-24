import { fail } from '../core/errors.js';
import { canonicalJson } from './canonical-json.js';

const CONNECTOR_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_KEYS = /^(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|credential|credentials|access[_-]?key|private[_-]?key)$/i;
const ALLOWED_KEYS = new Set([
  'connector', 'connectionId', 'resource', 'endpoint', 'database', 'schema', 'table', 'path',
  'identity', 'snapshot', 'fingerprint', 'secretRef'
]);

function assertNoResolvedSecrets(value, path = '$', insideSecretRef = false) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const nextInsideSecretRef = insideSecretRef || key === 'secretRef';
    if (!nextInsideSecretRef && SECRET_KEYS.test(key)) {
      fail('SECRET_IN_CONNECTOR_REF', `Resolved credential field ${key} is not allowed in connector references`);
    }
    assertNoResolvedSecrets(child, `${path}.${key}`, nextInsideSecretRef);
  }
}

function assertNoCredentialUrls(value, path = '$', insideSecretRef = false) {
  if (typeof value === 'string') {
    if (insideSecretRef || !value.includes('://')) return;
    let url;
    try { url = new URL(value); } catch { return; }
    if (url.password || url.username) fail('SECRET_IN_CONNECTOR_REF', `Credential-bearing URL is not allowed at ${path}`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assertNoCredentialUrls(child, `${path}.${key}`, insideSecretRef || key === 'secretRef');
  }
}

function validateSecretRef(ref) {
  if (ref === undefined) return;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_SECRET_REF', 'secretRef must be a typed reference object');
  if (ref.provider !== 'env' || typeof ref.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.key)) {
    fail('INVALID_SECRET_REF', 'P1 secretRef must use { provider: "env", key: "ENV_NAME" }');
  }
  if (Object.keys(ref).some(key => !['provider', 'key'].includes(key))) fail('INVALID_SECRET_REF', 'secretRef contains unsupported fields');
}

export function validateConnectorRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_CONNECTOR_REF', 'Connector reference must be an object');

  // Canonicalize first so accessors, custom prototypes, cycles, binary values, and other non-v1 data
  // are rejected before any recursive inspection can execute or silently omit them.
  const validated = JSON.parse(canonicalJson(ref));
  assertNoResolvedSecrets(validated);
  assertNoCredentialUrls(validated);

  const unknown = Object.keys(validated).filter(key => !ALLOWED_KEYS.has(key));
  if (unknown.length) fail('INVALID_CONNECTOR_REF', `Unsupported connector reference field ${unknown[0]}`);
  if (!CONNECTOR_NAME.test(validated.connector ?? '')) fail('INVALID_CONNECTOR_REF', 'Invalid connector name');
  if (validated.connectionId !== undefined && (typeof validated.connectionId !== 'string' || !CONNECTION_ID.test(validated.connectionId))) {
    fail('INVALID_CONNECTOR_REF', 'Invalid connectionId');
  }
  if (typeof validated.resource !== 'string' || !validated.resource.trim()) fail('INVALID_CONNECTOR_REF', 'Connector resource is required');
  validateSecretRef(validated.secretRef);
  return validated;
}

export function connectorIdentity(ref) {
  const validated = validateConnectorRef(ref);
  delete validated.secretRef;
  return validated;
}
