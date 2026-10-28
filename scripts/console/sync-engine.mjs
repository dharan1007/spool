#!/usr/bin/env node
// Synchronises the authoritative SPOOL engine sources into the desktop bundle and
// binds the copy to the exact source commit it was taken from.
//
// The desktop application never re-implements engine behaviour: it imports this
// copy and verifies the manifest at startup. `--check` therefore compares three
// things, and refuses to be satisfied by the bundle merely agreeing with its own
// manifest:
//
//   1. the authoritative root source (src/, capabilities/, package.json)
//   2. the embedded copy on disk (apps/console/engine)
//   3. the embedded manifest (per-file hashes, aggregates, commit binding)
//
// Usage:
//   node scripts/console/sync-engine.mjs            copy root source -> embedded bundle
//   node scripts/console/sync-engine.mjs --check    verify only, exit 1 on any drift
//   node scripts/console/sync-engine.mjs --repo-root <dir> --app-root <dir>
//                                                   explicit roots (fixtures/CI)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_KIND = 'spool-console-engine-bundle';
export const MANIFEST_SCHEMA_VERSION = 2;
export const SOURCE_TREES = Object.freeze(['src', 'capabilities']);
export const SOURCE_PACKAGE_MANIFEST = 'package.json';
export const SOURCE_SCOPE = Object.freeze([...SOURCE_TREES, SOURCE_PACKAGE_MANIFEST]);
export const SOURCE_COMMIT_RESOLUTION = `git log -1 --format=%H -- ${SOURCE_SCOPE.join(' ')}`;
export const EMBEDDED_LOCKFILES = Object.freeze(['package-lock.json', 'npm-shrinkwrap.json']);
export const LOCKFILE_POLICY =
  'The embedded engine ships no lockfile of its own: it is a copy of engine sources, not a separate install. ' +
  'Its dependency versions are resolved by apps/console/package-lock.json, so a lockfile inside apps/console/engine ' +
  'is drift and fails --check. Root package-lock.json stays authoritative for the engine package.';

export class EngineSyncError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'EngineSyncError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalize(value) {
  return value.split(sep).join('/');
}

function sortByName(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort(sortByName);
}

export async function computeManifest(root) {
  const files = {};
  for (const absolute of await walk(root)) {
    const rel = normalize(relative(root, absolute));
    files[rel] = sha256(await readFile(absolute));
  }
  const aggregate = aggregateDigest(files);
  return { files, aggregate };
}

export function aggregateDigest(files) {
  return sha256(
    Object.keys(files)
      .sort(sortByName)
      .map(name => `${name}:${files[name]}`)
      .join('\n')
  );
}

export function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new EngineSyncError('ENGINE_GIT_FAILED', `git ${args.join(' ')} failed in ${repoRoot}: ${error?.message ?? error}`);
  }
}

/**
 * The exact commit the embedded engine was copied from: the last commit that
 * touched the engine source scope. This stays stable across commits that only
 * change registers or documentation, which keeps re-running the sync idempotent.
 */
export function sourceCommitSha(repoRoot) {
  const output = git(repoRoot, ['log', '-1', '--format=%H', '--', ...SOURCE_SCOPE], { allowFailure: true });
  const sha = (output ?? '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new EngineSyncError('ENGINE_SOURCE_COMMIT_UNAVAILABLE', `cannot resolve the engine source commit in ${repoRoot}`);
  }
  return sha;
}

