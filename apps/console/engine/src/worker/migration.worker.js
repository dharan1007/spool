import { processChunk } from '../runtime/worker-protocol.js';

let task = null;
let paused = false;
let aborted = false;
let seq = 0;

function send(type, payload = null, error = null) {
  if (!task) return;
  postMessage({
    type,
    payload,
    error,
    jobId: task.jobId,
    revision: task.revision,
    seq: ++seq
  });
}

const yieldToEvents = () => new Promise(resolve => setTimeout(resolve, 0));

async function run(payload) {
  task = payload;
  paused = false;
  aborted = false;
  seq = 0;
  const chunkSize = Math.min(5000, Math.max(50, payload.chunkSize || 500));
  let index = Math.max(0, payload.startIndex || 0);
  try {
    while (index < payload.rows.length && !aborted) {
      while (paused && !aborted) await new Promise(resolve => setTimeout(resolve, 20));
      if (aborted) break;
      const rows = payload.rows.slice(index, index + chunkSize);
      const result = processChunk({
        rows,
        mapping: payload.mapping,
        revision: payload.revision,
        targetSchema: payload.targetSchema,
        startIndex: index,
        sampleLimit: 10
      });
      send('progress', result);
      index += rows.length;
      await yieldToEvents();
    }
    if (!aborted) send('complete', { processedThrough: index, totalRows: payload.rows.length });
  } catch (error) {
    send('error', null, { code: error?.code || 'WORKER_ERROR', message: error?.message || String(error) });
  }
}

self.onmessage = event => {
  const message = event.data;
  if (message?.type === 'start') void run(message.payload);
  else if (message?.type === 'pause' && task && !paused) {
    paused = true;
    send('paused', { acknowledged: true });
  } else if (message?.type === 'abort') {
    aborted = true;
    paused = false;
  }
};
