import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { containsSecretMaterialKeys } from '../platform/redact.js';
import { validateSecretRef } from '../platform/secrets.js';

const CONNECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONNECTION_TYPE = /^[a-z][a-z0-9_-]{1,63}$/;

function clone(value) { return structuredClone(value); }

function validateDescriptor(name, descriptor) {
  if (!CONNECTION_NAME.test(name ?? '')) fail('INVALID_CONNECTION_NAME', 'Connection name is invalid');
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fail('INVALID_CONNECTION_DESCRIPTOR', 'Connection descriptor must be an object');
  }
  if (!CONNECTION_TYPE.test(descriptor.type ?? '')) {
    fail('INVALID_CONNECTION_DESCRIPTOR', 'Connection type is invalid');
  }
  const config = descriptor.config ?? {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('INVALID_CONNECTION_DESCRIPTOR', 'Connection config must be an object');
  }
  if (containsSecretMaterialKeys(config)) {
    fail('RAW_SECRET_IN_CONFIG', 'Connection config may not contain password, token, credential, or other raw secret fields; use secretRefs');
  }
  const secretRefs = descriptor.secretRefs ?? {};
  if (!secretRefs || typeof secretRefs !== 'object' || Array.isArray(secretRefs)) {
    fail('INVALID_CONNECTION_DESCRIPTOR', 'secretRefs must be an object');
  }
  for (const ref of Object.values(secretRefs)) validateSecretRef(ref);
  return { config: clone(config), secretRefs: clone(secretRefs) };
}

export class ConfigStore {
  constructor({ stateDir }) {
    if (typeof stateDir !== 'string' || !stateDir) fail('INVALID_STATE_DIR', 'stateDir is required');
    this.stateDir = stateDir;
    this.file = join(stateDir, 'connections.json');
  }

  async loadDocument() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed?.version !== 1 || !parsed.connections || typeof parsed.connections !== 'object' || Array.isArray(parsed.connections)) {
        fail('INVALID_CONNECTION_STORE', 'Connection store has an invalid schema');
      }
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, connections: {} };
      throw error;
    }
  }

  async saveDocument(document) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.stateDir, `.connections.${process.pid}.${randomUUID()}.tmp`);
    const body = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.file);
  }

  async putConnection(name, descriptor) {
    const { config, secretRefs } = validateDescriptor(name, descriptor);
    const document = await this.loadDocument();
    const existing = document.connections[name];
    const now = new Date().toISOString();
    const stored = {
      name,
      type: descriptor.type,
      config,
      secretRefs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    document.connections[name] = stored;
    await this.saveDocument(document);
    return clone(stored);
  }

  async getConnection(name) {
    if (!CONNECTION_NAME.test(name ?? '')) fail('INVALID_CONNECTION_NAME', 'Connection name is invalid');
    const document = await this.loadDocument();
    return document.connections[name] ? clone(document.connections[name]) : null;
  }

  async listConnections() {
    const document = await this.loadDocument();
    return Object.values(document.connections).map(clone).sort((a, b) => a.name.localeCompare(b.name));
  }
}
