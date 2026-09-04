import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function runBuild() {
  return spawnSync(process.execPath, ['scripts/build-dist.js'], { encoding: 'utf8' });
}

test('release build emits ordinary same-origin static modules with no compressed/blob application bootstrap', async () => {
  await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
  const built = runBuild();
  assert.equal(built.status, 0, built.stderr || built.stdout);

  for (const file of [
    'index.html', 'styles.css', 'vercel.json',
    'src/app.js', 'src/core/autopilot.js', 'src/core/command-kernel.js',
    'src/runtime/browser-worker-runtime.js', 'src/worker/migration.worker.js'
  ]) {
    const info = await stat(new URL(`../dist/${file}`, import.meta.url));
    assert.ok(info.isFile() && info.size > 0, `dist/${file} missing`);
  }

  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/boot-watchdog\.js"/);
  assert.match(html, /src="\/src\/app\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /payload-\d+\.js|bootstrap\.js|DecompressionStream|__SPOOL_PAYLOAD__/);

  const app = await readFile(new URL('../dist/src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /DecompressionStream|await\s+import\(jsUrl\)|__SPOOL_PAYLOAD__/);
  assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|sendBeacon\s*\(/);
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
