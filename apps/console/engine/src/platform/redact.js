import { fail } from '../core/errors.js';

const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|credential|credentials|access[_-]?key|private[_-]?key)$/i;
const REDACTED = '[REDACTED]';

function cloneAndRedact(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') fail('REDACTION_UNSAFE_VALUE', 'Unsupported value encountered during redaction');
  if (seen.has(value)) fail('REDACTION_UNSAFE_VALUE', 'Cyclic values are not supported during redaction');
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail('REDACTION_UNSAFE_VALUE', 'Non-JSON object encountered during redaction');
  }

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const extras = Reflect.ownKeys(descriptors).filter(key => key !== 'length' && !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length));
      if (extras.length) fail('REDACTION_UNSAFE_VALUE', 'Arrays with custom properties are not supported during redaction');
      return value.map((item, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('REDACTION_UNSAFE_VALUE', 'Sparse or accessor arrays are not supported during redaction');
        return cloneAndRedact(descriptor.value, seen);
      });
    } finally {
      seen.delete(value);
    }
  }
  if (prototype !== Object.prototype && prototype !== null) fail('REDACTION_UNSAFE_VALUE', 'Only plain objects are supported during redaction');

  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) fail('REDACTION_UNSAFE_VALUE', 'Symbol keys are not supported during redaction');
    const out = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('REDACTION_UNSAFE_VALUE', 'Accessors and non-enumerable properties are not supported during redaction');
      out[key] = SECRET_KEY.test(key) ? REDACTED : cloneAndRedact(descriptor.value, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function redact(value) {
  return cloneAndRedact(value, new Set());
}

export { REDACTED };
