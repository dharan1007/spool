import { fail } from '../core/errors.js';
import { createCapabilityBoundMigrationPlan, validateMigrationPlan } from '../platform/plan.js';
import { projectPublicJob, projectPublicReceipt } from '../platform/public-dto.js';
import { redact } from '../platform/redact.js';
import { safeDurableClone } from '../platform/runtime-contracts.js';

const CONNECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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

export class SpoolCommandService {
  constructor({ configStore, registry, jobStore, runner } = {}) {
    requireMethod(configStore, 'putConnection', 'configStore');
    requireMethod(configStore, 'getConnection', 'configStore');
    requireMethod(configStore, 'listConnections', 'configStore');
    requireMethod(registry, 'list', 'registry');
    requireMethod(registry, 'manifest', 'registry');
    requireMethod(registry, 'open', 'registry');
    requireMethod(jobStore, 'load', 'jobStore');
    requireMethod(jobStore, 'loadReceipt', 'jobStore');
    requireMethod(runner, 'run', 'runner');
    this.configStore = configStore;
    this.registry = registry;
    this.jobStore = jobStore;
    this.runner = runner;
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
    const stored = await this.configStore.putConnection(request.name, {
      type: request.type,
      config: request.config ?? {},
      secretRefs: request.secretRefs ?? {}
    });
    this.registry.manifest(stored.type);
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
    const result = await this.runner.run({
      plan: request.plan,
      sourceConfig: structuredClone(source.config),
      targetConfig: structuredClone(target.config),
      jobId: request.jobId
    });
    return {
      job: projectPublicJob(result.job),
      receipt: projectPublicReceipt(result.receipt)
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
