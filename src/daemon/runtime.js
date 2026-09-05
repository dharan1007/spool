import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { FilesystemConnector } from '../connectors/filesystem.js';
import { ConnectorRegistry } from '../connectors/registry.js';
import { SQLiteConnector } from '../connectors/sqlite.js';
import { SpoolCommandService } from './command-service.js';
import { ConfigStore } from './config-store.js';
import { ExecutionController, ExecutionControlledJobStore } from './execution-controller.js';
import { SharedMigrationRunner } from './shared-runner.js';
import { SpooldHost } from './spoold.js';
import { SQLiteJobStore } from './sqlite-job-store.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8766;
const PAIRING_FILE = 'spoold-pairing.json';
const DESCRIPTOR_FILE = 'spoold.json';
const LOCK_FILE = 'spoold.lock';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1';
}

function requireStateDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) fail('INVALID_STATE_DIR', 'stateDir is required');
  return stateDir;
}

function validatePairing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('INVALID_SPOOLD_PAIRING', 'spoold pairing credentials have an invalid schema');
  }
  if (typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 200) {
    fail('INVALID_SPOOLD_PAIRING', 'spoold pairing instanceId is invalid');
  }
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) {
    fail('INVALID_SPOOLD_PAIRING', 'spoold pairing token is invalid');
  }
  return { schemaVersion: 1, instanceId: value.instanceId, token: value.token };
}

async function removeIfExists(path) {
  try { await unlink(path); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function atomicWriteJson(stateDir, filename, value) {
  const destination = join(stateDir, filename);
  const temporary = join(stateDir, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await removeIfExists(temporary);
    throw error;
  }
  return destination;
}

async function loadOrCreatePairing(stateDir) {
  const path = join(stateDir, PAIRING_FILE);
  try {
    const pairing = validatePairing(JSON.parse(await readFile(path, 'utf8')));
    await chmod(path, 0o600);
    return pairing;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) fail('INVALID_SPOOLD_PAIRING', 'spoold pairing credentials are not valid JSON');
      throw error;
    }
  }

  const pairing = Object.freeze({ schemaVersion: 1, instanceId: randomUUID(), token: randomBytes(32).toString('hex') });
  await atomicWriteJson(stateDir, PAIRING_FILE, pairing);
  return pairing;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function readLock(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) fail('SPOOLD_LOCK_CORRUPT', 'spoold lock file is not valid JSON');
    throw error;
  }
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || typeof value.ownerId !== 'string' || !value.ownerId) {
    fail('SPOOLD_LOCK_CORRUPT', 'spoold lock file has an invalid schema');
  }
  return value;
}

async function acquireStateLock(stateDir, ownerId) {
  const path = join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      const record = { schemaVersion: 1, pid: process.pid, ownerId, createdAt: new Date().toISOString() };
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
        await chmod(path, 0o600);
      } catch (error) {
        await handle.close().catch(() => {});
        await removeIfExists(path);
        throw error;
      }
      return { path, handle, record };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readLock(path);
      if (existing && processIsAlive(existing.pid)) fail('SPOOLD_ALREADY_RUNNING', `spoold state directory is already owned by process ${existing.pid}`);
      await removeIfExists(path);
    }
  }
  fail('SPOOLD_LOCK_FAILED', 'Unable to acquire spoold state-directory lock');
}

async function releaseStateLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  const existing = await readLock(lock.path).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && existing.ownerId === lock.record.ownerId && existing.pid === lock.record.pid) await removeIfExists(lock.path);
}

function createRegistry() {
  const registry = new ConnectorRegistry();
  registry.register('filesystem', config => new FilesystemConnector(config ?? {}));
  registry.register('sqlite', config => new SQLiteConnector(config ?? {}));
  return registry;
}

