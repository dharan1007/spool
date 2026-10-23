import { WorkerMessageGate } from './worker-protocol.js';

export class BrowserWorkerRuntime {
  constructor({
    workerUrl = new URL('../worker/migration.worker.js', import.meta.url),
    workerFactory = (url, options) => new Worker(url, options)
  } = {}) {
    this.workerUrl = workerUrl;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.gate = null;
    this.handlers = null;
    this.pauseResolve = null;
    this.pauseTimer = null;
  }

  releaseWorker() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.gate = null;
    this.handlers = null;
    if (this.pauseResolve) this.resolvePause();
  }

  async start(payload, handlers) {
    await this.abort();
    this.handlers = handlers;
    this.gate = new WorkerMessageGate({ jobId: payload.jobId, revision: payload.revision });
    const worker = this.workerFactory(this.workerUrl, { type: 'module', name: `spool-${payload.jobId}` });
    this.worker = worker;
    worker.onmessage = event => {
      const message = event.data;
      if (!this.gate?.accept(message)) return;
      if (message.type === 'progress') this.handlers?.onProgress?.(message.payload);
      else if (message.type === 'complete') {
        const onComplete = this.handlers?.onComplete;
        onComplete?.(message.payload);
        this.releaseWorker();
      } else if (message.type === 'paused') this.resolvePause();
      else if (message.type === 'error') {
        const onError = this.handlers?.onError;
        onError?.(message.error);
        this.releaseWorker();
      }
    };
    worker.onerror = event => {
      const onError = this.handlers?.onError;
      onError?.({ code: 'WORKER_CRASH', message: event.message || 'Migration worker crashed' });
      this.releaseWorker();
    };
    worker.postMessage({ type: 'start', payload });
  }

  async pause() {
    if (!this.worker) return;
    if (this.pauseResolve) return;
    return new Promise((resolve, reject) => {
      this.pauseResolve = resolve;
      this.pauseTimer = setTimeout(() => {
        this.pauseResolve = null;
        this.pauseTimer = null;
        reject(new Error('Worker did not acknowledge pause within 3 seconds'));
      }, 3000);
      this.worker.postMessage({ type: 'pause' });
    });
  }

  resolvePause() {
    if (!this.pauseResolve) return;
    clearTimeout(this.pauseTimer);
    const resolve = this.pauseResolve;
    this.pauseResolve = null;
    this.pauseTimer = null;
    resolve();
  }

  async abort() {
    this.releaseWorker();
  }
}
