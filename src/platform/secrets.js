import { fail } from '../core/errors.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateSecretRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('INVALID_SECRET_REF', 'Secret reference must be an object');
  }
  if (ref.provider !== 'env') {
    fail('UNSUPPORTED_SECRET_REF', 'P1 supports env secret references');
  }
  if (typeof ref.key !== 'string' || !ENV_KEY.test(ref.key)) {
    fail('INVALID_SECRET_REF', 'Secret environment key is invalid');
  }
  return structuredClone(ref);
}

export function resolveSecretRef(ref, env = process.env) {
  const validated = validateSecretRef(ref);
  const value = env?.[validated.key];
  if (typeof value !== 'string' || value.length === 0) {
    fail('SECRET_NOT_FOUND', `Secret environment reference ${validated.key} is not set`);
  }
  return value;
}
