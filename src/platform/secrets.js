import { fail } from '../core/errors.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateSecretRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('UNSUPPORTED_SECRET_REF', 'Secret reference must be a typed reference object');
  }
  const prototype = Object.getPrototypeOf(ref);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('UNSUPPORTED_SECRET_REF', 'Secret reference must be a plain object');
  }
  const keys = Object.keys(ref);
  if (ref.provider !== 'env' || typeof ref.key !== 'string' || !ENV_KEY.test(ref.key) || keys.some(key => !['provider', 'key'].includes(key))) {
    fail('UNSUPPORTED_SECRET_REF', 'P1 supports only { provider: "env", key: "ENV_NAME" } secret references');
  }
  return { provider: 'env', key: ref.key };
}

export function resolveSecretRef(secretRef, env = process.env) {
  const ref = validateSecretRef(secretRef);
  const value = env?.[ref.key];
  if (typeof value !== 'string' || value.length === 0) {
    fail('SECRET_NOT_FOUND', `Secret environment reference ${ref.key} is not set`);
  }
  return value;
}
