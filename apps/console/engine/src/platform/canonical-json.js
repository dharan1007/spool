import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';

function pathLabel(path) {
  return path.length ? path.join('') : '$';
}

function normalize(value, path, ancestors) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_NON_FINITE_NUMBER', `Non-finite number at ${pathLabel(path)}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (type === 'undefined') fail('CANONICAL_UNDEFINED', `undefined is not allowed at ${pathLabel(path)}`);
  if (type === 'bigint') fail('CANONICAL_BIGINT', `BigInt is not allowed at ${pathLabel(path)}`);
  if (type === 'function') fail('CANONICAL_FUNCTION', `Function is not allowed at ${pathLabel(path)}`);
  if (type === 'symbol') fail('CANONICAL_SYMBOL', `Symbol is not allowed at ${pathLabel(path)}`);
  if (type !== 'object') fail('CANONICAL_UNSUPPORTED_VALUE', `Unsupported value at ${pathLabel(path)}`);

  if (ancestors.has(value)) fail('CANONICAL_CYCLE', `Cyclic value at ${pathLabel(path)}`);
  if (value instanceof Date) fail('CANONICAL_DATE', `Date objects must be converted to strings before canonicalization at ${pathLabel(path)}`);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) fail('CANONICAL_BINARY', `Binary/typed-array values are not allowed at ${pathLabel(path)}`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) fail('CANONICAL_SPARSE_ARRAY', `Sparse arrays are not allowed at ${pathLabel([...path, `[${i}]`])}`);
        out[i] = normalize(value[i], [...path, `[${i}]`], ancestors);
      }
      const extraKeys = Reflect.ownKeys(value).filter(key => key !== 'length' && !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length));
      if (extraKeys.length) fail('CANONICAL_ARRAY_PROPERTY', `Arrays may not contain custom properties at ${pathLabel(path)}`);
      return out;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('CANONICAL_CUSTOM_PROTOTYPE', `Only plain objects are allowed at ${pathLabel(path)}`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) fail('CANONICAL_SYMBOL_KEY', `Symbol keys are not allowed at ${pathLabel(path)}`);

    const out = {};
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) fail('CANONICAL_NON_ENUMERABLE', `Non-enumerable property ${key} is not allowed at ${pathLabel(path)}`);
      if (!Object.hasOwn(descriptor, 'value')) fail('CANONICAL_ACCESSOR', `Accessor property ${key} is not allowed at ${pathLabel(path)}`);
      out[key] = normalize(descriptor.value, [...path, `.${key}`], ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value, [], new Set()));
}

export function sha256Canonical(domain, value) {
  if (typeof domain !== 'string' || !domain) fail('CANONICAL_DOMAIN', 'Hash domain must be a non-empty string');
  const payload = canonicalJson(value);
  return `sha256:${createHash('sha256').update(`SPOOL\0${domain}\0`, 'utf8').update(payload, 'utf8').digest('hex')}`;
}
