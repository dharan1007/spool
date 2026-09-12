import { fail, SpoolError } from '../core/errors.js';
import { validateSecretRef } from '../platform/secrets.js';

function containsSecret(value, secret, seen = new Set()) {
  if (typeof value === 'string') return value.includes(secret);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) fail('UNSAFE_CREDENTIAL_RESULT', `Credential callback result contains accessor ${key}`);
    if (typeof key === 'string' && key.includes(secret)) return true;
    if (containsSecret(descriptor.value, secret, seen)) return true;
  }
  return false;
}

function redact(text, secret) {
  return String(text ?? 'credential callback failed').split(secret).join('[REDACTED]');
}

function inspectResult(result, secret) {
  if (containsSecret(result, secret)) fail('SECRET_LEAK_DETECTED', 'Credential callback attempted to return resolved secret material');
  return result;
}

function safeTypedError(error, secret) {
  return error instanceof SpoolError
    && !containsSecret(error.message, secret)
    && !containsSecret(error.details, secret);
}

function throwCallbackFailure(error, secret) {
  if (safeTypedError(error, secret)) throw error;
  fail('CREDENTIAL_CALLBACK_FAILED', redact(error?.message ?? error, secret));
}

export class CredentialBroker {
  constructor({ getEnv = key => process.env[key] } = {}) {
    if (typeof getEnv !== 'function') fail('INVALID_CREDENTIAL_BROKER', 'getEnv must be a function');
    Object.defineProperty(this, '_getEnv', { value: getEnv, enumerable: false, writable: false });
  }

  withSecret(secretRef, callback) {
    if (typeof callback !== 'function') fail('INVALID_CREDENTIAL_CALLBACK', 'Credential callback must be a function');
    const ref = validateSecretRef(secretRef);
    const secret = this._getEnv(ref.key);
    if (typeof secret !== 'string' || secret.length === 0) fail('SECRET_NOT_FOUND', `Secret environment reference ${ref.key} is not set`);

    let result;
    try {
      result = callback(secret);
    } catch (error) {
      throwCallbackFailure(error, secret);
    }

    if (result && typeof result.then === 'function') {
      return Promise.resolve(result)
        .then(value => inspectResult(value, secret))
        .catch(error => {
          if (error?.code === 'SECRET_LEAK_DETECTED' || error?.code === 'UNSAFE_CREDENTIAL_RESULT') throw error;
          throwCallbackFailure(error, secret);
        });
    }
    return inspectResult(result, secret);
  }
}
