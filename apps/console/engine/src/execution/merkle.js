import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';

const LEAF_DOMAIN = 'spool-merkle-leaf-v1';
const NODE_DOMAIN = 'spool-merkle-node-v1';
const EMPTY_DOMAIN = 'spool-merkle-empty-v1';
const HASH = /^sha256:[a-f0-9]{64}$/;

function requireLeaves(leaves) {
  if (!Array.isArray(leaves)) fail('INVALID_MERKLE_INPUT', 'Merkle leaves must be an array');
  const seen = new Set();
  return leaves.map((leaf, index) => {
    if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) fail('INVALID_MERKLE_INPUT', `Merkle leaf ${index} must be an object`);
    if (typeof leaf.keyId !== 'string' || !HASH.test(leaf.keyId)) fail('INVALID_MERKLE_INPUT', `Merkle leaf ${index} keyId must be a canonical sha256 identity`);
    if (typeof leaf.rowHash !== 'string' || !HASH.test(leaf.rowHash)) fail('INVALID_MERKLE_INPUT', `Merkle leaf ${index} rowHash must be a canonical sha256 identity`);
    if (seen.has(leaf.keyId)) fail('INVALID_MERKLE_INPUT', `Merkle leaves contain duplicate keyId ${leaf.keyId}`);
    seen.add(leaf.keyId);
    return Object.freeze({ keyId: leaf.keyId, rowHash: leaf.rowHash });
  }).sort((left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0));
}

function leafHash(leaf) {
  return sha256Canonical(LEAF_DOMAIN, { keyId: leaf.keyId, rowHash: leaf.rowHash });
}

function nodeHash(left, right) {
  return sha256Canonical(NODE_DOMAIN, { left, right });
}

function emptyRoot(context) {
  return sha256Canonical(EMPTY_DOMAIN, { context: JSON.parse(JSON.stringify(context ?? {})) });
}

function buildLevels(hashes) {
  const levels = [Object.freeze([...hashes])];
  let current = hashes;
  while (current.length > 1) {
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = index + 1 < current.length ? current[index + 1] : current[index];
      next.push(nodeHash(left, right));
    }
    levels.push(Object.freeze(next));
    current = next;
  }
  return Object.freeze(levels);
}

export function merkleRoot(leaves, context = {}) {
  const sorted = requireLeaves(leaves);
  if (sorted.length === 0) return emptyRoot(context);
  return buildLevels(sorted.map(leafHash)).at(-1)[0];
}

export function merkleProof(leaves, keyId, context = {}) {
  const sorted = requireLeaves(leaves);
  const position = sorted.findIndex(leaf => leaf.keyId === keyId);
  if (position < 0) fail('MERKLE_KEY_UNKNOWN', 'Merkle proof requested for an unknown keyId');
  const levels = buildLevels(sorted.map(leafHash));
  const proof = [];
  let index = position;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const siblings = levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : (index + 1 < siblings.length ? index + 1 : index);
    proof.push(Object.freeze({ sibling: siblings[siblingIndex], direction: isRight ? 'left' : 'right' }));
    index = Math.floor(index / 2);
  }
  return Object.freeze({
    root: levels.at(-1)[0],
    leafCount: sorted.length,
    keyId,
    rowHash: sorted[position].rowHash,
    proof: Object.freeze(proof)
  });
}

export function verifyMerkleProof(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (typeof input.root !== 'string' || !HASH.test(input.root)) return false;
  if (typeof input.keyId !== 'string' || !HASH.test(input.keyId)) return false;
  if (typeof input.rowHash !== 'string' || !HASH.test(input.rowHash)) return false;
  if (!Array.isArray(input.proof)) return false;
  let current;
  try {
    current = leafHash({ keyId: input.keyId, rowHash: input.rowHash });
    for (const step of input.proof) {
      if (!step || typeof step !== 'object' || typeof step.sibling !== 'string' || !HASH.test(step.sibling)) return false;
      if (step.direction === 'left') current = nodeHash(step.sibling, current);
      else if (step.direction === 'right') current = nodeHash(current, step.sibling);
      else return false;
    }
  } catch {
    return false;
  }
  return current === input.root;
}
