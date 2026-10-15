// Refuse to publish broken browser module graphs or privileged Node-side trees.
// This validation is intentionally dependency-free so it runs inside Cloudflare builds.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const forbidden = ['cli', 'connectors', 'daemon', 'execution', 'platform', 'protocol', 'safety'];
for (const dir of forbidden) {
  const target = path.join(root, 'src', dir);
  if (await stat(target).then(() => true, () => false)) {
    throw new Error('Privileged Node-only directory in public distribution: ' + dir);
  }
}
for (const name of ['package.json', '.env', '.npmrc', 'node_modules', '.git']) {
  if (await stat(path.join(root, name)).then(() => true, () => false)) {
    throw new Error('Forbidden public build artifact: ' + name);
  }
}
const sourceFiles = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) sourceFiles.push(full);
    else throw new Error('Non-regular static artifact: ' + full);
  }
}
await walk(root);
const jsFiles = sourceFiles.filter(f => f.endsWith('.js'));
let checkedEdges = 0;
for (const file of jsFiles) {
  const code = await readFile(file, 'utf8');
  const imports = [];
  const statements = /\\b(?:import|export)\\s+(?:[^'";]*?\\s+from\\s*)?['"]([^'"]+)['"]/g;
  const lazy = /\\bimport\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
  const assets = /\\bnew\\s+URL\\s*\\(\\s*['"]([^'"]+)['"]\\s*,\\s*import\\.meta\\.url/g;
  for (const re of [statements, lazy, assets]) {
    for (const match of code.matchAll(re)) imports.push(match[1]);
  }
  for (const target of imports) {
    if (target === 'node:crypto' && code.includes("typeof window")) continue;
    if (!(target.startsWith('./') || target.startsWith('../') || target.startsWith('/'))) {
      throw new Error('Unsupported web module import in ' + path.relative(root, file) + ': ' + target);
    }
    const destination = target.startsWith('/') ? path.resolve(root, '.' + target) : path.resolve(path.dirname(file), target);
    if (destination !== root && !destination.startsWith(root + path.sep)) {
      throw new Error('Import escapes public root: ' + target);
    }
    if (!(await stat(destination).then(s => s.isFile(), () => false))) {
      throw new Error('Missing browser module: ' + path.relative(root, file) + ' -> ' + target);
    }
    checkedEdges++;
  }
}
const forbiddenSuffixes = ['.map', '.pem', '.key', '.sqlite', '.db', '.tgz', '.env'];
for (const file of sourceFiles) {
  if (forbiddenSuffixes.some(suffix => file.endsWith(suffix))) {
    throw new Error('Sensitive or debug artifact in public build: ' + path.relative(root, file));
  }
}
console.log(JSON.stringify({staticBoundary:'PASS',jsFiles:jsFiles.length,checkedEdges,files:sourceFiles.length}));
