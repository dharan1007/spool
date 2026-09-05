import { fail } from '../core/errors.js';
import { sha256Json } from '../platform/canonical-json.js';
import { createCapabilityBoundMigrationPlan, validateMigrationPlan } from '../platform/plan.js';
import { projectPublicJob, projectPublicReceipt } from '../platform/public-dto.js';
import { redact } from '../platform/redact.js';
import { safeDurableClone } from '../platform/runtime-contracts.js';

const CONNECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONNECTION_BINDING_VERSION = 1;

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    fail('INVALID_COMMAND_SERVICE_DEPENDENCY', `${label} must implement ${method}()`);
  }
}

function requireRequest(value, label = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_COMMAND_REQUEST', `${label} must be an object`);
  }
  return value;
}

function requireConnectionName(name, label = 'connection') {
  if (typeof name !== 'string' || !CONNECTION_NAME.test(name)) {
    fail('INVALID_CONNECTION_NAME', `${label} name is invalid`);
  }
  return name;
}

function projectConnection(descriptor) {
  return safeDurableClone({
    name: descriptor.name,
    type: descriptor.type,
    config: redact(descriptor.config ?? {}),
    secretRefNames: Object.keys(descriptor.secretRefs ?? {}).sort(),
    createdAt: descriptor.createdAt ?? null,
    updatedAt: descriptor.updatedAt ?? null
  }, 'public connection descriptor');
}

function projectHealth(health) {
  const redacted = redact(health ?? {});
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    fail('INVALID_CONNECTION_HEALTH', 'Connector testConnection() must return an object');
  }
  return safeDurableClone(redacted, 'public connector health');
}

async function connectionFingerprint(descriptor) {
  return sha256Json({
    domain: 'spool-connection-binding-v1',
    name: descriptor.name,
    type: descriptor.type,
    config: descriptor.config ?? {},
    secretRefs: descriptor.secretRefs ?? {}
  });
}

function requireExecutionContext(job) {
  const context = job?.executionContext;
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.schemaVersion !== CONNECTION_BINDING_VERSION) {
    fail('JOB_EXECUTION_CONTEXT_REQUIRED', `Job ${job?.jobId ?? ''} has no resumable execution context`.trim());
  }
  if (!context.plan || typeof context.plan !== 'object' || Array.isArray(context.plan)) {
    fail('JOB_EXECUTION_CONTEXT_INVALID', 'Managed execution context requires the immutable migration plan');
  }
  validateMigrationPlan(context.plan);
  if (context.plan.planId !== job.planId || context.plan.planRevision !== job.planRevision) {
    fail('JOB_EXECUTION_CONTEXT_INVALID', 'Managed execution context plan identity does not match the job');
  }
  for (const [role, connector] of [['source', context.sourceConnection], ['target', context.targetConnection]]) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
      fail('JOB_EXECUTION_CONTEXT_INVALID', `Managed execution context requires ${role} connection binding`);
    }
    requireConnectionName(connector.name, `${role} connection`);
    if (typeof connector.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(connector.fingerprint)) {
      fail('JOB_EXECUTION_CONTEXT_INVALID', `${role} connection fingerprint is invalid`);
    }
  }
  return safeDurableClone(context, 'managed execution context');
}

export class SpoolCommandService {
  constructor({ configStore, registry, jobStore, runner, executionController = null } = {}) {
    requireMethod(configStore, 'putConnection', 'configStore');
    requireMethod(configStore, 'getConnection', 'configStore');
    requireMethod(configStore, 'listConnections', 'configStore');
    requireMethod(registry, 'list', 'registry');
    requireMethod(registry, 'manifest', 'registry');
    requireMethod(registry, 'open', 'registry');
    requireMethod(jobStore, 'create', 'jobStore');
    requireMethod(jobStore, 'update', 'jobStore');
    requireMethod(jobStore, 'load', 'jobStore');
    requireMethod(jobStore, 'loadReceipt', 'jobStore');
    requireMethod(runner, 'run', 'runner');
    if (executionController != null) {
      requireMethod(executionController, 'start', 'executionController');
      requireMethod(executionController, 'requestPause', 'executionController');
      requireMethod(executionController, 'isActive', 'executionController');
    }
    this.configStore = configStore;
    this.registry = registry;
    this.jobStore = jobStore;
    this.runner = runner;
    this.executionController = executionController;
  }

