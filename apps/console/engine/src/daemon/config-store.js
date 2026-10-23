import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { canonicalJson } from '../platform/canonical-json.js';
import { validateSecretRef } from '../platform/secrets.js';

const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONNECTOR_TYPE = /^[a-z][a-z0-9_-]{1,63}$/;
const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|credential|credentials|access[_-]?key|private[_-]?key)$/i;
const ALLOWED_DESCRIPTOR_KEYS = new Set(['name', 'type', 'config', 'secretRefs', 'createdAt']);

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function assertNoRawSecrets(value, path = '$') {
  if (typeof value === 'string') {
    if (!value.includes('://')) return;
    try {
      const url = new URL(value);
      if (url.username || url.password) fail('SECRET_IN_CONNECTION_DESCRIPTOR', `Credential-bearing URL is not allowed at ${path}`);
    } catch (error) {
      if (error?.code === 'SECRET_IN_CONNECTION_DESCRIPTOR') throw error;
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail('SECRET_IN_CONNECTION_DESCRIPTOR', `Raw secret field ${key} is not allowed in connection descriptors`);
    assertNoRawSecrets(child, `${path}.${key}`);
  }
}

function validateDescriptor(name, descriptor) {
  if (!CONNECTION_NAME.test(name)) fail('INVALID_CONNECTION_DESCRIPTOR', 'Invalid connection name');
  const cloned = canonicalClone(descriptor);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) fail('INVALID_CONNECTION_DESCRIPTOR', 'Connection descriptor must be an object');
  const unknown = Object.keys(cloned).filter(key => !ALLOWED_DESCRIPTOR_KEYS.has(key));
  if (unknown.length) fail('INVALID_CONNECTION_DESCRIPTOR', `Unsupported connection descriptor field ${unknown[0]}`);
  if (cloned.name !== name) fail('INVALID_CONNECTION_DESCRIPTOR', 'Descriptor name must match connection key');
  if (!CONNECTOR_TYPE.test(cloned.type ?? '')) fail('INVALID_CONNECTION_DESCRIPTOR', 'Invalid connector type');
  if (!cloned.config || typeof cloned.config !== 'object' || Array.isArray(cloned.config)) fail('INVALID_CONNECTION_DESCRIPTOR', 'config must be an object');
  if (!cloned.secretRefs || typeof cloned.secretRefs !== 'object' || Array.isArray(cloned.secretRefs)) fail('INVALID_CONNECTION_DESCRIPTOR', 'secretRefs must be an object');
  if (typeof cloned.createdAt !== 'string' || Number.isNaN(Date.parse(cloned.createdAt))) fail('INVALID_CONNECTION_DESCRIPTOR', 'createdAt must be a date-time string');

  assertNoRawSecrets(cloned.config, '$.config');
  for (const [key, ref] of Object.entries(cloned.secretRefs)) {
    if (!SECRET_KEY.test(key) && !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) fail('INVALID_CONNECTION_DESCRIPTOR', `Invalid secretRefs key ${key}`);
    cloned.secretRefs[key] = validateSecretRef(ref);
  }
  return cloned;
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || !state.connections || typeof state.connections !== 'object' || Array.isArray(state.connections)) {
    fail('INVALID_CONFIG_STORE', 'Persisted connection store has an invalid shape');
  }
  const keys = Object.keys(state);
  if (keys.some(key => !['version', 'connections'].includes(key))) fail('INVALID_CONFIG_STORE', 'Persisted connection store contains unsupported fields');
  const connections = {};
  for (const [name, descriptor] of Object.entries(state.connections)) {
    try {
      connections[name] = validateDescriptor(name, descriptor);
    } catch (error) {
      fail('INVALID_CONFIG_STORE', `Persisted connection ${name} is invalid`, { cause: error?.code ?? 'UNKNOWN' });
    }
  }
  return { version: 1, connections };
}

export class ConfigStore {
  constructor(stateDir) {
    if (typeof stateDir !== 'string' || !stateDir.trim()) fail('INVALID_CONFIG_STORE_PATH', 'stateDir is required');
    this.stateDir = stateDir;
    this.file = join(stateDir, 'connections.json');
    this.writeQueue = Promise.resolve();
  }

  async #readState() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, connections: {} };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('INVALID_CONFIG_STORE', 'Persisted connection store is not valid JSON');
    }
    return validateState(parsed);
  }

  async #writeState(state) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    const payload = `${canonicalJson(validateState(state))}\n`;
    try {
      await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
    } catch (error) {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(temp);
      } catch {}
      throw error;
    }
  }

  async putConnection(name, descriptor) {
    const validated = validateDescriptor(name, descriptor);
    const operation = this.writeQueue.then(async () => {
      const state = await this.#readState();
      state.connections[name] = validated;
      await this.#writeState(state);
      return canonicalClone(validated);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async getConnection(name) {
    if (!CONNECTION_NAME.test(name ?? '')) fail('INVALID_CONNECTION_DESCRIPTOR', 'Invalid connection name');
    await this.writeQueue;
    const state = await this.#readState();
    const descriptor = state.connections[name];
    return descriptor ? canonicalClone(descriptor) : null;
  }

  async listConnections() {
    await this.writeQueue;
    const state = await this.#readState();
    return Object.keys(state.connections).sort().map(name => canonicalClone(state.connections[name]));
  }
}
