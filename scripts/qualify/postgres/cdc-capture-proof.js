// Validate the FULL pgoutput capture before it is counted as qualification
// evidence. PostgreSQL row-record LSNs can predate the most recent commit
// because concurrent transactions commit in a different order. Only complete
// COMMIT positions are valid restart/order proofs.
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const ROW_TAGS = new Set(['insert', 'update', 'delete', 'truncate']);

function bad(code, message) {
  throw Object.assign(new Error(message), { code });
}
export function compareCaptureLsn(left, right) {
  for (const lsn of [left, right]) {
    if (typeof lsn !== 'string' || !LSN.test(lsn)) bad('INVALID_POSTGRES_LSN', 'Invalid pgoutput LSN');
  }
  const decode = value => {
    const [hi, lo] = value.split('/');
    return (BigInt('0x' + hi) << 32n) | BigInt('0x' + lo);
  };
  const a = decode(left), b = decode(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function auditCdcCapture(changes, { priorCheckpointLsn = null, requireCommit = true } = {}) {
  if (!Array.isArray(changes)) bad('CDC_CAPTURE_INVALID', 'CDC capture must be an array');
  if (priorCheckpointLsn != null) compareCaptureLsn(priorCheckpointLsn, priorCheckpointLsn);
  let checkpointLsn = priorCheckpointLsn;
  let inTx = false;
  let lastRowLsn = null;
  let commits = 0, rowEvents = 0;
  for (const change of changes) {
    if (!change || typeof change !== 'object') bad('CDC_CAPTURE_INVALID', 'Null or malformed CDC event');
    if (change.tag === 'begin') {
      if (inTx) bad('CDC_CAPTURE_INCOMPLETE', 'Nested CDC transaction BEGIN');
      inTx = true;
      lastRowLsn = null;
    } else if (change.tag === 'commit') {
      if (!inTx) bad('CDC_CAPTURE_INCOMPLETE', 'CDC COMMIT without BEGIN');
      const commitLsn = change.commitLsn ?? change.lsn;
      compareCaptureLsn(commitLsn, commitLsn);
      if (checkpointLsn && compareCaptureLsn(commitLsn, checkpointLsn) < 0) {
        bad('CDC_RESTART_REPLAY', 'CDC commit regressed below durable checkpoint');
      }
      const commitEndLsn = change.commitEndLsn ?? commitLsn;
      if (compareCaptureLsn(commitEndLsn, commitLsn) < 0) {
        bad('CDC_CAPTURE_INVALID', 'CDC COMMIT end precedes commit record');
      }
      checkpointLsn = commitEndLsn;
      commits += 1;
      inTx = false;
    } else if (ROW_TAGS.has(change.tag)) {
      if (!inTx) bad('CDC_CAPTURE_INCOMPLETE', 'CDC row mutation outside a transaction');
      compareCaptureLsn(change.lsn, change.lsn);
      if (lastRowLsn && compareCaptureLsn(change.lsn, lastRowLsn) < 0) {
        bad('CDC_STREAM_ORDER_VIOLATION', 'CDC row records regressed within a transaction');
      }
      lastRowLsn = change.lsn;
      rowEvents += 1;
    }
  }
  if (inTx) bad('CDC_CAPTURE_INCOMPLETE', 'CDC capture ended within an open transaction');
  if (requireCommit && commits === 0) bad('CDC_CAPTURE_INCOMPLETE', 'CDC capture has no complete transaction boundary');
  return Object.freeze({ checkpointLsn, commits, rowEvents });
}
