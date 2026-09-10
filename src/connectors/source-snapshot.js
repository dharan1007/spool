import { open, realpath, mkdir, rename, unlink, stat, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';

export const SOURCE_SNAPSHOT_ALGORITHM = 'spool-source-snapshot-v1';
const COPY_CHUNK_BYTES = 64 * 1024;
const SNAPSHOT_ID = /^sha256:[a-f0-9]{64}$/;

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

function validateSourcePath(path) {
  if (typeof path !== 'string' || !path.trim()) fail('INVALID_SOURCE_PATH', 'Source path must be a non-empty string');
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('INVALID_SOURCE_LIMIT', 'maxBytes must be a positive safe integer');
}

function validateSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) fail('INVALID_SOURCE_SNAPSHOT', 'snapshotId must be a canonical sha256 identity');
}

function sameFileState(before, after) {
  return after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs &&
    after.ino === before.ino &&
    after.dev === before.dev;
}

function snapshotRecord(path, size, contentSha256) {
  const identity = { kind: 'file', path, size, contentSha256 };
  const snapshotId = sha256Canonical(SOURCE_SNAPSHOT_ALGORITHM, identity);
  return freezeRecord({ snapshotAlgorithm: SOURCE_SNAPSHOT_ALGORITHM, snapshotId, ...identity });
}

export function durableSnapshotPath(snapshotDir, snapshotId) {
  if (typeof snapshotDir !== 'string' || !snapshotDir.trim()) fail('INVALID_SNAPSHOT_DIR', 'snapshotDir must be a non-empty string');
  validateSnapshotId(snapshotId);
  return join(snapshotDir, `${snapshotId.slice('sha256:'.length)}.csv`);
}

async function writeAll(handle, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset, null);
    if (bytesWritten <= 0) throw new Error('Snapshot write made no progress');
    offset += bytesWritten;
  }
}

async function hashHandle(handle, { maxBytes = Number.MAX_SAFE_INTEGER, destination = null } = {}) {
  validateMaxBytes(maxBytes);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > maxBytes) fail('SOURCE_TOO_LARGE', `Local runner source exceeds ${maxBytes} byte limit`, { bytes, limit: maxBytes });
    const slice = buffer.subarray(0, bytesRead);
    hash.update(slice);
    if (destination) await writeAll(destination, slice, bytesRead);
  }
  return { bytes, contentSha256: hash.digest('hex') };
}

async function hashFile(path, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('INVALID_SOURCE_PATH', 'Source path must resolve to a regular file');
    const digest = await hashHandle(handle, { maxBytes });
    return { info, ...digest };
  } finally {
    await handle.close();
  }
}

async function snapshotFileMatches(path, snapshot) {
  try {
    const result = await hashFile(path, { maxBytes: Math.max(1, snapshot.size) });
    return result.bytes === snapshot.size && result.contentSha256 === snapshot.contentSha256;
  } catch {
    return false;
  }
}

