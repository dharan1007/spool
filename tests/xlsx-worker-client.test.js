import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { xlsxFileToCsvInWorker } from '../src/xlsx-worker-client.js';

const goodFile = { name: 'source.xlsx', size: 19, arrayBuffer: async () => new ArrayBuffer(19) };
const result = { csv: 'id,name\n1,Ada\n', rowCount: 1, sheetName: 'Visible', sheetNames: ['Hidden', 'Visible'], warnings: [] };

function fixture({ onPost, onTerminate } = {}) {
  let worker;
  let terminationCount = 0;
  let messages = [];
  worker = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) {
      messages.push(message);
      if (onPost) onPost(worker, message);
      else queueMicrotask(() => worker.onmessage?.({ data: { type: 'xlsx:complete', result } }));
    },
    terminate() {
      terminationCount += 1;
      onTerminate?.();
    }
  };
  return { createWorker: () => worker, messages, get terminationCount() { return terminationCount; }, worker };
}

test('xlsx worker accepts a genuine File-like source and returns byte-accurate first-visible-sheet CSV', async () => {
  const sample = fixture();
  const actual = await xlsxFileToCsvInWorker(goodFile, sample);
  assert.deepEqual(actual, result);
  assert.equal(sample.terminationCount, 1);
  assert.equal(sample.messages.length, 1);
  assert.equal(sample.messages[0].type, 'xlsx:parse');
  assert.strictEqual(sample.messages[0].file, goodFile);
});

test('worker errors propagate without fallback to main-thread XLSX parser', async () => {
  const sample = fixture({ onPost(worker) {
    queueMicrotask(() => worker.onmessage({ data: { type: 'xlsx:error', message: 'Invalid XLSX ZIP entry integrity' } }));
  } });
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, sample), /Invalid XLSX ZIP entry integrity/);
  assert.equal(sample.terminationCount, 1);
});

test('worker throws on postMessage without leaking an unhandled unresolved Promise', async () => {
  const sample = fixture({ onPost() { throw new DOMException('Data clone failed', 'DataCloneError'); } });
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, sample), /could not be sent/);
  assert.equal(sample.terminationCount, 1);
});

test('worker malformed response fails closed', async () => {
  const sample = fixture({ onPost(worker) {
    queueMicrotask(() => worker.onmessage({ data: { type: 'xlsx:complete', result: { csv: 'made-up' } } }));
  } });
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, sample), /invalid result/);
  assert.equal(sample.terminationCount, 1);
});

test('Worker executable unavailable fails closed rather than parsing 50 MiB on UI thread', async () => {
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, {
    createWorker() { throw new Error('not supported'); }
  }), /could not start: not supported/);
});

test('worker error event and message decoding event are explicit failures', async () => {
  for (const event of ['onerror', 'onmessageerror']) {
    const sample = fixture({ onPost(worker) { queueMicrotask(() => worker[event]()); } });
    await assert.rejects(xlsxFileToCsvInWorker(goodFile, sample), /processor failed|could not be decoded/);
    assert.equal(sample.terminationCount, 1);
  }
});

test('worker timeout is bounded and calls terminate exactly once', async () => {
  const sample = fixture({ onPost() {} });
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, { ...sample, timeoutMs: 2 }), /exceeded its 5-minute safety limit/);
  assert.equal(sample.terminationCount, 1);
});

test('file-size and configuration rejections happen before worker creation', async () => {
  let created = 0;
  const options = { createWorker() { created += 1; return fixture().worker; } };
  await assert.rejects(xlsxFileToCsvInWorker({ ...goodFile, size: 50 * 1024 * 1024 + 1 }, options), /up to 50 MiB/);
  await assert.rejects(xlsxFileToCsvInWorker(null, options), /valid \.xlsx/);
  await assert.rejects(xlsxFileToCsvInWorker(goodFile, { ...options, timeoutMs: 0 }), /timeout must be/);
  assert.equal(created, 0);
});

test('production XLSX UI uses actual dedicated worker entry and retains existing parser safeguards', async () => {
  const [worker, studio, app, client, html] = await Promise.all([
    readFile(new URL('../src/worker/xlsx-import.worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/studio-flow.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/xlsx-worker-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8')
  ]);
  assert.match(worker, /await xlsxFileToCsv\(event\.data\.file\)/);
  assert.match(studio, /xlsxFileToCsvInWorker\(file\)/);
  assert.match(app, /xlsxFileToCsvInWorker\(file\)/);
  assert.match(client, /new Worker\(new URL\('\.\/worker\/xlsx-import\.worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.match(html, /worker-src 'self'/);
  assert.doesNotMatch(worker, /fetch\(|https?:\/\//);
});
