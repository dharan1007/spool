const SENSITIVE_KEYS = new Set([
  'password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'credential'
]);

function normalizedKey(key) {
  return String(key).replace(/[-\s]/g, '').toLowerCase();
}

export function isSensitiveKey(key) {
  const raw = String(key).toLowerCase();
  return SENSITIVE_KEYS.has(raw) || SENSITIVE_KEYS.has(normalizedKey(key));
}

export function containsSecretMaterialKeys(value) {
  if (Array.isArray(value)) return value.some(containsSecretMaterialKeys);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => isSensitiveKey(key) || containsSecretMaterialKeys(child));
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : redact(child)
  ]));
}
