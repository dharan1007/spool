import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';

export const MATERIALIZED_SNAPSHOT_ALGORITHM = 'spool-materialized-source-v1';
const SNAPSHOT_ID = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_CHUNK_ROWS = 10_000;
const MAX_CHUNK_ROWS = 100_000;
const DEFAULT_MAX_CHUNK_BYTES = 16 * 1024 * 1024;

function requirePlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, message);
  return value;
}

function requireSnapshotDir(snapshotDir) {
  if (typeof snapshotDir !== 'string' || !snapshotDir.trim()) fail('INVALID_SNAPSHOT_DIR', 'snapshotDir must be a non-empty string');
  return snapshotDir;
}

function requireSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) fail('INVALID_SOURCE_SNAPSHOT', 'snapshotId must be a canonical sha256 identity');
  return snapshotId;
}

function requireChunkRows(value) {
  const chunkRows = value ?? DEFAULT_CHUNK_ROWS;
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1 || chunkRows > MAX_CHUNK_ROWS) {
    fail('INVALID_MATERIALIZATION_CONFIG', `chunkRows must be between 1 and ${MAX_CHUNK_ROWS}`);
  }
  return chunkRows;
}

function requireMaxChunkBytes(value) {
  const maxChunkBytes = value ?? DEFAULT_MAX_CHUNK_BYTES;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1024) fail('INVALID_MATERIALIZATION_CONFIG', 'maxChunkBytes must be at least 1024');
  return maxChunkBytes;
}

function immutable(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = immutable(item);
  return Object.freeze(out);
}

function semanticManifest({ sourceState, contract, contractId, sourceIdentity, chunkRows, chunks, rowCount, byteCount }) {
  return {
    schemaVersion: 1,
    snapshotAlgorithm: MATERIALIZED_SNAPSHOT_ALGORITHM,
    sourceState,
    sourceStateId: sourceState.sourceStateId,
    contract,
    contractId,
    sourceIdentity: sourceIdentity ?? null,
    chunkRows,
    chunks,
    rowCount,
    byteCount
  };
}

function finalSnapshotPath(snapshotDir, snapshotId) {
  requireSnapshotDir(snapshotDir);
  requireSnapshotId(snapshotId);
  return join(snapshotDir, snapshotId.slice('sha256:'.length));
}

