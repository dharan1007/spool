import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { canonicalJson } from '../platform/canonical-json.js';
import {
  assertJobTransition,
  safeDurableClone,
  validateExecutionOwnership,
  validateJobRecord
} from '../platform/runtime-contracts.js';

function clone(value) { return structuredClone(value); }
function safeFileId(id) { return String(id).replaceAll(':', '_').replace(/[^A-Za-z0-9._-]/g, '_'); }
function sameCounts(a, b) {
  return a?.processedRows === b?.processedRows && a?.acceptedRows === b?.acceptedRows && a?.rejectedRows === b?.rejectedRows;
}

function withLegacyDefaults(job) {
  const normalized = clone(job);
  if (!Number.isSafeInteger(normalized.stateVersion) || normalized.stateVersion < 0) normalized.stateVersion = 0;
  if (!Number.isSafeInteger(normalized.executionEpoch) || normalized.executionEpoch < 0) normalized.executionEpoch = 0;
  return normalized;
}

export class JobStore {
  constructor({ stateDir }) {
    if (typeof stateDir !== 'string' || !stateDir) fail('INVALID_STATE_DIR', 'stateDir is required');
    this.stateDir = stateDir;
    this.jobsDir = join(stateDir, 'jobs');
    this.receiptsDir = join(stateDir, 'receipts');
  }

  async ensureDirs() {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.receiptsDir, { recursive: true, mode: 0o700 });
  }

  jobPath(jobId) { return join(this.jobsDir, `${safeFileId(jobId)}.json`); }
  receiptPath(receiptId) { return join(this.receiptsDir, `${safeFileId(receiptId)}.json`); }

  async atomicWrite(file, value) {
    await this.ensureDirs();
    const durable = safeDurableClone(value, 'job-store record');
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(durable, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }

  async create(plan) {
    if (!plan?.planId || !Number.isInteger(plan.planRevision) || plan.planRevision < 1) {
      fail('INVALID_PLAN', 'Job creation requires planId and planRevision');
    }
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      jobId: `job_${randomUUID()}`,
      planId: plan.planId,
      planRevision: plan.planRevision,
      state: 'PLANNED',
      stateVersion: 0,
      executionEpoch: 0,
      counts: { processedRows: 0, acceptedRows: 0, rejectedRows: 0 },
      checkpoint: null,
      verification: null,
      receiptId: null,
      lastError: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now
    };
    validateJobRecord(job);
    await this.atomicWrite(this.jobPath(job.jobId), job);
    return clone(job);
  }

  async load(jobId) {
    try {
      const parsed = withLegacyDefaults(JSON.parse(await readFile(this.jobPath(jobId), 'utf8')));
      if (parsed?.jobId !== jobId) fail('JOB_IDENTITY_MISMATCH', 'Persisted job ID does not match requested job');
      validateJobRecord(parsed);
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') fail('JOB_NOT_FOUND', `Job ${jobId} was not found`);
      throw error;
    }
  }

  async update(jobId, updater, { expectedStateVersion, expectedExecutionEpoch } = {}) {
    if (typeof updater !== 'function') fail('INVALID_JOB_UPDATER', 'Job updater must be a function');
    const previous = await this.load(jobId);
    if (expectedStateVersion !== undefined) {
      if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) fail('INVALID_STATE_VERSION', 'expectedStateVersion must be a non-negative safe integer');
      if (previous.stateVersion !== expectedStateVersion) fail('STALE_STATE_VERSION', `Job ${jobId} state version has advanced`);
    }
    if (expectedExecutionEpoch !== undefined) validateExecutionOwnership(previous, expectedExecutionEpoch);

    const candidate = await updater(clone(previous));
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('INVALID_JOB_RECORD', 'Job updater must return a job record');
    const next = clone(candidate);
    next.stateVersion = previous.stateVersion + 1;
    next.updatedAt = new Date().toISOString();

    if (next.checkpoint && sameCounts(next.counts, previous.counts) && !sameCounts(next.counts, next.checkpoint)) {
      next.counts = {
        processedRows: next.checkpoint.processedRows,
        acceptedRows: next.checkpoint.acceptedRows,
        rejectedRows: next.checkpoint.rejectedRows
      };
    }

    if (previous.state === 'PLANNED' && next.state === 'RUNNING' && !next.startedAt) next.startedAt = next.updatedAt;
    if (['COMPLETE', 'FAILED', 'ABORTED'].includes(next.state) && !next.completedAt) next.completedAt = next.updatedAt;
    assertJobTransition(previous, next);
    await this.atomicWrite(this.jobPath(jobId), next);
    return clone(next);
  }

  async list() {
    await this.ensureDirs();
    const names = (await readdir(this.jobsDir)).filter(name => name.endsWith('.json')).sort();
    const jobs = [];
    for (const name of names) {
      const parsed = withLegacyDefaults(JSON.parse(await readFile(join(this.jobsDir, name), 'utf8')));
      validateJobRecord(parsed);
      jobs.push(parsed);
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveReceipt(receipt) {
    if (!receipt?.receiptId || typeof receipt.receiptId !== 'string') fail('INVALID_RECEIPT', 'receiptId is required');
    const durableReceipt = safeDurableClone(receipt, 'receipt');
    const file = this.receiptPath(receipt.receiptId);
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'));
      if (canonicalJson(existing) !== canonicalJson(durableReceipt)) {
        fail('RECEIPT_IMMUTABLE', `Receipt ${receipt.receiptId} is immutable`);
      }
      return clone(existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.atomicWrite(file, durableReceipt);
    return clone(durableReceipt);
  }

  async loadReceipt(receiptId) {
    try { return JSON.parse(await readFile(this.receiptPath(receiptId), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') fail('RECEIPT_NOT_FOUND', `Receipt ${receiptId} was not found`);
      throw error;
    }
  }
}
