import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKeyPair, signCanonical, verifyCanonical, publicKeyId, fingerprintOfPublicKey, randomNonce, ensureEd25519PublicKey, ensureEd25519PrivateKey } from '../src/platform/signing.js';

const { publicKey, privateKey } = generateSigningKeyPair();
const payload = Object.freeze({ product: 'SPOOL', version: '1.0.0', commit: 'a'.repeat(40), artifactRootSha256: 'f'.repeat(64) });

test('signing produces a valid Ed25519 signature over canonical JSON', () => {
  const signature = signCanonical('release-parity-v1', payload, privateKey);
  assert.equal(signature.algorithm, 'spool-signature-v1');
  assert.equal(signature.domain, 'release-parity-v1');
  assert.ok(signature.signature.length > 64);
  assert.equal(verifyCanonical('release-parity-v1', payload, signature.signature, publicKey), true);
});

test('signing fails closed on wrong domain, tampered payload and wrong key', () => {
  const signature = signCanonical('release-parity-v1', payload, privateKey);
  assert.equal(verifyCanonical('release-parity-v2', payload, signature.signature, publicKey), false);
  assert.equal(verifyCanonical('release-parity-v1', { ...payload, version: '9.9.9' }, signature.signature, publicKey), false);
  const other = generateSigningKeyPair();
  assert.equal(verifyCanonical('release-parity-v1', payload, signature.signature, other.publicKey), false);
});

test('signing rejects non-Ed25519 and malformed key material', () => {
  assert.throws(() => ensureEd25519PublicKey('not-a-key'), /INVALID_VERIFICATION_KEY/);
  assert.throws(() => ensureEd25519PrivateKey('not-a-key'), /INVALID_SIGNING_KEY/);
  assert.throws(() => signCanonical('', payload, privateKey), /SIGNING_DOMAIN/);
  assert.throws(() => signCanonical('release-parity-v1', payload, 'not-a-key'), /INVALID_SIGNING_KEY/);
});

test('key fingerprints are stable, deterministic and reject malformed values', () => {
  const id = publicKeyId(publicKey);
  assert.match(id, /^ed25519:fpr:[a-f0-9]{64}$/);
  assert.equal(fingerprintOfPublicKey(publicKey), id);
  assert.equal(publicKeyId(publicKey), publicKeyId(publicKey));
  assert.throws(() => publicKeyId('short'), /INVALID_VERIFICATION_KEY/);
  assert.deepEqual(new Set([publicKeyId(publicKey), publicKeyId(generateSigningKeyPair().publicKey)]).size, 2);
});

test('random nonce is bounded and unique', () => {
  const a = randomNonce();
  const b = randomNonce();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.throws(() => randomNonce(8), /INVALID_NONCE_LENGTH/);
  assert.throws(() => randomNonce(128), /INVALID_NONCE_LENGTH/);
});