async function syncTextFile(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

async function writeChunk({ chunksDir, index, rows, start, endExclusive }) {
  const file = `${String(index).padStart(8, '0')}.ndjson`;
  const path = join(chunksDir, file);
  const text = rows.join('');
  const bytes = Buffer.byteLength(text, 'utf8');
  const contentSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  await syncTextFile(path, text);
  return Object.freeze({
    index,
    file,
    sourceRange: Object.freeze({ start, endExclusive }),
    rowCount: endExclusive - start,
    byteCount: bytes,
    contentSha256
  });
}

async function verifyChunk(path, expected) {
  let info;
  try { info = await stat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('SOURCE_SNAPSHOT_NOT_AVAILABLE', `Materialized source chunk ${expected.file} is missing`);
    throw error;
  }
  if (!info.isFile()) fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${expected.file} is not a regular file`);
  const hash = createHash('sha256');
  let byteCount = 0;
  let rowCount = 0;
  const input = createReadStream(path);
  input.on('data', chunk => { byteCount += chunk.length; hash.update(chunk); });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${expected.file} contains an empty row`);
    let row;
    try { row = JSON.parse(line); }
    catch { fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${expected.file} contains invalid JSON`); }
    if (canonicalJson(row) !== line) fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${expected.file} contains non-canonical row bytes`);
    rowCount += 1;
  }
  if (byteCount !== expected.byteCount || rowCount !== expected.rowCount || hash.digest('hex') !== expected.contentSha256) {
    fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${expected.file} failed integrity verification`);
  }
}

function validateManifestShape(manifest, snapshotId) {
  requirePlainObject(manifest, 'SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest must be an object');
  if (manifest.schemaVersion !== 1 || manifest.snapshotAlgorithm !== MATERIALIZED_SNAPSHOT_ALGORITHM) fail('SOURCE_SNAPSHOT_CORRUPT', 'Unsupported materialized source manifest');
  if (manifest.snapshotId !== snapshotId) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest identity does not match requested snapshot');
  if (!manifest.sourceState || manifest.sourceState.sourceStateId !== manifest.sourceStateId) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest has invalid SourceState binding');
  if (typeof manifest.contractId !== 'string' || !SNAPSHOT_ID.test(manifest.contractId)) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest has invalid contract identity');
  if (!Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 0 || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 0) {
    fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest has invalid accounting');
  }
  let next = 0;
  let rows = 0;
  let bytes = 0;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const chunk = manifest.chunks[index];
    if (!chunk || chunk.index !== index || chunk.file !== `${String(index).padStart(8, '0')}.ndjson`) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest has invalid chunk ordering');
    if (chunk.sourceRange?.start !== next || chunk.sourceRange?.endExclusive !== next + chunk.rowCount) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest has non-contiguous source ranges');
    if (!Number.isSafeInteger(chunk.rowCount) || chunk.rowCount < 1 || !Number.isSafeInteger(chunk.byteCount) || chunk.byteCount < 1 || !/^[a-f0-9]{64}$/.test(chunk.contentSha256 ?? '')) {
      fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest contains invalid chunk metadata');
    }
    next = chunk.sourceRange.endExclusive;
    rows += chunk.rowCount;
    bytes += chunk.byteCount;
  }
  if (rows !== manifest.rowCount || bytes !== manifest.byteCount || next !== manifest.rowCount) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest accounting does not balance');
  const { snapshotId: _snapshotId, ...semantic } = manifest;
  const expected = sha256Canonical(MATERIALIZED_SNAPSHOT_ALGORITHM, semantic);
  if (expected !== snapshotId) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest root identity is invalid');
}

export async function loadMaterializedSnapshot({ snapshotDir, snapshotId } = {}) {
  requireSnapshotDir(snapshotDir);
  requireSnapshotId(snapshotId);
  const snapshotPath = finalSnapshotPath(snapshotDir, snapshotId);
  let text;
  try { text = await readFile(join(snapshotPath, 'manifest.json'), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('SOURCE_SNAPSHOT_NOT_AVAILABLE', 'Approved materialized source snapshot is not available');
    throw error;
  }
  let manifest;
  try { manifest = JSON.parse(text); }
  catch { fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source manifest is invalid JSON'); }
  validateManifestShape(manifest, snapshotId);
  for (const chunk of manifest.chunks) await verifyChunk(join(snapshotPath, 'chunks', chunk.file), chunk);
  return Object.freeze({ snapshot: immutable(manifest), snapshotPath, reused: true });
}

export async function materializeSnapshotBatches({ snapshotDir, sourceState, contract, contractId, sourceIdentity = null, batches, chunkRows, maxChunkBytes } = {}) {
  requireSnapshotDir(snapshotDir);
  requirePlainObject(sourceState, 'INVALID_SOURCE_STATE', 'sourceState is required for materialization');
  if (typeof sourceState.sourceStateId !== 'string' || !SNAPSHOT_ID.test(sourceState.sourceStateId)) fail('INVALID_SOURCE_STATE', 'sourceState.sourceStateId must be canonical');
  requirePlainObject(contract, 'INVALID_SOURCE_CONTRACT', 'source contract is required for materialization');
  if (typeof contractId !== 'string' || !SNAPSHOT_ID.test(contractId)) fail('INVALID_SOURCE_CONTRACT', 'contractId must be canonical');
  if (!batches || typeof batches[Symbol.asyncIterator] !== 'function') fail('INVALID_MATERIALIZATION_SOURCE', 'batches must be an async iterable');
  const rowsPerChunk = requireChunkRows(chunkRows);
  const chunkByteLimit = requireMaxChunkBytes(maxChunkBytes);

  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  const partialPath = join(snapshotDir, `.materialize-${process.pid}-${randomUUID()}.partial`);
  const chunksDir = join(partialPath, 'chunks');
  await mkdir(chunksDir, { recursive: true, mode: 0o700 });

  const chunks = [];
  let pending = [];
  let pendingBytes = 0;
  let pendingStart = 0;
  let nextSourceOffset = 0;
  let byteCount = 0;
  let published = false;

  const flush = async () => {
    if (!pending.length) return;
    const endExclusive = pendingStart + pending.length;
    const chunk = await writeChunk({ chunksDir, index: chunks.length, rows: pending, start: pendingStart, endExclusive });
    chunks.push(chunk);
    byteCount += chunk.byteCount;
    pending = [];
    pendingBytes = 0;
    pendingStart = endExclusive;
  };

  try {
    for await (const batch of batches) {
      if (!batch || batch.sourceStateId !== sourceState.sourceStateId) fail('SOURCE_DRIFT', 'Materialization batch does not match the bound SourceState');
      if (batch.sourceRange?.start !== nextSourceOffset || batch.sourceRange?.endExclusive !== nextSourceOffset + batch.rows?.length) {
        fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialization source ranges are not contiguous');
      }
      for (const row of batch.rows) {
        const line = `${canonicalJson(row)}\n`;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (lineBytes > chunkByteLimit) fail('SOURCE_ROW_TOO_LARGE', 'A single source row exceeds the materialized chunk byte limit');
        if (pending.length && (pending.length >= rowsPerChunk || pendingBytes + lineBytes > chunkByteLimit)) await flush();
        if (!pending.length) pendingStart = nextSourceOffset;
        pending.push(line);
        pendingBytes += lineBytes;
        nextSourceOffset += 1;
      }
      if (nextSourceOffset !== batch.sourceRange.endExclusive) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialization batch accounting is invalid');
    }
    await flush();

    const semantic = semanticManifest({
      sourceState,
      contract,
      contractId,
      sourceIdentity,
      chunkRows: rowsPerChunk,
      chunks,
      rowCount: nextSourceOffset,
      byteCount
    });
    const snapshotId = sha256Canonical(MATERIALIZED_SNAPSHOT_ALGORITHM, semantic);
    const manifest = { ...semantic, snapshotId };
    await syncTextFile(join(partialPath, 'manifest.json'), `${canonicalJson(manifest)}\n`);

    const finalPath = finalSnapshotPath(snapshotDir, snapshotId);
    try {
      const existing = await loadMaterializedSnapshot({ snapshotDir, snapshotId });
      await rm(partialPath, { recursive: true, force: true });
      return existing;
    } catch (error) {
      if (error?.code !== 'SOURCE_SNAPSHOT_NOT_AVAILABLE') throw error;
    }
    await rename(partialPath, finalPath);
    published = true;
    if (process.platform !== 'win32') await chmod(finalPath, 0o700);
    return loadMaterializedSnapshot({ snapshotDir, snapshotId });
  } finally {
    if (!published) await rm(partialPath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function* streamMaterializedRows(materialized) {
  if (!materialized || typeof materialized !== 'object' || !materialized.snapshot || typeof materialized.snapshotPath !== 'string') {
    fail('INVALID_SOURCE_SNAPSHOT', 'A loaded materialized source snapshot is required');
  }
  let rowIndex = 0;
  for (const chunk of materialized.snapshot.chunks) {
    const input = createReadStream(join(materialized.snapshotPath, 'chunks', chunk.file));
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${chunk.file} contains an empty row`);
      let row;
      try { row = JSON.parse(line); }
      catch { fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${chunk.file} contains invalid JSON`); }
      if (canonicalJson(row) !== line) fail('SOURCE_SNAPSHOT_CORRUPT', `Materialized source chunk ${chunk.file} contains non-canonical row bytes`);
      yield Object.freeze({ rowIndex, row: Object.freeze(row) });
      rowIndex += 1;
    }
  }
  if (rowIndex !== materialized.snapshot.rowCount) fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized source row count changed during replay');
}
