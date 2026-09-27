// Serialize callbacks even if a transport emits them without awaiting.
// The replication listener returns drain() so the upstream flowControl mode
// can pause delivery until processing and acknowledgement complete.
export function createCdcSerialPump({ handle, onFailure, maxPending = 1024 } = {}) {
  if (typeof handle !== 'function' || typeof onFailure !== 'function') {
    throw new TypeError('CDC serial pump requires handler and failure callback');
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100_000) {
    throw new TypeError('CDC maxPending must be 1..100000');
  }
  let accepting = true;
  let pending = 0;
  let serial = Promise.resolve();
  function stopWith(error) {
    if (!accepting) return;
    accepting = false;
    try { onFailure(error); } catch { /* original failure wins */ }
  }
  return Object.freeze({
    enqueue(lsn, message) {
      if (!accepting) return false;
      if (pending >= maxPending) {
        stopWith(Object.assign(new Error('CDC callback backlog exceeded the configured bound'), {
          code: 'CDC_EVENT_BACKPRESSURE_EXCEEDED'
        }));
        return false;
      }
      pending += 1;
      serial = serial.then(async () => {
        if (accepting) await handle(lsn, message);
      }).catch(stopWith).finally(() => { pending -= 1; });
      return true;
    },
    close() { accepting = false; },
    drain() { return serial; },
    stats() { return Object.freeze({ accepting, pending }); }
  });
}
