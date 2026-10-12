import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, unlink, rm, chmod, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { markDisposableQualification } from '../src/platform/disposable-qualification.js';
import { secureSnapshotPath, verifySnapshotPrivacy } from '../src/connectors/snapshot-permissions.js';
import { createDurableFileSnapshot, loadDurableFileSnapshot } from '../src/connectors/source-snapshot.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spool-snapshot-acl-'));
  await markDisposableQualification(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source.csv');
  await writeFile(source, 'id,name\n1,Ada\n');
  return { root, source, snapshots: join(root, 'snapshots') };
}

test('empty snapshot directory and file are private before their first content write', async t => {
  const f = await fixture(t);
  await mkdir(f.snapshots);
  await secureSnapshotPath(f.snapshots, { directory: true });
  const empty = join(f.snapshots, 'empty.tmp');
  await writeFile(empty, '', { flag: 'wx', mode: 0o600 });
  await secureSnapshotPath(empty);
  await verifySnapshotPrivacy(empty);
  assert.equal(await readFile(empty, 'utf8'), '');
  await writeFile(empty, 'owner-readable bytes');
  assert.equal(await readFile(empty, 'utf8'), 'owner-readable bytes');
  await verifySnapshotPrivacy(empty);
});

test('snapshot creation, atomic rename, reuse and recovery retain private permissions', async t => {
  const f = await fixture(t);
  const options = { snapshotDir: f.snapshots, maxBytes: 1024 };
  const first = await createDurableFileSnapshot(f.source, options);
  await verifySnapshotPrivacy(first.snapshotPath);
  const second = await createDurableFileSnapshot(f.source, options);
  assert.equal(second.reused, true);
  const loaded = await loadDurableFileSnapshot(first.snapshot.path, { ...options, snapshotId: first.snapshot.snapshotId });
  assert.equal(loaded.snapshot.contentSha256, first.snapshot.contentSha256);
  assert.equal(await readFile(loaded.snapshotPath, 'utf8'), 'id,name\n1,Ada\n');
  assert.equal((await readdir(f.snapshots)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('broadened snapshot permissions refuse recovery and reuse without reading approved bytes', async t => {
  const f = await fixture(t);
  const options = { snapshotDir: f.snapshots, maxBytes: 1024 };
  const first = await createDurableFileSnapshot(f.source, options);
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [first.snapshotPath, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
  } else await chmod(first.snapshotPath, 0o644);
  await assert.rejects(loadDurableFileSnapshot(first.snapshot.path, { ...options, snapshotId: first.snapshot.snapshotId }), { code: 'SOURCE_SNAPSHOT_PRIVACY_FAILED' });
  await assert.rejects(createDurableFileSnapshot(f.source, options), { code: 'SOURCE_SNAPSHOT_PRIVACY_FAILED' });
  assert.equal((await readdir(f.snapshots)).filter(name => name.endsWith('.tmp')).length, 0);
  await secureSnapshotPath(first.snapshotPath);
  await verifySnapshotPrivacy(first.snapshotPath);
});

test('hardlinked snapshots fail closed without changing their shared security descriptor', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias.csv');
  await link(f.source, alias);
  await assert.rejects(secureSnapshotPath(alias), { code: 'SOURCE_SNAPSHOT_PRIVACY_FAILED' });
  assert.equal(await readFile(f.source, 'utf8'), 'id,name\n1,Ada\n');
  await unlink(alias);
});

test('junction or symlink snapshot directories are refused without changing the target', async t => {
  const f = await fixture(t);
  const real = join(f.root, 'real');
  await mkdir(real);
  await symlink(real, f.snapshots, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDurableFileSnapshot(f.source, { snapshotDir: f.snapshots, maxBytes: 1024 }), { code: 'SOURCE_SNAPSHOT_PRIVACY_FAILED' });
  assert.deepEqual(await readdir(real), []);
  await unlink(f.snapshots);
});

test('linked ancestors are refused before creating a snapshot directory', async t => {
  const f = await fixture(t);
  const real = join(f.root, 'real');
  await mkdir(real);
  await symlink(real, f.snapshots, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDurableFileSnapshot(f.source, { snapshotDir: join(f.snapshots, 'nested'), maxBytes: 1024 }), { code: 'SOURCE_SNAPSHOT_PRIVACY_FAILED' });
  assert.deepEqual(await readdir(real), []);
  await unlink(f.snapshots);
});
