import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src', 'dist/src', { recursive: true });
for (const file of ['index.html', 'styles.css', 'commercial.css', 'boot-watchdog.js', 'vercel.json']) await cp(file, `dist/${file}`);

const html = await readFile('dist/index.html', 'utf8');
const config = JSON.parse(await readFile('dist/vercel.json', 'utf8'));
if (!html.includes('src="/boot-watchdog.js"')) throw new Error('dist/index.html must load the independent startup watchdog');
if (!html.includes('src="/src/app.js"')) throw new Error('dist/index.html must load /src/app.js as a same-origin module');
if (!html.includes('src="/src/commercial-surface.js"')) throw new Error('dist/index.html must load the production capability surface');
if (!html.includes('href="/styles.css"')) throw new Error('dist/index.html must load /styles.css as a same-origin stylesheet');
if (!html.includes('href="/commercial.css"')) throw new Error('dist/index.html must load /commercial.css as a same-origin stylesheet');
if (!html.includes("connect-src 'none'")) throw new Error('dist/index.html must keep connect-src none');
if (Object.hasOwn(config, 'cleanUrls')) throw new Error('cleanUrls must not be combined with SPA deep-link rewrites');
if (JSON.stringify(config.rewrites) !== JSON.stringify([{ source: '/(.*)', destination: '/index.html' }])) {
  throw new Error('vercel.json must contain one canonical SPA rewrite to /index.html');
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const suppliedCommit = process.env.SPOOL_COMMIT_SHA?.trim() || '';
if (suppliedCommit && !/^[a-f0-9]{40}$/i.test(suppliedCommit)) {
  throw new Error('SPOOL_COMMIT_SHA must be an exact 40-character Git commit SHA when supplied');
}
const suppliedBuildTime = process.env.SPOOL_BUILD_TIME?.trim() || '';
if (suppliedBuildTime && Number.isNaN(Date.parse(suppliedBuildTime))) {
  throw new Error('SPOOL_BUILD_TIME must be an ISO-compatible date-time when supplied');
}
const builtAt = suppliedBuildTime || new Date().toISOString();
const release = {
  schemaVersion: 1,
  version: process.env.SPOOL_RELEASE_VERSION?.trim() || packageJson.version,
  commit: suppliedCommit ? suppliedCommit.toLowerCase() : null,
  builtAt,
  transport: 'same-origin-es-modules'
};
await writeFile('dist/release.json', `${JSON.stringify(release, null, 2)}\n`, 'utf8');

const manifest = {
  generatedAt: builtAt,
  transport: release.transport,
  appEntry: '/src/app.js',
  workerEntry: '/src/worker/migration.worker.js',
  compressedBootstrap: false,
  dynamicBlobAppImport: false,
  release: '/release.json'
};
await writeFile('dist/release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Built dist/ as ordinary same-origin static ES modules; release commit=${release.commit ?? 'unbound-local-build'}.`);
