import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Durable, crash-recoverable JSON checkpoint for qualification child processes.
// File content is fsync'd before atomic rename, and the containing directory
// is fsync'd after rename. Only ENOENT means "no checkpoint"; corrupt bytes,
// IO failures and permission errors MUST NOT masquerade as a fresh start.
export function createDurableJsonCheckpointStore({ path, onBeforeRename = null } = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('checkpoint path is required');
  if (onBeforeRename != null && typeof onBeforeRename !== 'function') {
    throw new TypeError('onBeforeRename must be a test hook function');
  }
  const dir = dirname(path);
  return Object.freeze({
    async load() {
      let content;
      try { content = await readFile(path, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      // Returning null on invalid/truncated JSON would hide a crash-safety
      // failure and could make the qualification falsely succeed by replay.
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Durable checkpoint must be a JSON object');
      }
      return parsed;
    },
    async save(checkpoint) {
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
        throw new TypeError('Checkpoint must be a JSON object');
      }
      const serialized = JSON.stringify(checkpoint);
      if (typeof serialized !== 'string') throw new TypeError('Checkpoint is not serializable');
      await mkdir(dir, { recursive: true });
      const temp = join(dir, '.' + basename(path) + '.' + process.pid + '.' + randomUUID() + '.tmp');
      let handle = null;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        if (onBeforeRename) await onBeforeRename();
        await rename(temp, path);
        const directoryHandle = await open(dir, 'r');
        try { await directoryHandle.sync(); }
        finally { await directoryHandle.close(); }
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
  });
}
