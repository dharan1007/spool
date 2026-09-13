import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { merkleRoot, merkleProof, verifyMerkleProof } from '../src/execution/merkle.js';

const pad64 = value => BigInt(value).toString(16).padStart(64, '0');
const leaf = (key, row) => ({ keyId: `sha256:${key.repeat(64).slice(0, 64)}`, rowHash: `sha256:${row.repeat(64).slice(0, 64)}` });
const leaves = count => Array.from({ length: count }, (_, index) => ({ keyId: `sha256:${pad64(index + 1)}`, rowHash: `sha256:${pad64((index + 1) * 7)}` }));

test('merkle root is deterministic and order-independent', () => {
  const first = merkleRoot(leaves(8));
  const second = merkleRoot([...leaves(8)].reverse());
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, merkleRoot(leaves(7)));
  const changed = leaves(8);
  changed[3] = { ...changed[3], rowHash: `sha256:${'f'.repeat(64)}` };
  assert.notEqual(merkleRoot(changed), first);
});

test('merkle root handles empty, single and odd leaf counts', () => {
  const empty = merkleRoot([]);
  assert.match(empty, /^sha256:[a-f0-9]{64}$/);
  assert.equal(merkleRoot([], { primaryKey: ['id'] }), merkleRoot([], { primaryKey: ['id'] }));
  assert.notEqual(merkleRoot([], { primaryKey: ['id'] }), merkleRoot([], { primaryKey: ['other'] }));
  assert.equal(merkleRoot(leaves(1)), merkleRoot(leaves(1)));
  assert.notEqual(merkleRoot(leaves(1)), merkleRoot(leaves(3)));
  assert.notEqual(merkleRoot(leaves(3)), merkleRoot(leaves(4)));
});

test('merkle inclusion proofs verify and detect tampering', () => {
  const set = leaves(9);
  const root = merkleRoot(set);
  for (const index of [0, 4, 8]) {
    const proof = merkleProof(set, set[index].keyId);
    assert.equal(proof.root, root);
    assert.equal(proof.leafCount, 9);
    assert.equal(verifyMerkleProof(proof), true);
  }
  const victim = merkleProof(set, set[4].keyId);
  assert.equal(verifyMerkleProof({ ...victim, rowHash: set[5].rowHash }), false);
  assert.equal(verifyMerkleProof({ ...victim, root: set[0].keyId }), false);
  assert.equal(verifyMerkleProof({ ...victim, proof: [] }), false);
  assert.equal(verifyMerkleProof({ ...victim, proof: [{ sibling: victim.proof[0].sibling, direction: 'sideways' }] }), false);
  assert.equal(verifyMerkleProof(null), false);
  assert.equal(verifyMerkleProof({}), false);
  assert.throws(() => merkleProof(set, `sha256:${'f'.repeat(64)}`), /MERKLE_KEY_UNKNOWN/);
});

test('merkle rejects malformed leaves', () => {
  assert.throws(() => merkleRoot('leaves'), /INVALID_MERKLE_INPUT/);
  assert.throws(() => merkleRoot([{ keyId: 'nope', rowHash: 'nope' }]), /INVALID_MERKLE_INPUT/);
  assert.throws(() => merkleRoot([leaf('1', 'a'), leaf('1', 'b')]), /INVALID_MERKLE_INPUT/);
});

test('merkle scales to migration batch sizes', () => {
  const set = leaves(10_000);
  const started = performance.now();
  const root = merkleRoot(set);
  const proof = merkleProof(set, set[5432].keyId);
  const verified = verifyMerkleProof(proof);
  const elapsedMs = performance.now() - started;
  assert.equal(proof.root, root);
  assert.equal(verified, true);
  console.log(`merkle: 10k-leaf root + proof + verify in ${elapsedMs.toFixed(0)} ms`);
});