  async #connection(name, expectedType = null) {
    const validatedName = requireConnectionName(name);
    const descriptor = await this.configStore.getConnection(validatedName);
    if (!descriptor) fail('CONNECTION_NOT_FOUND', `Connection ${validatedName} was not found`);
    if (expectedType != null && descriptor.type !== expectedType) {
      fail('CONNECTION_TYPE_MISMATCH', `Connection ${validatedName} type does not match required connector`);
    }
    return descriptor;
  }

  async #executionContext(plan, source, target) {
    return safeDurableClone({
      schemaVersion: CONNECTION_BINDING_VERSION,
      plan,
      sourceConnection: {
        name: source.name,
        fingerprint: await connectionFingerprint(source)
      },
      targetConnection: {
        name: target.name,
        fingerprint: await connectionFingerprint(target)
      }
    }, 'managed execution context');
  }

  async #bindManagedJob(plan, source, target) {
    const executionContext = await this.#executionContext(plan, source, target);
    const created = await this.jobStore.create(plan);
    return this.jobStore.update(
      created.jobId,
      current => ({ ...current, executionContext }),
      {
        expectedStateVersion: created.stateVersion,
        expectedExecutionEpoch: created.executionEpoch
      }
    );
  }

  async #resolveManagedJob(jobId) {
    const job = await this.jobStore.load(jobId);
    const context = requireExecutionContext(job);
    const source = await this.#connection(context.sourceConnection.name, context.plan.sourceRef.connector);
    const target = await this.#connection(context.targetConnection.name, context.plan.targetRef.connector);
    const [sourceFingerprint, targetFingerprint] = await Promise.all([
      connectionFingerprint(source),
      connectionFingerprint(target)
    ]);
    if (sourceFingerprint !== context.sourceConnection.fingerprint) {
      fail('CONNECTION_BINDING_DRIFT', 'Source connection descriptor changed after the job was planned');
    }
    if (targetFingerprint !== context.targetConnection.fingerprint) {
      fail('CONNECTION_BINDING_DRIFT', 'Target connection descriptor changed after the job was planned');
    }
    return { job, context, source, target };
  }

  async #executeManaged({ plan, source, target, jobId, detach = false }) {
    const run = () => this.runner.run({
      plan,
      sourceConfig: structuredClone(source.config),
      targetConfig: structuredClone(target.config),
      jobId
    });

    if (!this.executionController) {
      if (detach) fail('DETACHED_EXECUTION_UNAVAILABLE', 'Detached migration requires a managed execution controller');
      return run();
    }

    const task = this.executionController.start(jobId, run);
    if (detach) {
      return {
        job: await this.jobStore.load(jobId),
        receipt: null,
        detached: true
      };
    }
    return task;
  }

  async listConnectors() {
    return safeDurableClone(this.registry.list(), 'connector manifests');
  }

  async listConnections() {
    const connections = await this.configStore.listConnections();
    return connections.map(projectConnection);
  }

  async putConnection(request = {}) {
    requireRequest(request);
    requireConnectionName(request.name);
    this.registry.manifest(request.type);
    const stored = await this.configStore.putConnection(request.name, {
      type: request.type,
      config: request.config ?? {},
      secretRefs: request.secretRefs ?? {}
    });
    return projectConnection(stored);
  }

  async testConnection(request = {}) {
    requireRequest(request);
    const descriptor = await this.#connection(request.name);
    this.registry.manifest(descriptor.type);
    let connector = null;
    try {
      connector = await this.registry.open(descriptor.type, descriptor.config, {
        role: 'connection_test',
        connectionName: descriptor.name,
        secretRefs: structuredClone(descriptor.secretRefs ?? {})
      });
      const health = await connector.testConnection({
        connection: connector.connection,
        connectionName: descriptor.name,
        secretRefs: structuredClone(descriptor.secretRefs ?? {})
      });
      const publicHealth = projectHealth(health);
      return safeDurableClone({
        name: descriptor.name,
        type: descriptor.type,
        ok: health?.ok === true,
        health: publicHealth
      }, 'connection test result');
    } finally {
      if (connector && typeof connector.close === 'function') await connector.close();
    }
  }

  async createPlan(request = {}) {
    requireRequest(request);
    requireRequest(request.planInput, 'planInput');
    const sourceName = requireConnectionName(request.sourceConnection, 'source connection');
    const targetName = requireConnectionName(request.targetConnection, 'target connection');
    const sourceType = request.planInput?.sourceRef?.connector;
    const targetType = request.planInput?.targetRef?.connector;
    const source = await this.#connection(sourceName, sourceType);
    const target = await this.#connection(targetName, targetType);
    return createCapabilityBoundMigrationPlan(request.planInput, {
      sourceManifest: this.registry.manifest(source.type),
      targetManifest: this.registry.manifest(target.type),
      requirements: request.requirements ?? { restartResume: false, verificationStrength: 'STANDARD' }
    });
  }

  async runMigration(request = {}) {
    requireRequest(request);
    validateMigrationPlan(request.plan);
    const sourceName = requireConnectionName(request.sourceConnection, 'source connection');
    const targetName = requireConnectionName(request.targetConnection, 'target connection');
    const source = await this.#connection(sourceName, request.plan.sourceRef.connector);
    const target = await this.#connection(targetName, request.plan.targetRef.connector);
    let jobId = request.jobId;
    if (jobId == null) {
      const managed = await this.#bindManagedJob(request.plan, source, target);
      jobId = managed.jobId;
    }
    const result = await this.#executeManaged({
      plan: request.plan,
      source,
      target,
      jobId,
      detach: request.detach === true
    });
    return {
      job: projectPublicJob(result.job),
      receipt: result.receipt ? projectPublicReceipt(result.receipt) : null
    };
  }

  async pauseJob(request = {}) {
    requireRequest(request);
    if (typeof request.jobId !== 'string' || !request.jobId) fail('INVALID_JOB_ID', 'jobId is required');
    const job = await this.jobStore.load(request.jobId);
    if (job.state === 'PAUSED') return projectPublicJob(job);
    if (!this.executionController) fail('PAUSE_UNAVAILABLE', 'Pause requires a managed execution controller');
    if (job.state === 'VERIFYING') fail('PAUSE_TOO_LATE', 'Job has already entered verification and cannot be paused');
    if (!['PLANNED', 'RUNNING', 'PAUSING'].includes(job.state)) {
      fail('INVALID_JOB_TRANSITION', `Cannot pause job from ${job.state}`);
    }
    if (!this.executionController.isActive(job.jobId)) {
      fail('JOB_EXECUTION_NOT_ACTIVE', `Job ${job.jobId} has no active execution to pause`);
    }
    const result = await this.executionController.requestPause(job.jobId);
    if (result?.paused === true && result.job?.state === 'PAUSED') return projectPublicJob(result.job);
    fail('PAUSE_TOO_LATE', `Job ${job.jobId} crossed the safe pause boundary before the request was acknowledged`);
  }

  async resumeJob(request = {}) {
    requireRequest(request);
    if (typeof request.jobId !== 'string' || !request.jobId) fail('INVALID_JOB_ID', 'jobId is required');
    const { job, context, source, target } = await this.#resolveManagedJob(request.jobId);
    if (job.state === 'COMPLETE') {
      const receipt = await this.jobStore.loadReceipt(job.receiptId);
      return { job: projectPublicJob(job), receipt: projectPublicReceipt(receipt) };
    }
    if (job.state !== 'PAUSED' && job.state !== 'RECOVERY_REQUIRED') {
      fail('INVALID_JOB_TRANSITION', `Cannot resume job from ${job.state}`);
    }
    if (context.plan.connectorBinding?.requirements?.restartResume !== true) {
      fail('RESUME_GUARANTEE_UNAVAILABLE', 'This plan did not prove restart-safe source and target resume guarantees');
    }
    const result = await this.#executeManaged({
      plan: context.plan,
      source,
      target,
      jobId: job.jobId,
      detach: request.detach === true
    });
    return {
      job: projectPublicJob(result.job),
      receipt: result.receipt ? projectPublicReceipt(result.receipt) : null
    };
  }

  async inspectJob(request = {}) {
    requireRequest(request);
    if (typeof request.jobId !== 'string' || !request.jobId) fail('INVALID_JOB_ID', 'jobId is required');
    return projectPublicJob(await this.jobStore.load(request.jobId));
  }

  async getReceipt(request = {}) {
    requireRequest(request);
    let receiptId = request.receiptId;
    if (receiptId == null && request.jobId != null) {
      if (typeof request.jobId !== 'string' || !request.jobId) fail('INVALID_JOB_ID', 'jobId is invalid');
      const job = await this.jobStore.load(request.jobId);
      receiptId = job.receiptId;
      if (!receiptId) fail('RECEIPT_NOT_AVAILABLE', `Job ${request.jobId} has no receipt`);
    }
    if (typeof receiptId !== 'string' || !receiptId) fail('INVALID_RECEIPT_ID', 'receiptId or jobId is required');
    return projectPublicReceipt(await this.jobStore.loadReceipt(receiptId));
  }
}
