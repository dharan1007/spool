import { access, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../core/errors.js';
import { inferSchema } from '../core/schema.js';
import { formatFromResource, readAllRows, readRowBatches, serializeRows, sha256File } from './file-formats.js';

const CAPABILITIES = Object.freeze({
  source: true,
  target: true,
  discover: true,
  streaming: true,
  transactions: false,
  bulkWrite: false,
  upsert: false,
  ddl: false,
  rollback: false,
  checksum: true,
  pagination: true,
  rateLimitAware: false
});

function resolveWithinRoot(root, resource) {
  if (typeof resource !== 'string' || !resource.trim()) fail('INVALID_RESOURCE', 'Filesystem resource is required');
  const base = path.resolve(root);
  const resolved = path.resolve(base, resource);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    fail('PATH_OUTSIDE_ROOT', 'Filesystem resource escapes the configured root');
  }
  return resolved;
}

function durableOffset(cursor) {
  if (cursor == null) return 0;
  if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    fail('INVALID_SOURCE_CURSOR', 'Filesystem cursor.offset must be a non-negative safe integer');
  }
  return cursor.offset;
}

async function collectRows(batches) {
  const rows = [];
  for await (const batch of batches) {
    if (!batch || !Array.isArray(batch.rows)) fail('INVALID_ROW_BATCH', 'Filesystem write requires row batches');
    rows.push(...batch.rows);
  }
  return rows;
}

export class FilesystemConnector {
  constructor(config = {}) {
    this.config = structuredClone(config);
  }

  manifest() {
    return { name: 'filesystem', version: '1.0.0', capabilities: { ...CAPABILITIES } };
  }

  async validateConfig(config = this.config) {
    if (!config || typeof config.root !== 'string' || !config.root.trim()) fail('INVALID_FILESYSTEM_CONFIG', 'Filesystem connector requires root');
    const root = path.resolve(config.root);
    await mkdir(root, { recursive: true });
    return { root };
  }

  async testConnection(ctx = {}) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    try { await access(connection.root); }
    catch (error) { fail('FILESYSTEM_UNAVAILABLE', `Filesystem root is not accessible: ${error.message}`); }
    return { ok: true, root: connection.root };
  }

  async discover(ctx = {}, request = {}) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    const filePath = resolveWithinRoot(connection.root, request.resource);
    const format = formatFromResource(request.resource);
    const info = await stat(filePath).catch(error => fail('RESOURCE_NOT_FOUND', `Filesystem resource not found: ${error.message}`));
    if (!info.isFile()) fail('INVALID_RESOURCE', 'Filesystem resource must be a file');
    const rows = await readAllRows(filePath, format);
    return {
      resource: request.resource,
      format,
      bytes: info.size,
      rowCount: rows.length,
      schema: inferSchema(rows),
      identity: await sha256File(filePath)
    };
  }

  async *read(ctx = {}, request = {}) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    const filePath = resolveWithinRoot(connection.root, request.resource);
    const format = formatFromResource(request.resource);
    const startOffset = durableOffset(request.cursor);

    for await (const batch of readRowBatches(filePath, format, request.batchSize ?? 500)) {
      const batchEnd = batch.cursor?.offset;
      if (!Number.isSafeInteger(batchEnd)) fail('INVALID_CONNECTOR_STREAM', 'Filesystem batch cursor is missing an offset');
      const batchStart = batchEnd - batch.rows.length;
      if (batchEnd <= startOffset) continue;
      const sliceFrom = Math.max(0, startOffset - batchStart);
      const rows = sliceFrom ? batch.rows.slice(sliceFrom) : batch.rows;
      if (rows.length) yield { ...batch, rows };
    }
  }

  async planWrite(ctx = {}, request = {}) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    const filePath = resolveWithinRoot(connection.root, request.resource);
    const format = formatFromResource(request.resource);
    if (!['replace', 'append'].includes(request.mode ?? 'replace')) fail('UNSUPPORTED_WRITE_MODE', 'Filesystem supports replace or append');
    return {
      strategy: 'atomic_replace',
      atomic: true,
      resource: request.resource,
      format,
      path: filePath,
      requiredCapabilities: ['target']
    };
  }

  async write(ctx = {}, request = {}, batches = []) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    const filePath = resolveWithinRoot(connection.root, request.resource);
    const format = formatFromResource(request.resource);
    const mode = request.mode ?? 'replace';
    if (!['replace', 'append'].includes(mode)) fail('UNSUPPORTED_WRITE_MODE', 'Filesystem supports replace or append');

    const incoming = await collectRows(batches);
    let rows = incoming;
    if (mode === 'append') {
      try { rows = [...await readAllRows(filePath, format), ...incoming]; }
      catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'RESOURCE_NOT_FOUND') throw error;
      }
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.spool-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(serializeRows(rows, format), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);

    return {
      committedRows: incoming.length,
      checkpointToken: `rows:${rows.length}`,
      targetRows: rows.length,
      sha256: await sha256File(filePath)
    };
  }

  async verify(ctx = {}, request = {}) {
    const connection = ctx.connection ?? await this.validateConfig(this.config);
    const filePath = resolveWithinRoot(connection.root, request.resource);
    const format = formatFromResource(request.resource);
    const rows = await readAllRows(filePath, format);
    const sha256 = await sha256File(filePath);
    const expected = request.expectedRows;
    const countOk = expected == null || rows.length === expected;
    return {
      ok: countOk,
      targetRows: rows.length,
      sha256,
      checks: [
        { name: 'target_count', ok: countOk, expected: expected ?? null, actual: rows.length },
        { name: 'sha256', ok: true, value: sha256 }
      ]
    };
  }

  async close() {}
}
