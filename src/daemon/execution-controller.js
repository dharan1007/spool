import { fail } from '../core/errors.js';
import { safeDurableClone } from '../platform/runtime-contracts.js';

function requireJobId(jobId) {
  if (typeof jobId !== 'string' || !jobId) fail('INVALID_JOB_ID', 'jobId is required');
  return jobId;
}

function requireEpoch(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) fail('INVALID_EXECUTION_EPOCH', 'executionEpoch must be a positive safe integer');
  return epoch;
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') fail('INVALID_EXECUTION_CONTROLLER_DEPENDENCY', `${label} must implement ${method}()`);
}

export class ExecutionPausedSignal extends Error {
  constructor(job) {
    super(`Execution ${job.jobId} paused at a durable boundary`);
    this.name = 'ExecutionPausedSignal';
    this.code = 'EXECUTION_PAUSED';
    this.job = safeDurableClone(job, 'paused execution result');
  }
}

export class ExecutionController {
  constructor() {
    this.active = new Map();
  }

  start(jobId, taskFactory) {
    requireJobId(jobId);
    if (typeof taskFactory !== 'function') fail('INVALID_EXECUTION_TASK', 'Execution task factory must be a function');
    if (this.active.has(jobId)) fail('JOB_EXECUTION_ACTIVE', `Job ${jobId} already has an active execution`);

    const record = { jobId, executionEpoch: null, pauseRequested: false, promise: null };
    this.active.set(jobId, record);
    record.promise = Promise.resolve()
      .then(() => taskFactory())
      .catch(error => {
        if (error instanceof ExecutionPausedSignal) return { job: error.job, receipt: null, paused: true };
        throw error;
      })
      .finally(() => {
        if (this.active.get(jobId) === record) this.active.delete(jobId);
      });
    record.promise.catch(() => {});
    return record.promise;
  }

  bindExecution(jobId, executionEpoch) {
    requireJobId(jobId);
    requireEpoch(executionEpoch);
    const record = this.active.get(jobId);
    if (!record) fail('JOB_EXECUTION_NOT_ACTIVE', `Job ${jobId} has no active controlled execution`);
    if (record.executionEpoch != null && record.executionEpoch !== executionEpoch) {
      fail('STALE_EXECUTION_EPOCH', `Job ${jobId} execution epoch changed from ${record.executionEpoch} to ${executionEpoch}`);
    }
    record.executionEpoch = executionEpoch;
    return true;
  }

  requestPause(jobId) {
    requireJobId(jobId);
    const record = this.active.get(jobId);
    if (!record) fail('JOB_EXECUTION_NOT_ACTIVE', `Job ${jobId} has no active execution to pause`);
    record.pauseRequested = true;
    return record.promise;
  }

  shouldPause(jobId, executionEpoch) {
    requireJobId(jobId);
    requireEpoch(executionEpoch);
    const record = this.active.get(jobId);
    if (!record) return false;
    if (record.executionEpoch != null && record.executionEpoch !== executionEpoch) {
      fail('STALE_EXECUTION_EPOCH', `Pause request belongs to execution epoch ${record.executionEpoch}, not ${executionEpoch}`);
    }
    return record.pauseRequested === true;
  }

  isActive(jobId) {
    return this.active.has(requireJobId(jobId));
  }

  activeJobIds() {
    return [...this.active.keys()];
  }

  async pauseAll() {
    const jobs = this.activeJobIds();
    return Promise.allSettled(jobs.map(jobId => this.requestPause(jobId)));
  }
}

export class ExecutionControlledJobStore {
  constructor({ store, controller } = {}) {
    for (const method of [
      'create', 'load', 'update', 'acquireExecution', 'renewExecution', 'releaseExecution',
      'beginPendingBatch', 'clearPendingBatch', 'commitCheckpoint', 'appendRecoveryEvent',
      'finalizeVerifiedJob', 'loadReceipt'
    ]) requireMethod(store, method, 'store');
    requireMethod(controller, 'bindExecution', 'controller');
    requireMethod(controller, 'shouldPause', 'controller');
    this.store = store;
    this.controller = controller;
  }

