import { WorkspaceLockedError, WorkspaceWriteLock } from './workspace-lock.js';
import { fail, SpoolError } from '../core/errors.js';

const DB_NAME = 'spool-local-runtime';
const DB_VERSION = 1;
const CHUNK_SIZE = 2000;

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
});

export class IndexedDbWorkspaceStore {
  constructor({ writeLock = new WorkspaceWriteLock(), storageManager = globalThis.navigator?.storage ?? null } = {}) {
    this.dbPromise = null;
    this.writeLock = writeLock;
    this.storageManager = storageManager;
    this.writeLockResult = null;
    this.cache = { fingerprint: null, outputJobId: null, outputRevision: null, outputLength: 0 };
  }

  async preflight(requiredBytes) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) fail('INVALID_STORAGE_PREFLIGHT', 'requiredBytes must be a non-negative safe integer');
    if (!this.storageManager?.estimate) return Object.freeze({ supported: false, requiredBytes, availableBytes: null });
    let estimate;
    try { estimate = await this.storageManager.estimate(); }
    catch { fail('STORAGE_ESTIMATE_FAILED', 'Browser storage capacity could not be estimated'); }
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage ?? 0);
    if (!Number.isFinite(quota) || quota < 0 || !Number.isFinite(usage) || usage < 0) fail('STORAGE_ESTIMATE_FAILED', 'Browser returned an invalid storage estimate');
    const availableBytes = Math.max(0, Math.floor(quota - usage));
    if (requiredBytes > availableBytes) {
      fail('STORAGE_CAPACITY_INSUFFICIENT', 'Browser storage does not have enough headroom for the durable migration workspace', { requiredBytes, availableBytes, quota: Math.floor(quota), usage: Math.floor(usage) });
    }
    return Object.freeze({ supported: true, requiredBytes, availableBytes, quota: Math.floor(quota), usage: Math.floor(usage) });
  }

  async ensureWriteLock() {
    if (this.writeLockResult) return this.writeLockResult;
    const result = await this.writeLock.acquire();
    if (!result.acquired) throw new WorkspaceLockedError();
    this.writeLockResult = result;
    return result;
  }

  async db() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = (async () => {
      await this.ensureWriteLock();
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('sourceChunks')) db.createObjectStore('sourceChunks', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('outputChunks')) db.createObjectStore('outputChunks', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another SPOOL tab'));
      });
    })().catch(async error => {
      this.dbPromise = null;
      this.writeLockResult = null;
      await this.writeLock.release?.();
      throw error;
    });
    return this.dbPromise;
  }

  async load() {
    const db = await this.db();
    const tx = db.transaction(['meta', 'sourceChunks', 'outputChunks'], 'readonly');
    const metaReq = tx.objectStore('meta').get('active');
    const sourceReq = tx.objectStore('sourceChunks').getAll();
    const outputReq = tx.objectStore('outputChunks').getAll();
    const [record, sourceChunks, outputChunks] = await Promise.all([
      requestResult(metaReq), requestResult(sourceReq), requestResult(outputReq), txDone(tx)
    ]).then(values => values.slice(0, 3));
    if (!record?.workspace) return null;

    const workspace = structuredClone(record.workspace);
    if (workspace.source) {
      const rows = sourceChunks
        .filter(chunk => chunk.fingerprint === workspace.source.fingerprint)
        .sort((a, b) => a.index - b.index)
        .flatMap(chunk => chunk.rows);
      workspace.source.rows = rows;
    }
    workspace.output = outputChunks
      .filter(chunk => chunk.jobId === workspace.job.jobId && chunk.revision === workspace.outputRevision)
      .sort((a, b) => a.start - b.start)
      .flatMap(chunk => chunk.rows);

    this.cache = {
      fingerprint: workspace.source?.fingerprint ?? null,
      outputJobId: workspace.job.jobId,
      outputRevision: workspace.outputRevision,
      outputLength: workspace.output.length
    };
    return workspace;
  }

  async save(workspace) {
    try {
      const db = await this.db();
      const tx = db.transaction(['meta', 'sourceChunks', 'outputChunks'], 'readwrite');
      const metaStore = tx.objectStore('meta');
      const sourceStore = tx.objectStore('sourceChunks');
      const outputStore = tx.objectStore('outputChunks');

      const fingerprint = workspace.source?.fingerprint ?? null;
      if (fingerprint !== this.cache.fingerprint) {
        sourceStore.clear();
        if (workspace.source?.rows) {
          for (let start = 0, index = 0; start < workspace.source.rows.length; start += CHUNK_SIZE, index++) {
            sourceStore.put({ id: `${fingerprint}:${index}`, fingerprint, index, rows: workspace.source.rows.slice(start, start + CHUNK_SIZE) });
          }
        }
      }

      const outputIdentityChanged = workspace.job.jobId !== this.cache.outputJobId || workspace.outputRevision !== this.cache.outputRevision;
      const outputRewound = workspace.output.length < this.cache.outputLength;
      if (outputIdentityChanged || outputRewound) {
        outputStore.clear();
        this.cache.outputLength = 0;
      }
      if (workspace.output.length > this.cache.outputLength) {
        const start = this.cache.outputLength;
        const added = workspace.output.slice(start);
        for (let offset = 0; offset < added.length; offset += CHUNK_SIZE) {
          const rows = added.slice(offset, offset + CHUNK_SIZE);
          const absoluteStart = start + offset;
          outputStore.put({ id: `${workspace.job.jobId}:${workspace.outputRevision}:${absoluteStart}`, jobId: workspace.job.jobId, revision: workspace.outputRevision, start: absoluteStart, rows });
        }
      }

      const compact = structuredClone(workspace);
      if (compact.source) delete compact.source.rows;
      delete compact.output;
      metaStore.put({ key: 'active', workspace: compact });
      await txDone(tx);

      this.cache = { fingerprint, outputJobId: workspace.job.jobId, outputRevision: workspace.outputRevision, outputLength: workspace.output.length };
    } catch (error) {
      if (error instanceof SpoolError || error instanceof WorkspaceLockedError) throw error;
      fail('STORAGE_WRITE_FAILED', 'Browser workspace could not be persisted durably', { causeName: error?.name ?? 'Error' });
    }
  }

  async clear() {
    const db = await this.db();
    const tx = db.transaction(['meta', 'sourceChunks', 'outputChunks'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('sourceChunks').clear();
    tx.objectStore('outputChunks').clear();
    await txDone(tx);
    this.cache = { fingerprint: null, outputJobId: null, outputRevision: null, outputLength: 0 };
  }
}