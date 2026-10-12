import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { markDisposableQualification } from '../src/platform/disposable-qualification.js';
import { verifySnapshotPrivacy } from '../src/connectors/snapshot-permissions.js';
import { execFileSync } from 'node:child_process';
import {
  createDurableFileSnapshot,
  verifyFileAgainstSnapshot,
  removeDurableFileSnapshot,
  readFileSnapshot
} from '../src/connectors/source-snapshot.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-snapshot-stream-'));
  await markDisposableQualification(dir);
  const sourcePath = join(dir, 'source.csv');
  const snapshotDir = join(dir, '.snapshots');
  await writeFile(sourcePath, 'id,name\n1,Ada\n2,Lin\n', 'utf8');
  return { dir, sourcePath, snapshotDir };
}

test('durable snapshot preserves semantic identity, is reusable, and uses a cross-platform-safe filename', async () => {
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
    assert.equal(basename(first.snapshotPath), `${first.snapshot.snapshotId.slice('sha256:'.length)}.csv`);
    assert.equal(basename(first.snapshotPath).includes(':'), false);
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

test('durable snapshot uses private platform permissions and can be explicitly removed', async () => {
  const f = await fixture();
  try {
    const durable = await createDurableFileSnapshot(f.sourcePath, { snapshotDir: f.snapshotDir, maxBytes: 1024 * 1024 });
    await verifySnapshotPrivacy(f.snapshotDir, { directory: true });
    await verifySnapshotPrivacy(durable.snapshotPath);
    if (process.platform === 'win32') {
      const report = execFileSync(process.env.SPOOL_TEST_POWERSHELL || 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$acl=Get-Acl -LiteralPath $env:SPOOL_ACL_TEST_PATH; [pscustomobject]@{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value; inherited=$_.IsInherited;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString()} })} | ConvertTo-Json -Depth 4 -Compress'], { encoding: 'utf8', env: { ...process.env, SPOOL_ACL_TEST_PATH: durable.snapshotPath }, windowsHide: true });
      const acl = JSON.parse(report);
      assert.equal(acl.protected, true);
      assert.deepEqual(acl.rules.map(r => r.sid).sort(), [acl.owner, 'S-1-5-18', 'S-1-5-32-544'].sort());
      assert.ok(acl.rules.every(r => !r.inherited && r.type === 'Allow' && r.rights === 'FullControl'));
      console.log('WINDOWS_SNAPSHOT_ACL=' + report.trim());
    } else {
      const info = await stat(durable.snapshotPath);
      assert.equal(info.mode & 0o077, 0);
    }
    await removeDurableFileSnapshot(durable.snapshotPath);
    await assert.rejects(access(durable.snapshotPath));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
