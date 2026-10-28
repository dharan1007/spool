import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EngineSyncError,
  LOCKFILE_POLICY,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_SCOPE,
  syncEngine,
  verifyBundle
} from '../../../scripts/console/sync-engine.mjs';

const CLI = new URL('../../../scripts/console/sync-engine.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'SPOOL fixture',
      GIT_AUTHOR_EMAIL: 'fixture@spool.invalid',
      GIT_COMMITTER_NAME: 'SPOOL fixture',
      GIT_COMMITTER_EMAIL: 'fixture@spool.invalid'
    }
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'spool-engine-sync-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, 'capabilities'), { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'spool-engine-fixture', version: '9.9.9' }, null, 2)}\n`);
  await writeFile(join(root, 'src', 'index.js'), 'export const alpha = 1;\n');
  await writeFile(join(root, 'src', 'nested', 'beta.js'), 'export const beta = 2;\n');
  await writeFile(join(root, 'capabilities', 'matrix.json'), `${JSON.stringify({ capabilities: [{ id: 'filesystem.source' }] }, null, 2)}\n`);
  git(root, ['init', '--quiet']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture baseline']);
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function kinds(result) {
  return result.mismatches.map(mismatch => mismatch.kind);
}

test('sync binds the embedded engine to the exact source commit and is idempotent', async () => {
  const root = await createFixture();
  try {
    const appRoot = join(root, 'apps', 'console');
    const first = await syncEngine({ repoRoot: root, appRoot });
    assert.equal(first.ok, true);
    assert.match(first.engineCommitSha, /^[a-f0-9]{40}$/);
    assert.equal(first.files, 2);
    assert.equal(first.capabilityFiles, 1);

    const manifestPath = join(appRoot, 'engine', 'manifest.json');
    const firstBytes = await readFile(manifestPath);
    const manifest = JSON.parse(firstBytes.toString('utf8'));
    assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.engineCommitSha, first.engineCommitSha);
    assert.deepEqual(manifest.sourceCommitScope, [...SOURCE_SCOPE]);
    assert.equal(manifest.generatedAt, undefined, 'the manifest must be reproducible, not timestamped');
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.lockfilePolicy, LOCKFILE_POLICY);

    // Re-running cannot produce different bytes and must still verify.
    await syncEngine({ repoRoot: root, appRoot });
    assert.deepEqual(await readFile(manifestPath), firstBytes, 'repeated sync must be byte-identical');
    const verified = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(verified.ok, true, JSON.stringify(verified.mismatches));
    assert.deepEqual(verified.mismatches, []);
  } finally {
    await cleanup(root);
  }
});

test('a missing, extra, modified, capability or package change fails --check', async () => {
  const root = await createFixture();
  try {
    const appRoot = join(root, 'apps', 'console');
    const engine = join(appRoot, 'engine');
    await syncEngine({ repoRoot: root, appRoot });

    // missing file
    await rm(join(engine, 'src', 'index.js'));
    let result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('missing-file'), JSON.stringify(result.mismatches));
    assert.equal(result.mismatches.find(m => m.kind === 'missing-file').path, 'index.js');
    assert.equal(result.mismatches.find(m => m.kind === 'missing-file').scope, 'src');
    await syncEngine({ repoRoot: root, appRoot });

    // extra file
    await writeFile(join(engine, 'src', 'smuggled.js'), 'export const smuggled = true;\n');
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('extra-file'), JSON.stringify(result.mismatches));
    await syncEngine({ repoRoot: root, appRoot });

    // modified file
    await writeFile(join(engine, 'src', 'nested', 'beta.js'), 'export const beta = 3;\n');
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('modified-file'), JSON.stringify(result.mismatches));
    await syncEngine({ repoRoot: root, appRoot });

    // changed capability file
    await writeFile(join(engine, 'capabilities', 'matrix.json'), `${JSON.stringify({ capabilities: [] }, null, 2)}\n`);
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    const capabilityMismatch = result.mismatches.find(m => m.kind === 'modified-file' && m.scope === 'capabilities');
    assert.ok(capabilityMismatch, JSON.stringify(result.mismatches));
    assert.equal(capabilityMismatch.path, 'matrix.json');
    await syncEngine({ repoRoot: root, appRoot });

    // package manifest mismatch
    await writeFile(join(engine, 'package.json'), `${JSON.stringify({ name: 'spool-engine-fixture', version: '0.0.1' }, null, 2)}\n`);
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('package-manifest-mismatch'), JSON.stringify(result.mismatches));
  } finally {
    await cleanup(root);
  }
});

test('commit binding and source cleanliness are part of the check', async () => {
  const root = await createFixture();
  try {
    const appRoot = join(root, 'apps', 'console');
    await syncEngine({ repoRoot: root, appRoot });

    // A new source commit invalidates the binding until the engine is re-synced.
    await writeFile(join(root, 'src', 'index.js'), 'export const alpha = 2;\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'source change']);
    let result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('commit-binding-mismatch'), JSON.stringify(result.mismatches));

    // A dirty source scope cannot be described as an exact commit at all.
    await writeFile(join(root, 'src', 'index.js'), 'export const alpha = 3;\n');
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('source-tree-dirty'), JSON.stringify(result.mismatches));
    await assert.rejects(
      () => syncEngine({ repoRoot: root, appRoot }),
      error => error instanceof EngineSyncError && error.code === 'ENGINE_SOURCE_DIRTY'
    );

    // Manifest tampering is caught even when the manifest agrees with the copy.
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'source change 2']);
    await syncEngine({ repoRoot: root, appRoot });
    const manifestPath = join(appRoot, 'engine', 'manifest.json');
    const manifest = JSON.parse((await readFile(manifestPath)).toString('utf8'));
    manifest.engineCommitSha = '0'.repeat(40);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('commit-binding-mismatch'));
  } finally {
    await cleanup(root);
  }
});

test('an embedded lockfile is drift, and the CLI reports both outcomes', async () => {
  const root = await createFixture();
  try {
    const appRoot = join(root, 'apps', 'console');
    await syncEngine({ repoRoot: root, appRoot });

    const okRun = execFileSync(process.execPath, [CLI, '--check', '--repo-root', root, '--app-root', appRoot], {
      encoding: 'utf8'
    });
    assert.equal(JSON.parse(okRun).ok, true);

    await writeFile(join(appRoot, 'engine', 'package-lock.json'), '{}\n');
    const result = await verifyBundle({ repoRoot: root, appRoot });
    assert.equal(result.ok, false);
    const lockfileMismatch = result.mismatches.find(m => m.kind === 'embedded-lockfile');
    assert.ok(lockfileMismatch, JSON.stringify(result.mismatches));
    assert.match(lockfileMismatch.detail, /lockfile/);

    let failed = null;
    try {
      execFileSync(process.execPath, [CLI, '--check', '--repo-root', root, '--app-root', appRoot], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'the CLI must exit non-zero when the bundle drifts');
    assert.equal(failed.status, 1);
    const reported = JSON.parse(failed.stdout);
    assert.equal(reported.ok, false);
    assert.ok(reported.mismatches.some(m => m.kind === 'embedded-lockfile'));
  } finally {
    await cleanup(root);
  }
});
