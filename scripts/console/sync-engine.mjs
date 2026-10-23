#!/usr/bin/env node
// Copies the authoritative SPOOL engine sources into the desktop application
// bundle and records a hash manifest that binds the packaged engine to an exact
// git commit. The desktop application never re-implements engine behaviour; it
// imports this copy and verifies the manifest at startup.
//
// Usage: node scripts/console/sync-engine.mjs [--check]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRoot = join(repoRoot, 'apps', 'console');
const target = join(appRoot, 'engine');
const checkOnly = process.argv.includes('--check');

const COPY = [
  ['src', 'src'],
  ['capabilities', 'capabilities'],
  ['package.json', 'package.json']
];

// Files that are only meaningful for the browser Studio surface are still copied
// so the engine tree stays byte-identical to the repository. Excluding them would
// make the manifest a partial claim rather than a verifiable identity.
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function engineCommitSha() {
  if (/^[a-f0-9]{40}$/.test(process.env.SPOOL_COMMIT_SHA ?? '')) return process.env.SPOOL_COMMIT_SHA;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  } catch { /* fall through */ }
  return null;
}

async function computeManifest(root) {
  const files = {};
  for (const absolute of await walk(root)) {
    const rel = relative(root, absolute).split(sep).join('/');
    files[rel] = sha256(await readFile(absolute));
  }
  const aggregate = sha256(Object.keys(files).sort().map(name => `${name}:${files[name]}`).join('\n'));
  return { files, aggregate };
}

async function main() {
  if (checkOnly) {
    if (!existsSync(join(target, 'manifest.json'))) {
      console.error('sync-engine: no packaged engine manifest; run without --check first');
      process.exitCode = 1;
      return;
    }
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    const actual = await computeManifest(join(target, 'src'));
    const expected = manifest.files;
    const changed = Object.entries(actual.files).filter(([name, hash]) => expected[name] !== hash).map(([name]) => name);
    const missing = Object.keys(expected).filter(name => actual.files[name] === undefined);
    if (changed.length || missing.length) {
      console.error(JSON.stringify({ ok: false, changed, missing }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, files: Object.keys(expected).length, aggregate: actual.aggregate }));
    return;
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [from, to] of COPY) {
    const source = join(repoRoot, from);
    const destination = join(target, to);
    await cp(source, destination, { recursive: true, force: true, dereference: true });
  }

  const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  const engine = await computeManifest(join(target, 'src'));
  const capabilities = await computeManifest(join(target, 'capabilities'));
  const manifest = {
    schemaVersion: 1,
    kind: 'spool-console-engine-bundle',
    engineVersion: pkg.version,
    engineCommitSha: engineCommitSha(),
    generatedAt: new Date().toISOString(),
    aggregateSha256: engine.aggregate,
    capabilityAggregateSha256: capabilities.aggregate,
    files: engine.files,
    capabilityFiles: capabilities.files
  };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    engineVersion: manifest.engineVersion,
    engineCommitSha: manifest.engineCommitSha,
    files: Object.keys(manifest.files).length,
    aggregateSha256: manifest.aggregateSha256
  }, null, 2));
}

main().catch(error => {
  console.error(`sync-engine failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
