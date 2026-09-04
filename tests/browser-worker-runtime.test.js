import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkerRuntime } from '../src/runtime/browser-worker-runtime.js';

class FakeWorker {
  constructor() { this.terminated = false; this.messages = []; this.onmessage = null; this.onerror = null; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}

test('browser worker runtime terminates completed workers and releases handlers', async () => {
  const workers = [];
  const runtime = new BrowserWorkerRuntime({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  let completed = 0;
  await runtime.start({ jobId: 'job-1', revision: 2, rows: [], mapping: [], targetSchema: [], startIndex: 0 }, { onComplete: () => { completed++; } });

  workers[0].emit({ type: 'complete', jobId: 'job-1', revision: 2, seq: 1, payload: { processedThrough: 0, totalRows: 0 } });

  assert.equal(completed, 1);
  assert.equal(workers[0].terminated, true);
  assert.equal(runtime.worker, null);
  assert.equal(runtime.handlers, null);
  assert.equal(runtime.gate, null);
});

test('browser worker runtime terminates crashed workers after reporting the error', async () => {
  const workers = [];
  const runtime = new BrowserWorkerRuntime({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  let errorCode = null;
  await runtime.start({ jobId: 'job-2', revision: 1, rows: [], mapping: [], targetSchema: [], startIndex: 0 }, { onError: error => { errorCode = error.code; } });

  workers[0].onerror({ message: 'boom' });

  assert.equal(errorCode, 'WORKER_CRASH');
  assert.equal(workers[0].terminated, true);
  assert.equal(runtime.worker, null);
});
