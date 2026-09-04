import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { canonicalJson } from '../platform/canonical-json.js';

const TRANSITIONS = Object.freeze({
  PLANNED: new Set(['RUNNING', 'FAILED', 'ABORTED']),
  RUNNING: new Set(['PAUSING', 'PAUSED', 'VERIFYING', 'FAILED', 'ABORTED']),
  PAUSING: new Set(['PAUSED', 'FAILED', 'ABORTED']),
  PAUSED: new Set(['RUNNING', 'FAILED', 'ABORTED']),
  VERIFYING: new Set(['COMPLETE', 'FAILED', 'ABORTED']),
  COMPLETE: new Set(),
  FAILED: new Set(),
  ABORTED: new Set()
});

function clone(value) { return structuredClone(value); }
function safeFileId(id) { return String(id).replaceAll(':', '_').replace(/[^A-Za-z0-9._-]/g, '_'); }

function validateCounts(counts) {
  if (!counts || typeof counts !== 'object') fail('INVALID_JOB_COUNTS', 'Job counts are required');
  const values = [counts.processedRows, counts.acceptedRows, counts.rejectedRows];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) fail('INVALID_JOB_COUNTS', 'Job counts must be non-negative safe integers');
  if (counts.acceptedRows + counts.rejectedRows !== counts.processedRows) {
    fail('INVALID_JOB_COUNTS', 'acceptedRows + rejectedRows must equal processedRows');
  }
}

function validateCheckpoint(job, checkpoint) {
  if (checkpoint == null) return;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) fail('INVALID_CHECKPOINT', 'Checkpoint must be an object');
  if (checkpoint.planId !== job.planId || checkpoint.planRevision !== job.planRevision) {
    fail('CHECKPOINT_PLAN_MISMATCH', 'Checkpoint plan identity/revision does not match the job');
  }
  const values = [checkpoint.processedRows, checkpoint.acceptedRows, checkpoint.rejectedRows];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) fail('INVALID_CHECKPOINT', 'Checkpoint counters must be non-negative safe integers');
  if (checkpoint.acceptedRows + checkpoint.rejectedRows !== checkpoint.processedRows) {
    fail('INVALID_CHECKPOINT', 'Checkpoint acceptedRows + rejectedRows must equal processedRows');
  }
  if (checkpoint.processedRows < job.counts.processedRows) fail('CHECKPOINT_REGRESSION', 'Checkpoint may not move behind persisted job counts');
}

function validateRecord(previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) fail('INVALID_JOB_RECORD', 'Job updater must return a job record');
  if (next.jobId !== previous.jobId || next.planId !== previous.planId || next.planRevision !== previous.planRevision) {
    fail('JOB_IDENTITY_MUTATION', 'Job identity and plan identity are immutable');
  }
  if (!TRANSITIONS[next.state]) fail('INVALID_JOB_STATE', `Unknown job state ${next.state}`);
  if (previous.state !== next.state && !TRANSITIONS[previous.state]?.has(next.state)) {
    fail('INVALID_JOB_TRANSITION', `Cannot transition job from ${previous.state} to ${next.state}`);
  }
  validateCounts(next.counts);
  validateCheckpoint(next, next.checkpoint);
  if (next.state === 'COMPLETE' && next.verification?.ok !== true) {
    fail('VERIFICATION_REQUIRED', 'A job cannot become COMPLETE before verification succeeds');
  }
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
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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
    await this.atomicWrite(this.jobPath(job.jobId), job);
    return clone(job);
  }

  async load(jobId) {
    try {
      const parsed = JSON.parse(await readFile(this.jobPath(jobId), 'utf8'));
      if (parsed?.jobId !== jobId) fail('JOB_IDENTITY_MISMATCH', 'Persisted job ID does not match requested job');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') fail('JOB_NOT_FOUND', `Job ${jobId} was not found`);
      throw error;
    }
  }

  async update(jobId, updater) {
    if (typeof updater !== 'function') fail('INVALID_JOB_UPDATER', 'Job updater must be a function');
    const previous = await this.load(jobId);
    const candidate = await updater(clone(previous));
    const next = clone(candidate);
    next.updatedAt = new Date().toISOString();
    if (previous.state === 'PLANNED' && next.state === 'RUNNING' && !next.startedAt) next.startedAt = next.updatedAt;
    if (['COMPLETE', 'FAILED', 'ABORTED'].includes(next.state) && !next.completedAt) next.completedAt = next.updatedAt;
    validateRecord(previous, next);
    await this.atomicWrite(this.jobPath(jobId), next);
    return clone(next);
  }

  async list() {
    await this.ensureDirs();
    const names = (await readdir(this.jobsDir)).filter(name => name.endsWith('.json')).sort();
    const jobs = [];
    for (const name of names) jobs.push(JSON.parse(await readFile(join(this.jobsDir, name), 'utf8')));
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveReceipt(receipt) {
    if (!receipt?.receiptId || typeof receipt.receiptId !== 'string') fail('INVALID_RECEIPT', 'receiptId is required');
    const file = this.receiptPath(receipt.receiptId);
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'));
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        fail('RECEIPT_IMMUTABLE', `Receipt ${receipt.receiptId} is immutable`);
      }
      return clone(existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.atomicWrite(file, receipt);
    return clone(receipt);
  }

  async loadReceipt(receiptId) {
    try { return JSON.parse(await readFile(this.receiptPath(receiptId), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') fail('RECEIPT_NOT_FOUND', `Receipt ${receiptId} was not found`);
      throw error;
    }
  }
}