  create(...args) { return this.store.create(...args); }
  load(...args) { return this.store.load(...args); }
  loadReceipt(...args) { return this.store.loadReceipt(...args); }
  beginPendingBatch(...args) { return this.store.beginPendingBatch(...args); }
  clearPendingBatch(...args) { return this.store.clearPendingBatch(...args); }
  appendRecoveryEvent(...args) { return this.store.appendRecoveryEvent(...args); }
  finalizeVerifiedJob(...args) { return this.store.finalizeVerifiedJob(...args); }
  releaseExecution(...args) { return this.store.releaseExecution(...args); }

  async #pauseAtBoundary(job, options = {}) {
    if (job.state !== 'RUNNING') fail('PAUSE_NOT_SAFE', `Cannot acknowledge pause from ${job.state}`);
    if (job.pendingBatch != null) fail('PAUSE_NOT_SAFE', 'Cannot acknowledge pause while a target batch is unresolved');
    const epoch = requireEpoch(options.expectedExecutionEpoch ?? job.executionEpoch);
    let pausing = await this.store.update(
      job.jobId,
      current => ({ ...current, state: 'PAUSING' }),
      { expectedStateVersion: options.expectedStateVersion ?? job.stateVersion, expectedExecutionEpoch: epoch }
    );
    pausing = await this.store.update(
      job.jobId,
      current => ({ ...current, state: 'PAUSED', executionOwner: null, executionLeaseExpiresAt: null }),
      { expectedStateVersion: pausing.stateVersion, expectedExecutionEpoch: epoch }
    );
    throw new ExecutionPausedSignal(pausing);
  }

  async acquireExecution(jobId, options = {}) {
    const acquired = await this.store.acquireExecution(jobId, options);
    try {
      this.controller.bindExecution(jobId, acquired.executionEpoch);
    } catch (error) {
      try {
        await this.store.releaseExecution(jobId, {
          expectedStateVersion: acquired.stateVersion,
          expectedExecutionEpoch: acquired.executionEpoch,
          ownerId: options.ownerId
        });
      } catch {}
      throw error;
    }
    return acquired;
  }

  async renewExecution(jobId, options = {}) {
    const epoch = requireEpoch(options.expectedExecutionEpoch);
    if (this.controller.shouldPause(jobId, epoch)) {
      const current = await this.store.load(jobId);
      if (current.state === 'RUNNING' && current.pendingBatch == null) {
        return this.#pauseAtBoundary(current, {
          expectedStateVersion: options.expectedStateVersion,
          expectedExecutionEpoch: epoch
        });
      }
    }
    return this.store.renewExecution(jobId, options);
  }

  async commitCheckpoint(jobId, checkpoint, options = {}) {
    const committed = await this.store.commitCheckpoint(jobId, checkpoint, options);
    const epoch = requireEpoch(options.expectedExecutionEpoch);
    if (this.controller.shouldPause(jobId, epoch)) {
      return this.#pauseAtBoundary(committed, {
        expectedStateVersion: committed.stateVersion,
        expectedExecutionEpoch: epoch
      });
    }
    return committed;
  }

  async update(jobId, updater, options = {}) {
    const epoch = options.expectedExecutionEpoch;
    if (Number.isSafeInteger(epoch) && epoch > 0 && this.controller.shouldPause(jobId, epoch)) {
      const current = await this.store.load(jobId);
      if (current.state === 'RUNNING' && current.pendingBatch == null && typeof updater === 'function') {
        const candidate = updater(structuredClone(current));
        if (candidate?.state === 'VERIFYING') {
          return this.#pauseAtBoundary(current, {
            expectedStateVersion: options.expectedStateVersion,
            expectedExecutionEpoch: epoch
          });
        }
      }
    }
    return this.store.update(jobId, updater, options);
  }
}