export class SpooldRuntime {
  constructor({ stateDir, host, port, allowedOrigins, maxBodyBytes, registry, configStore, jobStore, executionController, runner, commandService, ownerId }) {
    this.stateDir = stateDir;
    this.host = host;
    this.port = port;
    this.allowedOrigins = allowedOrigins;
    this.maxBodyBytes = maxBodyBytes;
    this.registry = registry;
    this.configStore = configStore;
    this.jobStore = jobStore;
    this.executionController = executionController;
    this.runner = runner;
    this.commandService = commandService;
    this.ownerId = ownerId;
    this.hostServer = null;
    this.lock = null;
    this.descriptor = null;
    this.closed = false;
  }

  async start() {
    if (this.closed) fail('SPOOLD_RUNTIME_CLOSED', 'spoold runtime is closed');
    if (this.hostServer || this.lock) fail('SPOOLD_ALREADY_STARTED', 'spoold runtime is already started');

    this.lock = await acquireStateLock(this.stateDir, this.ownerId);
    try {
      await removeIfExists(join(this.stateDir, DESCRIPTOR_FILE));
      const pairing = await loadOrCreatePairing(this.stateDir);
      await this.jobStore.recoverInterruptedJobs();

      const hostServer = new SpooldHost({
        commandService: this.commandService,
        token: pairing.token,
        host: this.host,
        port: this.port,
        allowedOrigins: this.allowedOrigins,
        maxBodyBytes: this.maxBodyBytes
      });
      const address = await hostServer.start();
      this.hostServer = hostServer;

      const descriptor = Object.freeze({
        schemaVersion: 1,
        protocolVersion: 'spoold-v1',
        instanceId: pairing.instanceId,
        pid: process.pid,
        host: address.host,
        port: address.port,
        endpoint: `http://${address.host === '::1' ? '[::1]' : address.host}:${address.port}`,
        auth: Object.freeze({ type: 'bearer', credentialFile: PAIRING_FILE }),
        startedAt: new Date().toISOString()
      });
      await atomicWriteJson(this.stateDir, DESCRIPTOR_FILE, descriptor);
      this.descriptor = descriptor;
      return structuredClone(descriptor);
    } catch (error) {
      if (this.hostServer) { await this.hostServer.close().catch(() => {}); this.hostServer = null; }
      await removeIfExists(join(this.stateDir, DESCRIPTOR_FILE)).catch(() => {});
      await releaseStateLock(this.lock).catch(() => {});
      this.lock = null;
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const errors = [];
    if (this.hostServer) {
      try { await this.hostServer.close(); }
      catch (error) { errors.push(error); }
      this.hostServer = null;
    }
    if (this.executionController) {
      try { await this.executionController.pauseAll(); }
      catch (error) { errors.push(error); }
    }
    try { await removeIfExists(join(this.stateDir, DESCRIPTOR_FILE)); }
    catch (error) { errors.push(error); }
    try { await releaseStateLock(this.lock); }
    catch (error) { errors.push(error); }
    this.lock = null;
    try { this.jobStore.close(); }
    catch (error) { errors.push(error); }
    this.descriptor = null;
    if (errors.length) throw errors[0];
  }
}

export async function createSpooldRuntime({ stateDir, host = DEFAULT_HOST, port = DEFAULT_PORT, allowedOrigins = [], maxBodyBytes } = {}) {
  requireStateDir(stateDir);
  if (!isLoopbackHost(host)) fail('SPOOLD_NON_LOOPBACK_BIND', 'spoold runtime may bind only to a loopback address');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);

  const registry = createRegistry();
  const configStore = new ConfigStore({ stateDir });
  const jobStore = new SQLiteJobStore({ stateDir });
  const executionController = new ExecutionController();
  const controlledJobStore = new ExecutionControlledJobStore({ store: jobStore, controller: executionController });
  const ownerId = `spoold:${process.pid}:${randomUUID()}`;
  const runner = new SharedMigrationRunner({ registry, store: controlledJobStore, ownerId });
  const commandService = new SpoolCommandService({ configStore, registry, jobStore, runner, executionController });

  return new SpooldRuntime({
    stateDir,
    host,
    port,
    allowedOrigins,
    maxBodyBytes,
    registry,
    configStore,
    jobStore,
    executionController,
    runner,
    commandService,
    ownerId
  });
}
