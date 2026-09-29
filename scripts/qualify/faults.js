export const FAULT_POINTS = Object.freeze({
  TARGET_BEFORE_TRANSACTION: 'TARGET_BEFORE_TRANSACTION',
  TARGET_AFTER_FENCE_CHECK: 'TARGET_AFTER_FENCE_CHECK',
  TARGET_AFTER_ROWS_BEFORE_LEDGER: 'TARGET_AFTER_ROWS_BEFORE_LEDGER',
  TARGET_AFTER_LEDGER_BEFORE_COMMIT: 'TARGET_AFTER_LEDGER_BEFORE_COMMIT',
  TARGET_AFTER_COMMIT_BEFORE_CHECKPOINT: 'TARGET_AFTER_COMMIT_BEFORE_CHECKPOINT',
  CDC_AFTER_RECEIVE: 'CDC_AFTER_RECEIVE',
  CDC_AFTER_APPLY_BEFORE_CHECKPOINT: 'CDC_AFTER_APPLY_BEFORE_CHECKPOINT',
  CDC_AFTER_CHECKPOINT_BEFORE_ACK: 'CDC_AFTER_CHECKPOINT_BEFORE_ACK',
  VERIFY_MID_SCAN: 'VERIFY_MID_SCAN',
  REPAIR_AFTER_PRECONDITION: 'REPAIR_AFTER_PRECONDITION',
  REPAIR_AFTER_MUTATION_BEFORE_COMMIT: 'REPAIR_AFTER_MUTATION_BEFORE_COMMIT'
});

export class NoopFaultInjector {
  async hit(point, context) { return false; }
  isEnabled() { return false; }
}

export class TestFaultInjector {
  constructor({ enabledPoints = new Set(), hitCallback = null } = {}) {
    this.enabledPoints = new Set(enabledPoints);
    this.hitCallback = hitCallback;
    this.hits = [];
  }
  async hit(point, context) {
    if (!this.enabledPoints.has(point)) return false;
    this.hits.push({ point, context, timestamp: new Date().toISOString() });
    if (this.hitCallback) await this.hitCallback(point, context);
    return true;
  }
  isEnabled() { return this.enabledPoints.size > 0; }
}

export class ProcessKillFaultInjector {
  constructor({ pid, afterPoint, signal = 'SIGKILL' } = {}) {
    this.pid = pid;
    this.afterPoint = afterPoint;
    this.signal = signal;
    this.triggered = false;
  }
  async hit(point, context) {
    if (point !== this.afterPoint || this.triggered) return false;
    this.triggered = true;
    // The fault fires only when the caller reaches this protocol boundary
    // (predicate-driven: the injector is invoked at the boundary, not on a timer).
    try { process.kill(this.pid, this.signal); } catch {}
    return true;
  }
  isEnabled() { return true; }
}
