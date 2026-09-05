import { fail } from '../core/errors.js';
import { RUNTIME_ONLY } from './runtime-contracts.js';

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

export class RuntimeSecret {
  #value;

  constructor(value) {
    if (typeof value !== 'string' || value.length === 0) fail('INVALID_RUNTIME_SECRET', 'Runtime secret value must be a non-empty string');
    this.#value = value;
    Object.defineProperty(this, RUNTIME_ONLY, { value: true, enumerable: false, writable: false });
    Object.freeze(this);
  }

  unwrap() {
    return this.#value;
  }

  toJSON() {
    fail('SECRET_SERIALIZATION_BLOCKED', 'Runtime secret values cannot be serialized');
  }

  toString() {
    return '[RuntimeSecret]';
  }
}

export function resolveRuntimeSecretRef(ref, env = process.env) {
  return new RuntimeSecret(resolveSecretRef(ref, env));
}

export function unwrapRuntimeSecret(value) {
  if (!(value instanceof RuntimeSecret)) fail('INVALID_RUNTIME_SECRET', 'Expected a RuntimeSecret');
  return value.unwrap();
}
