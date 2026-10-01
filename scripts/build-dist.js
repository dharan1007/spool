import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const RELEASE_FILES = new Set(['release.json', 'release-manifest.json']);
// vercel.json is host-consumed deployment configuration, not a served static
// artifact: the host applies it and never serves it byte-identical (the SPA
// rewrite answers /vercel.json with /index.html instead), so no production
// deployment can ever attest it. It stays in dist/ for the host, but must
// not enter the served-artifact manifest or its root hash.
const HOST_CONSUMED_CONFIG = new Set(['vercel.json']);
const EXACT_GIT_SHA = /^[a-f0-9]{40}$/i;

function resolveCommitIdentity() {
  const candidates = [
    ['SPOOL_COMMIT_SHA', process.env.SPOOL_COMMIT_SHA],
    ['VERCEL_GIT_COMMIT_SHA', process.env.VERCEL_GIT_COMMIT_SHA],
    ['GITHUB_SHA', process.env.GITHUB_SHA]
  ];
  for (const [name, raw] of candidates) {
    const value = raw?.trim() || '';
    if (!value) continue;
    if (!EXACT_GIT_SHA.test(value)) {
      throw new Error(`${name} must be an exact 40-character Git commit SHA when supplied`);
    }
    return Object.freeze({ commit: value.toLowerCase(), source: name });
  }
  return Object.freeze({ commit: null, source: null });
}

function releaseIdentityRequired() {
  return process.env.SPOOL_REQUIRE_RELEASE_IDENTITY?.trim() === '1'
    || process.env.VERCEL?.trim() === '1';
}

async function collectArtifactEntries(root, relative = '') {
  const directory = relative ? `${root}/${relative}` : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const artifacts = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && RELEASE_FILES.has(entry.name)) continue;
    if (!relative && HOST_CONSUMED_CONFIG.has(entry.name)) continue;
    if (entry.isDirectory()) {
      artifacts.push(...await collectArtifactEntries(root, path));
      continue;
    }
    if (!entry.isFile()) throw new Error(`dist artifact ${path} must be a regular file`);
    const body = await readFile(`${root}/${path}`);
    artifacts.push(Object.freeze({
      path,
      size: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex')
    }));
  }
  return artifacts;
}

function artifactRootSha256(artifacts) {
  const canonical = artifacts
    .map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

// Vercel can deploy without GitHub Actions quota. Enforce the browser
// recovery regression and syntax gate inside the build itself.
for (const path of ['src/app.js', 'src/studio-flow.js', 'src/site-content.js', 'src/site-redesign.js', 'src/product-surface.js', 'src/xlsx-ingest.js', 'src/zip-reader.js', 'src/core/command-kernel.js', 'src/core/migration.js', 'src/storage/indexeddb.js']) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
}
execFileSync(process.execPath, ['--test',
  'tests/autopilot-recovery.test.js',
  'tests/autopilot-kernel.test.js',
  'tests/ui-contract.test.js',
  'tests/studio-workflow.test.js',
  'tests/site-redesign.test.js'
], { stdio: 'inherit' });

const distDir = process.env.SPOOL_DIST_DIR?.trim() || 'dist';
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp('src', `${distDir}/src`, { recursive: true });
for (const file of ['index.html', 'styles.css', 'product.css', 'boot-watchdog.js', 'vercel.json']) await cp(file, `${distDir}/${file}`);

const html = await readFile(`${distDir}/index.html`, 'utf8');
const config = JSON.parse(await readFile(`${distDir}/vercel.json`, 'utf8'));
if (!html.includes('src="/boot-watchdog.js"')) throw new Error('dist/index.html must load the independent startup watchdog');
if (!html.includes('src="/src/app.js"')) throw new Error('dist/index.html must load /src/app.js as a same-origin module');
if (!html.includes('src="/src/studio-flow.js"')) throw new Error('dist/index.html must load the seven-stage Studio workflow as a same-origin module');
if (!html.includes('src="/src/site-redesign.js"')) throw new Error('dist/index.html must load the unified redesigned website as a same-origin module');
if (!html.includes('href="/styles.css"')) throw new Error('dist/index.html must load /styles.css as a same-origin stylesheet');
if (!html.includes('href="/src/site-redesign.css"')) throw new Error('dist/index.html must load the redesigned visual system as a same-origin stylesheet');
if (html.includes('src="/src/product-surface.js"')) throw new Error('legacy competing product-surface renderer must not be loaded');
if (!html.includes("connect-src 'none'")) throw new Error('dist/index.html must keep connect-src none');
if (/commercial-surface\.js|commercial\.css/.test(html)) throw new Error('legacy commercial overlay must not be present in the complete product build');
if (Object.hasOwn(config, 'cleanUrls')) throw new Error('cleanUrls must not be combined with SPA deep-link rewrites');
if (JSON.stringify(config.rewrites) !== JSON.stringify([{ source: '/(.*)', destination: '/index.html' }])) {
  throw new Error('vercel.json must contain one canonical SPA rewrite to /index.html');
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const identity = resolveCommitIdentity();
if (releaseIdentityRequired() && !identity.commit) {
  throw new Error('Release identity requires an exact 40-character Git commit SHA; set SPOOL_COMMIT_SHA, VERCEL_GIT_COMMIT_SHA, or GITHUB_SHA');
}
const suppliedBuildTime = process.env.SPOOL_BUILD_TIME?.trim() || '';
if (suppliedBuildTime && Number.isNaN(Date.parse(suppliedBuildTime))) {
  throw new Error('SPOOL_BUILD_TIME must be an ISO-compatible date-time when supplied');
}
const builtAt = suppliedBuildTime || new Date().toISOString();

const artifacts = Object.freeze(await collectArtifactEntries(distDir));
const artifactRoot = artifactRootSha256(artifacts);
const release = {
  schemaVersion: 2,
  version: process.env.SPOOL_RELEASE_VERSION?.trim() || packageJson.version,
  commit: identity.commit,
  commitSource: identity.source,
  builtAt,
  transport: 'same-origin-es-modules',
  artifactRootSha256: artifactRoot,
  manifest: '/release-manifest.json'
};
await writeFile(`${distDir}/release.json`, `${JSON.stringify(release, null, 2)}\n`, 'utf8');

const manifest = {
  schemaVersion: 2,
  generatedAt: builtAt,
  transport: release.transport,
  appEntry: '/src/app.js',
  siteEntry: '/src/site-redesign.js',
  workerEntry: '/src/worker/migration.worker.js',
  compressedBootstrap: false,
  dynamicBlobAppImport: false,
  release: '/release.json',
  releaseCommit: identity.commit,
  artifactHashAlgorithm: 'sha256',
  artifactRootSha256: artifactRoot,
  artifacts
};
await writeFile(`${distDir}/release-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Built ${distDir}/ as ordinary same-origin static ES modules; release commit=${release.commit ?? 'unbound-local-build'}; artifact root=${artifactRoot}.`);
