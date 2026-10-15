import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function buildFixture(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spool-build-dist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distDir = join(root, 'dist');
  const built = spawnSync(process.execPath, ['scripts/build-dist.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SPOOL_DIST_DIR: distDir,
      SPOOL_COMMIT_SHA: '',
      VERCEL_GIT_COMMIT_SHA: '',
      CF_PAGES_COMMIT_SHA: '',
      GITHUB_SHA: '',
      SPOOL_REQUIRE_RELEASE_IDENTITY: '',
      VERCEL: '',
      ...env
    }
  });
  return { root, distDir, built };
}

function artifactRoot(entries) {
  const canonical = entries
    .map(entry => `${entry.path}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

test('release build emits ordinary same-origin static modules with no compressed/blob application bootstrap', async t => {
  const { distDir, built } = await buildFixture(t);
  assert.equal(built.status, 0, built.stderr || built.stdout);

  for (const file of [
    'index.html', 'styles.css', 'product.css', 'vercel.json',
    'src/app.js', 'src/studio-flow.js', 'src/site-content.js', 'src/site-redesign.js', 'src/site-redesign.css',
    'src/product-surface.js', 'src/core/autopilot.js', 'src/core/command-kernel.js',
    'src/runtime/browser-worker-runtime.js', 'src/worker/migration.worker.js'
  ]) {
    const info = await stat(join(distDir, file));
    assert.ok(info.isFile() && info.size > 0, `${file} missing`);
  }

  const html = await readFile(join(distDir, 'index.html'), 'utf8');
  assert.match(html, /src="\/boot-watchdog\.js"/);
  assert.match(html, /src="\/src\/app\.js"/);
  assert.match(html, /src="\/src\/studio-flow\.js"/);
  assert.match(html, /src="\/src\/site-redesign\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /href="\/src\/site-redesign\.css"/);
  assert.doesNotMatch(html, /src="\/src\/product-surface\.js"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /payload-\d+\.js|bootstrap\.js|DecompressionStream|__SPOOL_PAYLOAD__/);

  const app = await readFile(join(distDir, 'src/app.js'), 'utf8');
  const site = await readFile(join(distDir, 'src/site-redesign.js'), 'utf8');
  const content = await readFile(join(distDir, 'src/site-content.js'), 'utf8');
  assert.doesNotMatch(app, /DecompressionStream|await\s+import\(jsUrl\)|__SPOOL_PAYLOAD__/);
  assert.doesNotMatch(`${app}\n${site}\n${content}`, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|sendBeacon\s*\(/);
});

test('host-consumed deployment config ships in dist but stays out of the served-artifact manifest', async t => {
  const commit = 'abcdef0123456789abcdef0123456789abcdef01';
  const { distDir, built } = await buildFixture(t, { SPOOL_COMMIT_SHA: commit, SPOOL_REQUIRE_RELEASE_IDENTITY: '1' });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const config = await stat(join(distDir, 'vercel.json'));
  assert.ok(config.isFile() && config.size > 0, 'vercel.json must still ship in dist/ for the host');

  const manifest = JSON.parse(await readFile(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.ok(!manifest.artifacts.some(entry => entry.path === 'vercel.json'), 'host-consumed config must not enter the served-artifact manifest');
  assert.equal(artifactRoot(manifest.artifacts), manifest.artifactRootSha256);
});

test('Vercel configuration deep-links every product route to index.html without cleanUrls interference', async t => {
  const { distDir, built } = await buildFixture(t);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const config = JSON.parse(await readFile(join(distDir, 'vercel.json'), 'utf8'));
  assert.equal(Object.hasOwn(config, 'cleanUrls'), false);
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
  const csp = config.headers.flatMap(rule => rule.headers).find(header => header.key === 'Content-Security-Policy')?.value;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /connect-src 'none'/);
});

test('release-identity-required build fails closed when no exact source commit is available', async t => {
  const { built } = await buildFixture(t, { SPOOL_REQUIRE_RELEASE_IDENTITY: '1' });
  assert.notEqual(built.status, 0, 'release build must not succeed with an unbound source identity');
  assert.match(`${built.stderr}\n${built.stdout}`, /release identity.*exact 40-character Git commit SHA/i);
});

test('Vercel build binds release identity from VERCEL_GIT_COMMIT_SHA', async t => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const { distDir, built } = await buildFixture(t, { VERCEL: '1', VERCEL_GIT_COMMIT_SHA: commit });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const release = JSON.parse(await readFile(join(distDir, 'release.json'), 'utf8'));
  assert.equal(release.commit, commit);
});

test('release manifest cryptographically binds every deployed static artifact to one deterministic root', async t => {
  const commit = '89abcdef0123456789abcdef0123456789abcdef';
  const { distDir, built } = await buildFixture(t, { SPOOL_COMMIT_SHA: commit, SPOOL_REQUIRE_RELEASE_IDENTITY: '1' });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const release = JSON.parse(await readFile(join(distDir, 'release.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.equal(release.commit, commit);
  assert.equal(manifest.releaseCommit, commit);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 5);
  assert.deepEqual([...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path)), manifest.artifacts);
  assert.match(manifest.artifactRootSha256, /^[a-f0-9]{64}$/);
  assert.equal(release.artifactRootSha256, manifest.artifactRootSha256);
  assert.equal(artifactRoot(manifest.artifacts), manifest.artifactRootSha256);

  for (const entry of manifest.artifacts) {
    const body = await readFile(join(distDir, entry.path));
    assert.equal(body.byteLength, entry.size, `size mismatch for ${entry.path}`);
    assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256, `digest mismatch for ${entry.path}`);
  }
});