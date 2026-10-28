import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, EMBEDDED_LOCKFILES, SOURCE_SCOPE } from '../scripts/console/sync-engine.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const appRoot = join(root, 'apps', 'console');
const engineRoot = join(appRoot, 'engine');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function tracked(paths) {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: root, encoding: 'utf8' });
  return new Set(output.split('\0').filter(Boolean).map(entry => entry.split('\\').join('/')));
}

test('the committed desktop engine bundle matches the authoritative root source', async () => {
  const result = await verifyBundle({ repoRoot: root, appRoot });
  assert.equal(
    result.ok,
    true,
    `embedded engine is out of sync with ${SOURCE_SCOPE.join(', ')}: ${JSON.stringify(result.mismatches, null, 2)}\n` +
      'Run `node scripts/console/sync-engine.mjs` and commit the regenerated bundle.'
  );
  assert.deepEqual(result.mismatches, []);
  assert.match(result.engineCommitSha, /^[a-f0-9]{40}$/);
  assert.ok(result.expected.files > 100, 'the engine bundle must contain the full source tree');
});

test('every file in the committed engine bundle is tracked by git', () => {
  // A synced-but-ignored file is the failure mode that let the bundle drift: the
  // copy looked correct on disk while the commit still shipped the old engine.
  const onDisk = walk(engineRoot)
    .map(file => relative(root, file).split(sep).join('/'))
    .sort();
  assert.ok(onDisk.length > 100);
  const trackedPaths = tracked(['apps/console/engine']);
  const untracked = onDisk.filter(path => !trackedPaths.has(path));
  assert.deepEqual(untracked, [], `untracked engine files would not ship: ${untracked.join(', ')}`);
});

test('the embedded engine carries no lockfile of its own', () => {
  const entries = readdirSync(engineRoot);
  for (const lockfile of EMBEDDED_LOCKFILES) {
    assert.equal(entries.includes(lockfile), false, `${lockfile} inside the engine bundle is drift`);
  }
});
