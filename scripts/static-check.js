import { readFile, stat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const required = [
  'index.html', 'styles.css', 'boot-watchdog.js', 'src/app.js', 'src/core/autopilot.js', 'src/webmcp/optional.js', 'src/storage/indexeddb.js',
  'src/runtime/browser-worker-runtime.js', 'src/worker/migration.worker.js',
  'README.md', 'LICENSE', 'docs/THREAT_MODEL.md', 'docs/WEBMCP.md',
  'benchmarks/run.js', 'vercel.json', 'package-lock.json', 'SECURITY.md',
  'docs/DEMO_SCRIPT.md', '.github/workflows/ci.yml'
];
const failures = [];
for (const file of required) {
  try { const s = await stat(file); if (!s.isFile() || s.size === 0) failures.push(`${file}: missing/empty`); }
  catch { failures.push(`${file}: missing`); }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

for (const file of [...(await walk('src')).filter(f => f.endsWith('.js')), 'boot-watchdog.js']) {
  const text = await readFile(file, 'utf8');
  if (/\beval\s*\(/.test(text) || /new\s+Function\s*\(/.test(text)) failures.push(`${file}: arbitrary code execution primitive detected`);
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bnavigator\.sendBeacon\b|\bWebSocket\s*\(/.test(text)) failures.push(`${file}: outbound network primitive detected`);
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) failures.push(`${file}: syntax check failed: ${checked.stderr.trim()}`);
}

try {
  const html = await readFile('index.html', 'utf8');
  if (!/Content-Security-Policy/i.test(html)) failures.push('index.html: CSP missing');
  if (!/connect-src 'none'/i.test(html)) failures.push("index.html: CSP must contain connect-src 'none'");
  if (/https?:\/\//i.test(html)) failures.push('index.html: external URL detected; local-first release must be self-contained');
  for (const [, asset] of html.matchAll(/(?:src|href)="((?:\.\/|\/)[^"?#]+)"/g)) {
    const localPath = asset.replace(/^\.\//, '').replace(/^\//, '');
    try { await stat(localPath); } catch { failures.push(`index.html: referenced asset missing: ${asset}`); }
  }
} catch {}

try { JSON.parse(await readFile('vercel.json', 'utf8')); } catch (error) { failures.push(`vercel.json: invalid JSON: ${error.message}`); }

if (failures.length) {
  console.error(`Static release check failed (${failures.length}):`);
  failures.forEach(f => console.error(`- ${f}`));
  process.exit(1);
}
console.log(`Static release check passed (${required.length} required artifacts, no source-network primitives, JS syntax valid).`);
