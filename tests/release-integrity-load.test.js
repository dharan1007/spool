import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKeyPair, signCanonical, verifyCanonical, publicKeyId } from '../src/platform/signing.js';
import { sha256Bytes, sha256CanonicalList, artifactRootSha256 } from '../src/platform/artifact-root.js';
import { performance } from 'node:perf_hooks';

test('release integrity sustained signing and verification stays inside the production budget', () => {
  const { privateKey, publicKey } = generateSigningKeyPair();
  const payload = { product: 'SPOOL', schemaVersion: 1, domain: 'release-parity-v1', commit: 'a'.repeat(40), artifactRootSha256: 'b'.repeat(64) };
  const iterations = 400;
  const signStart = performance.now();
  const records = [];
  for (let i = 0; i < iterations; i++) {
    const record = signCanonical('release-parity-v1', { ...payload, nonce: i }, privateKey);
    records.push(record);
  }
  const signMs = performance.now() - signStart;
  const verifyStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    assert.equal(verifyCanonical('release-parity-v1', { ...payload, nonce: i }, records[i].signature, publicKey), true);
  }
  const verifyMs = performance.now() - verifyStart;
  const envelopeBytes = Buffer.byteLength(JSON.stringify(records[0]));
  assert.ok(records.length === iterations, 'must sign every iteration');
  assert.ok(verifyMs / iterations < 2, 'per-envelope verification over budget');
  assert.ok(Buffer.byteLength(publicKey) > 100 && Buffer.byteLength(publicKey) < 700, 'PEM public key size outside expected bounds');
  assert.ok(envelopeBytes > 100 && envelopeBytes < 500, 'envelope size outside expected bounds');
  process.stdout.write(`release-integrity: ${iterations} sign/verify in ${signMs.toFixed(1)}/${verifyMs.toFixed(1)} ms\n`);
});

test('artifact root hashing is linear and bounded across thousands of artifacts', () => {
  const artifacts = [];
  for (let i = 0; i < 5000; i++) {
    artifacts.push({ path: `src/modules/module-${String(i).padStart(5, '0')}.js`, size: i, sha256: sha256Bytes(Buffer.from(`payload-${i}`)) });
  }
  const start = performance.now();
  const root = artifactRootSha256(artifacts);
  const ms = performance.now() - start;
  assert.match(root, /^[a-f0-9]{64}$/);
  assert.ok(ms < 2000, `hashing 5000 artifacts took ${ms.toFixed(1)} ms (over budget)`);
  const canonicalList = sha256CanonicalList('release-parity-v1', Buffer.from(artifacts.map(a => a.sha256).join('')));
  assert.match(canonicalList, /^sha256:[a-f0-9]{64}$/);
  const stable = artifactRootSha256(artifacts);
  assert.equal(root, stable, 'artifact root must be deterministic');
});

test('release integrity keeps a stable production identity under churn', () => {
  const pair = generateSigningKeyPair();
  const first = publicKeyId(pair.publicKey);
  for (let i = 0; i < 20; i++) {
    assert.equal(publicKeyId(pair.publicKey), first);
  }
  assert.match(first, /^ed25519:fpr:[a-f0-9]{64}$/);
});

test('reproducible evidence canonicalization is deterministic across repeated runs', () => {
  const bytesA = Buffer.from('bbb');
  const bytesB = Buffer.from('ccc');
  const one = sha256CanonicalList('release-parity-v1', bytesA);
  const two = sha256CanonicalList('release-parity-v1', bytesA);
  const three = sha256CanonicalList('release-parity-v1', bytesB);
  assert.equal(one, two);
  assert.notEqual(one, three, 'different byte streams must produce different canonical digests');
});