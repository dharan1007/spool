import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { fail } from '../core/errors.js';
import { collectArtifactEntries, artifactRootSha256, requireExactCommitSha, requireSha256Digest } from './artifact-root.js';
import { publicKeyId, signCanonical, verifyCanonical } from './signing.js';

const RELEASE_FILES = new Set(['release.json', 'release-manifest.json']);
const HOST_CONSUMED_CONFIG = new Set(['vercel.json']);
const EXACT_GIT_SHA = /^[a-f0-9]{40}$/i;

export function gitCommitForDir({ cwd = process.cwd(), ref = 'HEAD' } = {}) {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim();
  if (!EXACT_GIT_SHA.test(sha)) fail('GIT_COMMIT_UNRESOLVED', `Unable to resolve Git commit for ${ref}`);
  return sha;
}

export async function buildReleaseChain({ distDir = 'dist', release = {}, manifest = {}, commit = null, sourceCommitResolved = null } = {}) {
  const artifacts = await collectArtifactEntries(distDir, {
    excluded: RELEASE_FILES,
    hostConsumed: HOST_CONSUMED_CONFIG
  });
  const computedRoot = artifactRootSha256(artifacts);
  const releaseRoot = requireSha256Digest(release.artifactRootSha256, 'release.json artifact root');
  const manifestRoot = requireSha256Digest(manifest.artifactRootSha256, 'release-manifest.json artifact root');
  if (releaseRoot !== computedRoot) {
    fail('DIST_ROOT_MISMATCH', `release.json artifact root ${releaseRoot} does not match computed dist root ${computedRoot}`);
  }
  if (manifestRoot !== computedRoot) {
    fail('DIST_ROOT_MISMATCH', `release-manifest.json artifact root ${manifestRoot} does not match computed dist root ${computedRoot}`);
  }
  const resolvedCommit = sourceCommitResolved ?? gitCommitForDir({});
  if (commit != null) {
    const expected = requireExactCommitSha(commit, 'expected commit');
    if (release.commit && release.commit !== expected) fail('RELEASE_COMMIT_MISMATCH', `release.json commit ${release.commit} does not match expected ${expected}`);
    if (manifest.releaseCommit && manifest.releaseCommit !== expected) fail('MANIFEST_COMMIT_MISMATCH', `release-manifest.json commit ${manifest.releaseCommit} does not match expected ${expected}`);
  }
  return Object.freeze({
    commit: resolvedCommit,
    version: release.version,
    artifactRootSha256: computedRoot,
    artifactCount: artifacts.length,
    artifacts
  });
}

export async function loadReleaseChain({ distDir = 'dist', commit = null, sourceCommitResolved = null } = {}) {
  const release = JSON.parse(await readFile(join(distDir, 'release.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(distDir, 'release-manifest.json'), 'utf8'));
  return buildReleaseChain({ distDir, release, manifest, commit, sourceCommitResolved });
}

export function signedReleaseEnvelope({ version, commit, artifactRootSha256, generatedAt, privateKey }) {
  const payload = Object.freeze({
    product: 'SPOOL',
    schemaVersion: 1,
    domain: 'release-parity-v1',
    version,
    commit: requireExactCommitSha(commit, 'release commit'),
    artifactRootSha256: requireSha256Digest(artifactRootSha256, 'release artifact root'),
    generatedAt
  });
  const signatureRecord = signCanonical('release-parity-v1', payload, privateKey);
  const publicKey = publicKeyFromPrivate(privateKey);
  return Object.freeze({
    payload,
    signature: signatureRecord.signature,
    signatureAlgorithm: signatureRecord.algorithm,
    domain: signatureRecord.domain,
    key: publicKeyId(publicKey)
  });
}

export function verifySignedReleaseEnvelope(envelope, publicKey, { expectedCommit = null, expectedRoot = null } = {}) {
  if (!envelope || typeof envelope !== 'object' || !envelope.payload || !envelope.signature) {
    fail('INVALID_RELEASE_ENVELOPE', 'Release envelope must contain payload and signature');
  }
  const payload = Object.freeze({ ...envelope.payload });
  if (payload.domain !== 'release-parity-v1') fail('RELEASE_ENVELOPE_DOMAIN', 'Release envelope must bind the release-parity-v1 domain');
  if (!verifyCanonical('release-parity-v1', payload, envelope.signature, publicKey)) {
    fail('RELEASE_SIGNATURE_INVALID', 'Release envelope signature does not verify');
  }
  if (expectedCommit != null && payload.commit !== requireExactCommitSha(expectedCommit, 'expected commit')) {
    fail('RELEASE_ENVELOPE_COMMIT_MISMATCH', `Release envelope commit ${payload.commit} does not match expected ${expectedCommit}`);
  }
  if (expectedRoot != null && payload.artifactRootSha256 !== requireSha256Digest(expectedRoot, 'expected artifact root')) {
    fail('RELEASE_ENVELOPE_ROOT_MISMATCH', `Release envelope artifact root ${payload.artifactRootSha256} does not match expected ${expectedRoot}`);
  }
  return payload;
}

function publicKeyFromPrivate(privateKeyValue) {
  const parsed = createPrivateKey(typeof privateKeyValue === 'string' ? privateKeyValue : privateKeyValue);
  return createPublicKey(parsed).export({ type: 'spki', format: 'pem' });
}

export async function writeReleaseEvidence({ distDir = 'dist', evidencePath = 'release/parity-evidence.json', privateKey, version = null } = {}) {
  const chain = await loadReleaseChain({ distDir });
  const envelope = signedReleaseEnvelope({
    version: version ?? chain.version,
    commit: chain.commit,
    artifactRootSha256: chain.artifactRootSha256,
    generatedAt: new Date().toISOString(),
    privateKey
  });
  const evidence = Object.freeze({
    schemaVersion: 1,
    chain,
    createdAt: envelope.payload.generatedAt,
    envelope,
    artifacts: chain.artifacts.length
  });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}