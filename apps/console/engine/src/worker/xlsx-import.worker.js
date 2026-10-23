import { xlsxFileToCsv } from '../xlsx-ingest.js';

// Same-origin dedicated worker. Parsing XLSX worksheet XML, materializing rows
// and producing CSV must not block animation frames or DOM input feedback.
// All bytes stay in the browser; the worker has no network data plane.
self.onmessage = async event => {
  if (!event?.data || event.data.type !== 'xlsx:parse') return;
  try {
    const result = await xlsxFileToCsv(event.data.file);
    self.postMessage({ type: 'xlsx:complete', result });
  } catch (error) {
    self.postMessage({
      type: 'xlsx:error',
      message: String(error?.message || error).slice(0, 1000)
    });
  }
};