export async function readFileSnapshot(path) {
  validateSourcePath(path);
  const resolvedPath = await realpath(path);
  const handle = await open(resolvedPath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('INVALID_SOURCE_PATH', 'Source path must resolve to a regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileState(info, after)) {
      fail('SOURCE_CHANGED_DURING_SNAPSHOT', 'Source changed while its snapshot was being created');
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    return Object.freeze({ snapshot: snapshotRecord(resolvedPath, info.size, contentSha256), bytes });
  } finally {
    await handle.close();
  }
}

export async function createFileSnapshot(path) {
  return (await readFileSnapshot(path)).snapshot;
}

export async function createDurableFileSnapshot(path, { snapshotDir, maxBytes } = {}) {
  validateSourcePath(path);
  if (typeof snapshotDir !== 'string' || !snapshotDir.trim()) fail('INVALID_SNAPSHOT_DIR', 'snapshotDir must be a non-empty string');
  validateMaxBytes(maxBytes);

  const resolvedPath = await realpath(path);
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  const tempPath = join(snapshotDir, `.snapshot-${process.pid}-${randomUUID()}.tmp`);
  const source = await open(resolvedPath, 'r');
  let destination = null;
  let tempExists = false;
  try {
    const before = await source.stat();
    if (!before.isFile()) fail('INVALID_SOURCE_PATH', 'Source path must resolve to a regular file');
    if (before.size > maxBytes) fail('SOURCE_TOO_LARGE', `Local runner source exceeds ${maxBytes} byte limit`, { bytes: before.size, limit: maxBytes });

    destination = await open(tempPath, 'wx', 0o600);
    tempExists = true;
    const digest = await hashHandle(source, { maxBytes, destination });
    await destination.sync();
    await destination.close();
    destination = null;

    const after = await source.stat();
    if (!sameFileState(before, after) || digest.bytes !== before.size) {
      fail('SOURCE_CHANGED_DURING_SNAPSHOT', 'Source changed while its snapshot was being created');
    }

    const snapshot = snapshotRecord(resolvedPath, digest.bytes, digest.contentSha256);
    const snapshotPath = durableSnapshotPath(snapshotDir, snapshot.snapshotId);
    let reused = false;
    try {
      const existing = await stat(snapshotPath);
      if (existing.isFile() && await snapshotFileMatches(snapshotPath, snapshot)) {
        reused = true;
        await unlink(tempPath);
        tempExists = false;
      } else {
        await unlink(snapshotPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
        await rename(tempPath, snapshotPath);
        tempExists = false;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await rename(tempPath, snapshotPath);
      tempExists = false;
    }
    if (process.platform !== 'win32') await chmod(snapshotPath, 0o600);
    return Object.freeze({ snapshot, snapshotPath, reused });
  } finally {
    if (destination) await destination.close().catch(() => {});
    await source.close().catch(() => {});
    if (tempExists) await unlink(tempPath).catch(() => {});
  }
}

export async function loadDurableFileSnapshot(originalPath, { snapshotDir, snapshotId, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  validateSourcePath(originalPath);
  validateSnapshotId(snapshotId);
  validateMaxBytes(maxBytes);
  const snapshotPath = durableSnapshotPath(snapshotDir, snapshotId);
  let result;
  try { result = await hashFile(snapshotPath, { maxBytes }); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('SOURCE_SNAPSHOT_NOT_AVAILABLE', 'Approved durable source snapshot is not available for recovery');
    throw error;
  }
  const snapshot = snapshotRecord(originalPath, result.bytes, result.contentSha256);
  if (snapshot.snapshotId !== snapshotId) fail('SOURCE_SNAPSHOT_CORRUPT', 'Durable source snapshot no longer matches its approved semantic identity');
  return Object.freeze({ snapshot, snapshotPath, reused: true });
}

export async function verifyFileAgainstSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.snapshotAlgorithm !== SOURCE_SNAPSHOT_ALGORITHM ||
      typeof snapshot.path !== 'string' || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0 ||
      !/^[a-f0-9]{64}$/.test(snapshot.contentSha256 ?? '') || !SNAPSHOT_ID.test(snapshot.snapshotId ?? '')) {
    fail('INVALID_SOURCE_SNAPSHOT', 'A valid file source snapshot is required');
  }
  let resolvedPath;
  try { resolvedPath = await realpath(snapshot.path); }
  catch { fail('SOURCE_CHANGED', 'Source file is no longer available at the approved path'); }
  if (resolvedPath !== snapshot.path) fail('SOURCE_CHANGED', 'Source path changed since approval');
  let result;
  try { result = await hashFile(resolvedPath, { maxBytes: Math.max(1, snapshot.size + 1) }); }
  catch (error) {
    if (error?.code === 'SOURCE_TOO_LARGE') fail('SOURCE_CHANGED', 'Source size changed since approval');
    throw error;
  }
  if (result.bytes !== snapshot.size || result.contentSha256 !== snapshot.contentSha256) {
    fail('SOURCE_CHANGED', 'Source content changed since approval', {
      expectedSnapshotId: snapshot.snapshotId,
      expectedSize: snapshot.size,
      actualSize: result.bytes
    });
  }
  const actual = snapshotRecord(resolvedPath, result.bytes, result.contentSha256);
  if (actual.snapshotId !== snapshot.snapshotId) fail('SOURCE_CHANGED', 'Source snapshot identity changed since approval');
  return true;
}

export async function removeDurableFileSnapshot(snapshotPath) {
  if (typeof snapshotPath !== 'string' || !snapshotPath.trim()) fail('INVALID_SNAPSHOT_PATH', 'snapshotPath must be a non-empty string');
  try { await unlink(snapshotPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
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
