import { fail } from '../core/errors.js';
import { validateConnector } from './contract.js';

export class ConnectorRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(name, factory) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name ?? '')) fail('INVALID_CONNECTOR_NAME', 'Connector registry name is invalid');
    if (this.entries.has(name)) fail('CONNECTOR_ALREADY_REGISTERED', `Connector ${name} is already registered`);
    if (typeof factory !== 'function') fail('INVALID_CONNECTOR_FACTORY', 'Connector factory must be a function');

    const probe = factory(undefined, { registration: true });
    const manifest = validateConnector(probe);
    if (manifest.name !== name) {
      fail('CONNECTOR_NAME_MISMATCH', `Registered connector name ${name} does not match manifest name ${manifest.name}`);
    }
    this.entries.set(name, { factory, manifest });
    return structuredClone(manifest);
  }

  list() {
    return [...this.entries.values()].map(entry => structuredClone(entry.manifest)).sort((a, b) => a.name.localeCompare(b.name));
  }

  manifest(name) {
    const entry = this.entries.get(name);
    if (!entry) fail('CONNECTOR_NOT_FOUND', `Connector ${name} is not registered`);
    return structuredClone(entry.manifest);
  }

  async open(name, config = {}, context = {}) {
    const entry = this.entries.get(name);
    if (!entry) fail('CONNECTOR_NOT_FOUND', `Connector ${name} is not registered`);
    const connector = entry.factory(config, context);
    const manifest = validateConnector(connector);
    if (manifest.name !== name) fail('CONNECTOR_NAME_MISMATCH', `Connector factory returned ${manifest.name} for ${name}`);
    const connection = await connector.validateConfig(config, context);
    Object.defineProperty(connector, 'connection', {
      value: structuredClone(connection),
      enumerable: true,
      configurable: false,
      writable: false
    });
    return connector;
  }
}
