import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src', 'dist/src', { recursive: true });
for (const file of ['index.html', 'styles.css', 'boot-watchdog.js', 'vercel.json']) await cp(file, `dist/${file}`);

const html = await readFile('dist/index.html', 'utf8');
const config = JSON.parse(await readFile('dist/vercel.json', 'utf8'));
if (!html.includes('src="/boot-watchdog.js"')) throw new Error('dist/index.html must load the independent startup watchdog');
if (!html.includes('src="/src/app.js"')) throw new Error('dist/index.html must load /src/app.js as a same-origin module');
if (!html.includes('href="/styles.css"')) throw new Error('dist/index.html must load /styles.css as a same-origin stylesheet');
if (!html.includes("connect-src 'none'")) throw new Error('dist/index.html must keep connect-src none');
if (Object.hasOwn(config, 'cleanUrls')) throw new Error('cleanUrls must not be combined with SPA deep-link rewrites');
if (JSON.stringify(config.rewrites) !== JSON.stringify([{ source: '/(.*)', destination: '/index.html' }])) {
  throw new Error('vercel.json must contain one canonical SPA rewrite to /index.html');
}

const manifest = {
  generatedAt: new Date().toISOString(),
  transport: 'same-origin-es-modules',
  appEntry: '/src/app.js',
  workerEntry: '/src/worker/migration.worker.js',
  compressedBootstrap: false,
  dynamicBlobAppImport: false
};
await writeFile('dist/release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Built dist/ as ordinary same-origin static ES modules; no compressed/blob application bootstrap.');
