export const WORKSPACE_LOCK_NAME = 'spool-local-runtime:writer';

export class WorkspaceLockedError extends Error {
  constructor(message = 'SPOOL is already active in another tab. Close the other SPOOL tab before continuing so the durable local workspace cannot be overwritten concurrently.') {
    super(message);
    this.name = 'WorkspaceLockedError';
    this.code = 'WORKSPACE_LOCKED';
  }
}

export class WorkspaceWriteLock {
  constructor({ lockManager = globalThis.navigator?.locks ?? null, name = WORKSPACE_LOCK_NAME } = {}) {
    this.lockManager = lockManager;
    this.name = name;
    this.held = false;
    this.acquirePromise = null;
    this.requestPromise = null;
    this.releaseHold = null;
  }

  async acquire() {
    if (!this.lockManager?.request) return { acquired: true, supported: false };
    if (this.held) return { acquired: true, supported: true };
    if (this.acquirePromise) return this.acquirePromise;

    let resolveHold;
    const hold = new Promise(resolve => { resolveHold = resolve; });
    let resolveAcquired;
    let rejectAcquired;
    const acquired = new Promise((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });

    this.releaseHold = resolveHold;
    this.requestPromise = Promise.resolve()
      .then(() => this.lockManager.request(this.name, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) {
          resolveAcquired(false);
          return undefined;
        }
        this.held = true;
        resolveAcquired(true);
        return hold;
      }))
      .catch(error => {
        rejectAcquired(error);
        throw error;
      })
      .finally(() => {
        this.held = false;
        this.requestPromise = null;
        this.acquirePromise = null;
        this.releaseHold = null;
      });

    // Acquisition resolves as soon as the lock callback starts; the request
    // promise intentionally remains pending for the lifetime of this tab's
    // workspace ownership.
    this.requestPromise.catch(() => {});
    this.acquirePromise = acquired.then(value => ({ acquired: value, supported: true }));
    return this.acquirePromise;
  }

  async release() {
    if (!this.lockManager?.request) return;
    const pending = this.requestPromise;
    this.releaseHold?.();
    if (pending) await pending;
  }
}
