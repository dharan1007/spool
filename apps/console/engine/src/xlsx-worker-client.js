const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;

// Import is intentionally worker-only. Falling back to synchronous XLSX
// conversion would reintroduce long main-thread stalls on maximum workloads.
export function xlsxFileToCsvInWorker(file, {
  createWorker = () => new Worker(new URL('./worker/xlsx-import.worker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 300000
} = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return Promise.reject(new Error('Choose a valid .xlsx file.'));
  }
  if (Number(file.size ?? 0) > MAX_WORKBOOK_BYTES) {
    return Promise.reject(new Error('Browser Studio accepts CSV/XLSX files up to 50 MiB.'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    return Promise.reject(new Error('XLSX worker timeout must be between 1 and 300000 milliseconds.'));
  }

  return new Promise((resolve, reject) => {
    let worker;
    try { worker = createWorker(); }
    catch (error) { reject(new Error('XLSX background processor could not start: ' + (error?.message || error))); return; }
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
      try { worker?.terminate?.(); } catch {}
      reject(new Error('XLSX background processor is unavailable.'));
      return;
    }

    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      // A failing browser Worker teardown must not strand the caller's promise.
      try { worker.terminate(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };

    worker.onmessage = event => {
      const data = event.data;
      if (data?.type === 'xlsx:error') {
        finish(new Error(String(data.message || 'Unable to open XLSX workbook.').slice(0, 1000)));
        return;
      }
      if (data?.type !== 'xlsx:complete' || !data.result ||
          typeof data.result.csv !== 'string' ||
          typeof data.result.sheetName !== 'string' ||
          !Number.isSafeInteger(data.result.rowCount) || data.result.rowCount < 1 ||
          !Array.isArray(data.result.sheetNames) || !Array.isArray(data.result.warnings)) {
        finish(new Error('XLSX background processor returned an invalid result.'));
        return;
      }
      finish(null, data.result);
    };
    worker.onerror = () => finish(new Error('XLSX background processor failed. The workbook was not imported.'));
    worker.onmessageerror = () => finish(new Error('XLSX worker response could not be decoded.'));
    timer = setTimeout(() => finish(new Error('XLSX background processing exceeded its 5-minute safety limit.')), timeoutMs);
    try { worker.postMessage({ type: 'xlsx:parse', file }); }
    catch (error) { finish(new Error('XLSX workbook could not be sent to the background processor: ' + (error?.message || error))); }
  });
}
