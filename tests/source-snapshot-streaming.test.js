import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDurableFileSnapshot,
  verifyFileAgainstSnapshot,
  removeDurableFileSnapshot,
  readFileSnapshot
} from '../src/connectors/source-snapshot.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-snapshot-stream-'));
  const sourcePath = join(dir, 'source.csv');
  const snapshotDir = join(dir, '.snapshots');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n', 'utf8');
  return { dir, sourcePath, snapshotDir };
}

test('durable snapshot preserves the existing semantic snapshot identity and is reusable', async () => {
  const f = await fixture();
  try {
    const old = await readFileSnapshot(f.sourcePath);
    const first = await createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 1024 * 1024 });
    const second = await createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 1024 * 1024 });
    assert.equal(first.snapshot.snapshotId, old.snapshot.snapshotId);
    assert.equal(first.snapshot.contentSha256, old.snapshot.contentSha256);
    assert.equal(first.snapshot.path, old.snapshot.path);
    assert.equal(first.snapshotPath, second.snapshotPath);
    assert.equal(second.reused, true);
    assert.match(first.snapshotPath, new RegExp(`${first.snapshot.snapshotId}\\.csv$`));
    assert.equal(await verifyFileAgainstSnapshot(first.snapshot), true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('durable snapshot enforces the local source ceiling while copying', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 8 }),
      error => error?.code === 'SOURCE_TOO_LARGE'
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('source revalidation fails closed after the original source changes', async () => {
  const f = await fixture();
  try {
    const durable = await createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 1024 * 1024 });
    await appendFile(f.sourcePath, '3,Grace\n', 'utf8');
    await assert.rejects(verifyFileAgainstSnapshot(durable.snapshot), error => error?.code === 'SOURCE_CHANGED');
    const snapText = await import('node:fs/promises').then(fs => fs.readFile(durable.snapshotPath, 'utf8'));
    assert.equal(snapText, 'id,name\n1,Ada\n2,Lin\n');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('durable snapshot uses owner-only file permissions on POSIX and can be explicitly removed', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are not authoritative on Windows');
  const f = await fixture();
  try {
    const durable = await createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 1024 * 1024 });
    const info = await stat(durable.snapshotPath);
    assert.equal(info.mode & 0o077, 0);
    await removeDurableFileSnapshot(durable.snapshotPath);
    await assert.rejects(access(durable.snapshotPath));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
