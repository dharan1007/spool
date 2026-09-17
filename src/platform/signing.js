import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, randomBytes, createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson } from './canonical-json.js';

const FINGERPRINT_PATTERN = /^ed25519:fpr:[a-f0-9]{64}$/;
const ALGORITHM = 'spool-signature-v1';

export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    algorithm: ALGORITHM,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
  });
}

export function ensureEd25519PrivateKey(key) {
  if (typeof key === 'string' && !/BEGIN PRIVATE KEY/.test(key)) fail('INVALID_SIGNING_KEY', 'Signing key must be a PEM-encoded PKCS#8 private key');
  let parsed;
  try {
    parsed = createPrivateKey(typeof key === 'string' ? key : key);
  } catch (cause) {
    const error = fail('INVALID_SIGNING_KEY', 'Signing key must be a private key');
    error.cause = cause;
    throw error;
  }
  if (parsed.asymmetricKeyType !== 'ed25519') fail('INVALID_SIGNING_KEY', 'Signing key must use Ed25519');
  return parsed;
}

export function ensureEd25519PublicKey(key) {
  if (typeof key === 'string' && !/BEGIN PUBLIC KEY/.test(key)) fail('INVALID_VERIFICATION_KEY', 'Verification key must be a PEM-encoded SPKI public key');
  let parsed;
  try {
    parsed = createPublicKey(typeof key === 'string' ? key : key);
  } catch (cause) {
    const error = fail('INVALID_VERIFICATION_KEY', 'Verification key must be a public key');
    error.cause = cause;
    throw error;
  }
  if (parsed.asymmetricKeyType !== 'ed25519') fail('INVALID_VERIFICATION_KEY', 'Verification key must use Ed25519');
  return parsed;
}

export function publicKeyId(publicKey) {
  const key = ensureEd25519PublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  const digest = createHash('sha256').update(der).digest('hex');
  return `ed25519:fpr:${digest}`;
}

export function requirePublicKeyId(value) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) fail('INVALID_KEY_FINGERPRINT', `Public key identifier is malformed: ${value}`);
  return value;
}

export function signCanonical(domain, payload, privateKey) {
  if (typeof domain !== 'string' || !domain) fail('SIGNING_DOMAIN', 'Signing domain must be a non-empty string');
  const key = ensureEd25519PrivateKey(privateKey);
  const message = Buffer.from(`SPOOL\0${domain}\0${canonicalJson(payload)}`, 'utf8');
  const signature = sign(null, message, key).toString('base64url');
  return Object.freeze({ algorithm: ALGORITHM, domain, signature });
}

export function verifyCanonical(domain, payload, signature, publicKey, { keyFingerprint = null } = {}) {
  if (typeof domain !== 'string' || !domain) fail('SIGNING_DOMAIN', 'Signing domain must be a non-empty string');
  if (typeof signature !== 'string' || !signature) fail('INVALID_SIGNATURE', 'Signature must be a non-empty string');
  const key = ensureEd25519PublicKey(publicKey);
  if (keyFingerprint != null && requirePublicKeyId(keyFingerprint) !== publicKeyId(publicKey)) {
    fail('KEY_FINGERPRINT_MISMATCH', 'Signing key fingerprint does not match the claimed key identifier');
  }
  const message = Buffer.from(`SPOOL\0${domain}\0${canonicalJson(payload)}`, 'utf8');
  return verify(null, message, key, Buffer.from(signature, 'base64url'));
}

export function fingerprintOfPublicKey(publicKey) {
  return publicKeyId(publicKey);
}

export function randomNonce(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 64) fail('INVALID_NONCE_LENGTH', 'Nonce length must be between 16 and 64 bytes');
  return randomBytes(bytes).toString('base64url');
}