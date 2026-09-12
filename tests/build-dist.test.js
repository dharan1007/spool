import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function runBuild(env = {}) {
  return spawnSync(process.execPath, ['scripts/build-dist.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SPOOL_COMMIT_SHA: '',
      VERCEL_GIT_COMMIT_SHA: '',
      GITHUB_SHA: '',
      SPOOL_REQUIRE_RELEASE_IDENTITY: '',
      VERCEL: '',
      ...env
    }
  });
}

function artifactRoot(entries) {
  const canonical = entries
    .map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

test('release build emits ordinary same-origin static modules with no compressed/blob application bootstrap', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = runBuild();
  assert.equal(built.status, 0, built.stderr || built.stdout);

  for (const file of [
    'index.html', 'styles.css', 'product.css', 'vercel.json',
    'src/app.js', 'src/product-surface.js', 'src/core/autopilot.js', 'src/core/command-kernel.js',
    'src/runtime/browser-worker-runtime.js', 'src/worker/migration.worker.js'
  ]) {
    const info = await stat(new URL(`../dist/${file}`, import.meta.url));
    assert.ok(info.isFile() && info.size > 0, `dist/${file} missing`);
  }

  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/boot-watchdog\.js"/);
  assert.match(html, /src="\/src\/app\.js"/);
  assert.match(html, /src="\/src\/product-surface\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /href="\/product\.css"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /payload-\d+\.js|bootstrap\.js|DecompressionStream|__SPOOL_PAYLOAD__/);

  const app = await readFile(new URL('../dist/src/app.js', import.meta.url), 'utf8');
  const product = await readFile(new URL('../dist/src/product-surface.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /DecompressionStream|await\s+import\(jsUrl\)|__SPOOL_PAYLOAD__/);
  assert.doesNotMatch(`${app}\n${product}`, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|sendBeacon\s*\(/);
});

test('Vercel configuration deep-links every product route to index.html without cleanUrls interference', async () => {
  const built = runBuild();
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const config = JSON.parse(await readFile(new URL('../dist/vercel.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(config, 'cleanUrls'), false);
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
  const csp = config.headers.flatMap(rule => rule.headers).find(header => header.key === 'Content-Security-Policy')?.value;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /connect-src 'none'/);
});

test('release-identity-required build fails closed when no exact source commit is available', async () => {
  const built = runBuild({ SPOOL_REQUIRE_RELEASE_IDENTITY: '1' });
  assert.notEqual(built.status, 0, 'release build must not succeed with an unbound source identity');
  assert.match(`${built.stderr}\n${built.stdout}`, /release identity.*exact 40-character Git commit SHA/i);
});

test('Vercel build binds release identity from VERCEL_GIT_COMMIT_SHA', async () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const built = runBuild({ VERCEL: '1', VERCEL_GIT_COMMIT_SHA: commit });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  assert.equal(release.commit, commit);
});

test('release manifest cryptographically binds every deployed static artifact to one deterministic root', async () => {
  const commit = '89abcdef0123456789abcdef0123456789abcdef';
  const built = runBuild({ SPOOL_COMMIT_SHA: commit, SPOOL_REQUIRE_RELEASE_IDENTITY: '1' });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../dist/release-manifest.json', import.meta.url), 'utf8'));
  assert.equal(release.commit, commit);
  assert.equal(manifest.releaseCommit, commit);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 5);
  assert.deepEqual([...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path)), manifest.artifacts);
  assert.match(manifest.artifactRootSha256, /^[a-f0-9]{64}$/);
  assert.equal(release.artifactRootSha256, manifest.artifactRootSha256);
  assert.equal(artifactRoot(manifest.artifacts), manifest.artifactRootSha256);

  for (const entry of manifest.artifacts) {
    const body = await readFile(new URL(`../dist/${entry.path}`, import.meta.url));
    assert.equal(body.byteLength, entry.size, `size mismatch for ${entry.path}`);
    assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256, `digest mismatch for ${entry.path}`);
  }
});
