import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fail } from '../core/errors.js';

const EXACT_GIT_SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

export function requireExactCommitSha(value, label = 'commit') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!EXACT_GIT_SHA.test(normalized)) fail('INVALID_COMMIT_SHA', `${label} must be an exact 40-character Git commit SHA`);
  return normalized;
}

export function requireSha256Digest(value, label = 'digest') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256.test(normalized)) fail('INVALID_SHA256', `${label} must be a lowercase 64-character SHA-256 digest`);
  return normalized;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256CanonicalList(domain, bytes) {
  return `sha256:${createHash('sha256').update(`SPOOL\0${domain}\0`, 'utf8').update(bytes).digest('hex')}`;
}

export function artifactRootSha256(artifacts) {
  const canonical = artifacts
    .map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return sha256Bytes(Buffer.from(canonical, 'utf8'));
}

export async function collectArtifactEntries(root, { relative = '', excluded = new Set(), hostConsumed = new Set() } = {}) {
  const directory = relative ? `${root}/${relative}` : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const artifacts = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && excluded.has(entry.name)) continue;
    if (!relative && hostConsumed.has(entry.name)) continue;
    if (entry.isDirectory()) {
      artifacts.push(...await collectArtifactEntries(root, { relative: path, excluded, hostConsumed }));
      continue;
    }
    if (!entry.isFile()) fail('DIST_ARTIFACT_NOT_FILE', `dist artifact ${path} must be a regular file`);
    const body = await readFile(`${root}/${path}`);
    artifacts.push(Object.freeze({ path, size: body.byteLength, sha256: sha256Bytes(body) }));
  }
  return artifacts;
}

export function verifyArtifactRoot(root, artifacts, { exclude = new Set() } = {}) {
  const released = new Set(artifacts.map(entry => entry.path));
  for (const excluded of exclude) {
    if (released.has(excluded)) fail('DIST_ARTIFACT_EXCLUDED', `dist artifact is excluded from the served manifest: ${excluded}`);
  }
  return artifactRootSha256(artifacts) === root;
}