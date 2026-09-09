import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';

export const SOURCE_SNAPSHOT_ALGORITHM = 'spool-source-snapshot-v1';

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

export async function createFileSnapshot(path) {
  if (typeof path !== 'string' || !path.trim()) fail('INVALID_SOURCE_PATH', 'Source path must be a non-empty string');
  const resolvedPath = await realpath(path);
  const info = await stat(resolvedPath);
  if (!info.isFile()) fail('INVALID_SOURCE_PATH', 'Source path must resolve to a regular file');
  const bytes = await readFile(resolvedPath);
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  const identity = {
    kind: 'file',
    path: resolvedPath,
    size: info.size,
    contentSha256
  };
  const snapshotId = sha256Canonical(SOURCE_SNAPSHOT_ALGORITHM, identity);
  return freezeRecord({
    snapshotAlgorithm: SOURCE_SNAPSHOT_ALGORITHM,
    snapshotId,
    ...identity
  });
}

export function assertSnapshotBinding(expected, actual) {
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') {
    fail('INVALID_SOURCE_SNAPSHOT', 'Source snapshots are required');
  }
  if (expected.snapshotId !== actual.snapshotId) {
    fail('SOURCE_CHANGED', 'Source snapshot changed since the migration checkpoint', {
      expectedSnapshotId: expected.snapshotId,
      actualSnapshotId: actual.snapshotId
    });
  }
  return true;
}
