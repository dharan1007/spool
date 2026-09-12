import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const EXACT_GIT_SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACTS = 10_000;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireExactSha(value, code, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!EXACT_GIT_SHA.test(normalized)) throw failure(code, `${label} must be an exact 40-character Git commit SHA`);
  return normalized;
}

function requireSha256(value, code, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256.test(normalized)) throw failure(code, `${label} must be a lowercase SHA-256 digest`);
  return normalized;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactRoot(artifacts) {
  const canonical = artifacts.map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join('');
  return sha256(Buffer.from(canonical, 'utf8'));
}

function validateBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw failure('INVALID_BASE_URL', 'Deployment base URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw failure('INVALID_BASE_URL', 'Deployment base URL must be an absolute credential-free http(s) URL');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed;
}

function validateArtifactPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 1024) {
    throw failure('UNSAFE_ARTIFACT_PATH', 'Artifact path must be a non-empty bounded string');
  }
  if (rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('?') || rawPath.includes('#') || rawPath.includes('\0')) {
    throw failure('UNSAFE_ARTIFACT_PATH', `Unsafe artifact path: ${rawPath}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw failure('UNSAFE_ARTIFACT_PATH', `Artifact path is not valid URI text: ${rawPath}`);
  }
  if (decoded !== rawPath && /[\\?#\0]/.test(decoded)) {
    throw failure('UNSAFE_ARTIFACT_PATH', `Encoded control characters are not allowed in artifact path: ${rawPath}`);
  }
  const segments = decoded.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw failure('UNSAFE_ARTIFACT_PATH', `Artifact path traversal is not allowed: ${rawPath}`);
  }
  if (decoded === 'release.json' || decoded === 'release-manifest.json') {
    throw failure('UNSAFE_ARTIFACT_PATH', `Release metadata cannot recursively attest itself: ${rawPath}`);
  }
  return rawPath;
}

function artifactUrl(base, path) {
  const url = new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);
  if (url.origin !== base.origin) throw failure('UNSAFE_ARTIFACT_PATH', `Artifact escaped deployment origin: ${path}`);
  const basePrefix = base.pathname === '/' ? '/' : `${base.pathname.replace(/\/$/, '')}/`;
  if (!url.pathname.startsWith(basePrefix)) throw failure('UNSAFE_ARTIFACT_PATH', `Artifact escaped deployment base path: ${path}`);
  return url;
}

async function fetchJson(fetchImpl, url, code) {
  let response;
  try {
    response = await fetchImpl(url.href, { cache: 'no-store', redirect: 'error', headers: { 'cache-control': 'no-cache' } });
  } catch (cause) {
    const error = failure(code, `Unable to fetch ${url.pathname}`);
    error.cause = cause;
    throw error;
  }
  if (!response?.ok) throw failure(code, `${url.pathname} returned HTTP ${response?.status ?? '<unknown>'}`);
  try {
    return await response.json();
  } catch (cause) {
    const error = failure(code, `${url.pathname} did not contain valid JSON`);
    error.cause = cause;
    throw error;
  }
}

function normalizeManifestArtifacts(manifest) {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > MAX_ARTIFACTS) {
    throw failure('INVALID_RELEASE_MANIFEST', `Release manifest must contain between 1 and ${MAX_ARTIFACTS} artifacts`);
  }
  const seen = new Set();
  let previous = '';
  return manifest.artifacts.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw failure('INVALID_RELEASE_MANIFEST', `Artifact entry ${index} must be an object`);
    }
    const path = validateArtifactPath(entry.path);
    if (seen.has(path)) throw failure('INVALID_RELEASE_MANIFEST', `Duplicate artifact path: ${path}`);
    if (index > 0 && path.localeCompare(previous) < 0) {
      throw failure('INVALID_RELEASE_MANIFEST', 'Artifact entries must be sorted lexicographically by path');
    }
    seen.add(path);
    previous = path;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw failure('INVALID_RELEASE_MANIFEST', `Artifact size is invalid for ${path}`);
    }
    const digest = requireSha256(entry.sha256, 'INVALID_RELEASE_MANIFEST', `Artifact digest for ${path}`);
    return Object.freeze({ path, size: entry.size, sha256: digest });
  });
}

export async function verifyDeployedRelease({ baseUrl, expectedCommit, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw failure('FETCH_UNAVAILABLE', 'A fetch implementation is required');
  const base = validateBaseUrl(baseUrl);
  const expected = requireExactSha(expectedCommit, 'INVALID_EXPECTED_COMMIT', 'Expected commit');

  const releaseUrl = new URL('release.json', base.href.endsWith('/') ? base.href : `${base.href}/`);
  const release = await fetchJson(fetchImpl, releaseUrl, 'RELEASE_FETCH_FAILED');
  if (release?.schemaVersion !== 2) throw failure('RELEASE_SCHEMA_UNSUPPORTED', `Expected release schemaVersion 2, got ${release?.schemaVersion ?? '<missing>'}`);
  const deployedCommit = requireExactSha(release.commit, 'INVALID_DEPLOYED_COMMIT', 'Deployed release commit');
  if (deployedCommit !== expected) {
    throw failure('DEPLOYED_COMMIT_MISMATCH', `Deployed commit mismatch: expected ${expected}, got ${deployedCommit}`);
  }
  if (release.manifest !== '/release-manifest.json') {
    throw failure('INVALID_RELEASE_MANIFEST_REFERENCE', 'release.json must bind the canonical /release-manifest.json path');
  }
  const releaseRoot = requireSha256(release.artifactRootSha256, 'INVALID_RELEASE_ROOT', 'Release artifact root');

  const manifestUrl = new URL('release-manifest.json', base.href.endsWith('/') ? base.href : `${base.href}/`);
  const manifest = await fetchJson(fetchImpl, manifestUrl, 'MANIFEST_FETCH_FAILED');
  if (manifest?.schemaVersion !== 2) throw failure('MANIFEST_SCHEMA_UNSUPPORTED', `Expected manifest schemaVersion 2, got ${manifest?.schemaVersion ?? '<missing>'}`);
  const manifestCommit = requireExactSha(manifest.releaseCommit, 'INVALID_RELEASE_MANIFEST', 'Manifest release commit');
  if (manifestCommit !== deployedCommit) throw failure('MANIFEST_COMMIT_MISMATCH', `Manifest commit ${manifestCommit} does not match release commit ${deployedCommit}`);
  if (manifest.artifactHashAlgorithm !== 'sha256') throw failure('INVALID_RELEASE_MANIFEST', 'Manifest artifactHashAlgorithm must be sha256');
  const manifestRoot = requireSha256(manifest.artifactRootSha256, 'INVALID_RELEASE_MANIFEST', 'Manifest artifact root');
  if (manifestRoot !== releaseRoot) throw failure('ARTIFACT_ROOT_MISMATCH', 'release.json and release-manifest.json disagree on artifact root');

  const artifacts = normalizeManifestArtifacts(manifest);
  const computedRoot = artifactRoot(artifacts);
  if (computedRoot !== manifestRoot) throw failure('ARTIFACT_ROOT_MISMATCH', `Manifest artifact root mismatch: expected ${manifestRoot}, computed ${computedRoot}`);

  for (const entry of artifacts) {
    const url = artifactUrl(base, entry.path);
    let response;
    try {
      response = await fetchImpl(url.href, { cache: 'no-store', redirect: 'error', headers: { 'cache-control': 'no-cache' } });
    } catch (cause) {
      const error = failure('ARTIFACT_FETCH_FAILED', `Unable to fetch deployed artifact ${entry.path}`);
      error.cause = cause;
      throw error;
    }
    if (!response?.ok) throw failure('ARTIFACT_FETCH_FAILED', `Artifact ${entry.path} returned HTTP ${response?.status ?? '<unknown>'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== entry.size) {
      throw failure('ARTIFACT_SIZE_MISMATCH', `Artifact ${entry.path} size mismatch: expected ${entry.size}, got ${bytes.byteLength}`);
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      throw failure('ARTIFACT_DIGEST_MISMATCH', `Artifact ${entry.path} digest mismatch: expected ${entry.sha256}, got ${digest}`);
    }
  }

  return Object.freeze({
    commit: deployedCommit,
    version: release.version,
    artifactRootSha256: releaseRoot,
    artifactCount: artifacts.length
  });
}

async function main() {
  const baseUrl = process.argv[2] || process.env.SPOOL_URL;
  const expectedCommit = process.argv[3] || process.env.EXPECTED_SHA;
  try {
    const result = await verifyDeployedRelease({ baseUrl, expectedCommit });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error?.code || 'DEPLOYED_RELEASE_VERIFICATION_FAILED';
    process.stderr.write(`${code}: ${error?.message || 'Deployed release verification failed'}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();
