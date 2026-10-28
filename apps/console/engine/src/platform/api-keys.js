import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fail } from '../core/errors.js';

export function generateApiKey() {
  const secret = randomBytes(32).toString('hex');
  const prefix = secret.slice(0, 8);
  const fullKey = `spool_live_${prefix}_${secret}`;
  const hash = hashApiKey(fullKey);
  return { key: fullKey, prefix, hash };
}

export function hashApiKey(key) {
  if (typeof key !== 'string' || !key.startsWith('spool_live_')) {
    fail('INVALID_API_KEY', 'Malformed API key format');
  }
  return createHash('sha256').update(key).digest('hex');
}

export function verifyApiKey(providedKey, storedHash) {
  try {
    const computedHash = createHash('sha256').update(providedKey).digest('hex');
    const bufA = Buffer.from(computedHash, 'hex');
    const bufB = Buffer.from(storedHash, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
