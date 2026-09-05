import { createHash } from 'node:crypto';

function failCanonical(message) {
  throw new TypeError(`CANONICAL_JSON: ${message}`);
}

function normalize(value, seen, path) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) failCanonical(`non-finite number at ${path}`);
    return value;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    failCanonical(`unsupported ${type} at ${path}`);
  }
  if (type !== 'object') failCanonical(`unsupported ${type} at ${path}`);

  if (seen.has(value)) failCanonical(`circular value at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalize(item, seen, `${path}[${index}]`));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      failCanonical(`unsupported object prototype at ${path}`);
    }

    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = normalize(value[key], seen, `${path}.${key}`);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value, new WeakSet(), '$'));
}

export async function sha256Json(value) {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `sha256:${digest}`;
}