/** Uncommitted changes inside the source scope make an exact commit binding a lie. */
export function dirtySourcePaths(repoRoot) {
  const output = git(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...SOURCE_SCOPE], { allowFailure: true });
  return (output ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export async function expectedBundle(repoRoot) {
  const source = await computeManifest(join(repoRoot, 'src'));
  const capabilities = await computeManifest(join(repoRoot, 'capabilities'));
  const packageBytes = await readFile(join(repoRoot, SOURCE_PACKAGE_MANIFEST));
  const pkg = JSON.parse(packageBytes.toString('utf8'));
  return {
    engineVersion: pkg.version ?? null,
    files: source.files,
    aggregate: source.aggregate,
    capabilityFiles: capabilities.files,
    capabilityAggregate: capabilities.aggregate,
    packageManifestSha256: sha256(packageBytes)
  };
}

export async function readEmbeddedManifest(appRoot) {
  const manifestPath = join(appRoot, 'engine', 'manifest.json');
  if (!existsSync(manifestPath)) return { manifestPath, manifest: null, error: 'missing' };
  try {
    return { manifestPath, manifest: JSON.parse(await readFile(manifestPath, 'utf8')), error: null };
  } catch (error) {
    return { manifestPath, manifest: null, error: `unreadable: ${error?.message ?? error}` };
  }
}

function compareFiles({ expected, actual, scope, mismatches }) {
  for (const name of Object.keys(expected).sort(sortByName)) {
    if (actual[name] === undefined) mismatches.push({ kind: 'missing-file', scope, path: name });
    else if (actual[name] !== expected[name]) {
      mismatches.push({ kind: 'modified-file', scope, path: name, expected: expected[name], actual: actual[name] });
    }
  }
  for (const name of Object.keys(actual).sort(sortByName)) {
    if (expected[name] === undefined) mismatches.push({ kind: 'extra-file', scope, path: name });
  }
}

/**
 * Compare the authoritative root source, the embedded copy and the embedded
 * manifest. Returns every mismatch instead of the first one so a failure is
 * diagnosable.
 */
export async function verifyBundle({ repoRoot, appRoot }) {
  const mismatches = [];
  const expected = await expectedBundle(repoRoot);

  const { manifest, error } = await readEmbeddedManifest(appRoot);
  if (!manifest) {
    mismatches.push({
      kind: error === 'missing' ? 'embedded-missing' : 'embedded-manifest-unreadable',
      path: 'apps/console/engine/manifest.json',
      detail: error
    });
    return { ok: false, mismatches, expected: summarize(expected), embedded: null };
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.kind !== MANIFEST_KIND) {
    mismatches.push({
      kind: 'manifest-schema',
      expected: { schemaVersion: MANIFEST_SCHEMA_VERSION, kind: MANIFEST_KIND },
      actual: { schemaVersion: manifest.schemaVersion ?? null, kind: manifest.kind ?? null }
    });
  }

  let commit = null;
  try {
    commit = sourceCommitSha(repoRoot);
  } catch (failure) {
    mismatches.push({ kind: 'source-commit-unavailable', detail: failure.message });
  }

  const dirty = dirtySourcePaths(repoRoot);
  if (dirty.length > 0) mismatches.push({ kind: 'source-tree-dirty', paths: dirty });

  if (commit) {
    if (manifest.engineCommitSha !== commit) {
      mismatches.push({ kind: 'commit-binding-mismatch', expected: commit, actual: manifest.engineCommitSha ?? null });
    }
    const scopes = Array.isArray(manifest.sourceCommitScope) ? manifest.sourceCommitScope : [];
    if (scopes.join(',') !== SOURCE_SCOPE.join(',')) {
      mismatches.push({ kind: 'commit-binding-scope-mismatch', expected: [...SOURCE_SCOPE], actual: scopes });
    }
  }

  const embeddedSource = await computeManifest(join(appRoot, 'engine', 'src'));
  const embeddedCapabilities = await computeManifest(join(appRoot, 'engine', 'capabilities'));
  compareFiles({ expected: expected.files, actual: embeddedSource.files, scope: 'src', mismatches });
  compareFiles({
    expected: expected.capabilityFiles,
    actual: embeddedCapabilities.files,
    scope: 'capabilities',
    mismatches
  });

  const embeddedPackagePath = join(appRoot, 'engine', SOURCE_PACKAGE_MANIFEST);
  const embeddedPackageSha = existsSync(embeddedPackagePath) ? sha256(await readFile(embeddedPackagePath)) : null;
  if (embeddedPackageSha !== expected.packageManifestSha256) {
    mismatches.push({
      kind: 'package-manifest-mismatch',
      path: 'apps/console/engine/package.json',
      expected: expected.packageManifestSha256,
      actual: embeddedPackageSha
    });
  }
  if (manifest.packageManifestSha256 !== expected.packageManifestSha256) {
    mismatches.push({
      kind: 'package-manifest-mismatch',
      path: 'manifest.packageManifestSha256',
      expected: expected.packageManifestSha256,
      actual: manifest.packageManifestSha256 ?? null
    });
  }

  if (manifest.aggregateSha256 !== expected.aggregate) {
    mismatches.push({ kind: 'aggregate-mismatch', expected: expected.aggregate, actual: manifest.aggregateSha256 ?? null });
  }
  if (manifest.capabilityAggregateSha256 !== expected.capabilityAggregate) {
    mismatches.push({
      kind: 'capability-aggregate-mismatch',
      expected: expected.capabilityAggregate,
      actual: manifest.capabilityAggregateSha256 ?? null
    });
  }

  // The manifest's own per-file map must describe the same files as the root.
  if (manifest.files && typeof manifest.files === 'object') {
    compareFiles({ expected: expected.files, actual: manifest.files, scope: 'manifest-src', mismatches });
  }
  if (manifest.capabilityFiles && typeof manifest.capabilityFiles === 'object') {
    compareFiles({
      expected: expected.capabilityFiles,
      actual: manifest.capabilityFiles,
      scope: 'manifest-capabilities',
      mismatches
    });
  }

  for (const lockfile of EMBEDDED_LOCKFILES) {
    if (existsSync(join(appRoot, 'engine', lockfile))) {
      mismatches.push({
        kind: 'embedded-lockfile',
        path: `apps/console/engine/${lockfile}`,
        detail: LOCKFILE_POLICY
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    engineCommitSha: manifest.engineCommitSha ?? null,
    expected: summarize(expected),
    embedded: {
      engineVersion: manifest.engineVersion ?? null,
      files: Object.keys(manifest.files ?? {}).length,
      capabilityFiles: Object.keys(manifest.capabilityFiles ?? {}).length
    },
    mismatches
  };
}

function summarize(expected) {
  return {
    engineVersion: expected.engineVersion,
    files: Object.keys(expected.files).length,
    aggregateSha256: expected.aggregate,
    capabilityFiles: Object.keys(expected.capabilityFiles).length,
    capabilityAggregateSha256: expected.capabilityAggregate,
    packageManifestSha256: expected.packageManifestSha256
  };
}

export async function syncEngine({ repoRoot, appRoot }) {
  const dirty = dirtySourcePaths(repoRoot);
  if (dirty.length > 0) {
    throw new EngineSyncError(
      'ENGINE_SOURCE_DIRTY',
      `refusing to bind the embedded engine to a commit while the source scope has uncommitted changes: ${dirty.join(', ')}`
    );
  }
  const commit = sourceCommitSha(repoRoot);
  const expected = await expectedBundle(repoRoot);
  const target = join(appRoot, 'engine');

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const tree of SOURCE_TREES) {
    await cp(join(repoRoot, tree), join(target, tree), { recursive: true, force: true, dereference: true });
  }
  await cp(join(repoRoot, SOURCE_PACKAGE_MANIFEST), join(target, SOURCE_PACKAGE_MANIFEST), {
    force: true,
    dereference: true
  });

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    engineVersion: expected.engineVersion,
    engineCommitSha: commit,
    sourceCommitScope: [...SOURCE_SCOPE],
    sourceCommitResolution: SOURCE_COMMIT_RESOLUTION,
    lockfilePolicy: LOCKFILE_POLICY,
    fileCount: Object.keys(expected.files).length,
    capabilityFileCount: Object.keys(expected.capabilityFiles).length,
    aggregateSha256: expected.aggregate,
    capabilityAggregateSha256: expected.capabilityAggregate,
    packageManifestSha256: expected.packageManifestSha256,
    files: expected.files,
    capabilityFiles: expected.capabilityFiles
  };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verification = await verifyBundle({ repoRoot, appRoot });
  if (!verification.ok) {
    throw new EngineSyncError('ENGINE_SYNC_SELF_CHECK_FAILED', JSON.stringify(verification.mismatches));
  }
  return { ok: true, engineCommitSha: commit, ...verification.expected };
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const invokedFromCli = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invokedFromCli) {
  const args = process.argv.slice(2);
  const repoRoot = argumentValue(args, '--repo-root')
    ? resolve(argumentValue(args, '--repo-root'))
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const appRoot = argumentValue(args, '--app-root') ? resolve(argumentValue(args, '--app-root')) : join(repoRoot, 'apps', 'console');

  Promise.resolve()
    .then(async () => {
      if (args.includes('--check')) {
        const result = await verifyBundle({ repoRoot, appRoot });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) {
          console.error(
            `sync-engine: embedded engine does not match the authoritative source (${result.mismatches.length} mismatch(es))`
          );
          process.exit(1);
        }
        return;
      }
      const result = await syncEngine({ repoRoot, appRoot });
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(error?.message ?? error);
      process.exitCode = 1;
    });
}
