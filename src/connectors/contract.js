import { fail } from '../core/errors.js';

export const CONNECTOR_CAPABILITIES = Object.freeze([
  'source', 'target', 'discover', 'streaming', 'transactions', 'bulkWrite',
  'upsert', 'ddl', 'rollback', 'checksum', 'pagination', 'rateLimitAware'
]);

const REQUIRED_METHODS = Object.freeze([
  'manifest', 'validateConfig', 'testConnection', 'discover', 'read',
  'planWrite', 'write', 'verify', 'close'
]);

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest must be an object');
  }
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(manifest.name ?? '')) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest name is invalid');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail('INVALID_CONNECTOR_MANIFEST', 'Connector manifest version must be semver-like');
  }
  if (!manifest.capabilities || typeof manifest.capabilities !== 'object' || Array.isArray(manifest.capabilities)) {
    fail('INVALID_CONNECTOR_CAPABILITIES', 'Connector capabilities must be an object');
  }
  for (const capability of CONNECTOR_CAPABILITIES) {
    if (typeof manifest.capabilities[capability] !== 'boolean') {
      fail('INVALID_CONNECTOR_CAPABILITIES', `Connector capability ${capability} must be declared as boolean`);
    }
  }
  const unknown = Object.keys(manifest.capabilities).filter(key => !CONNECTOR_CAPABILITIES.includes(key));
  if (unknown.length) fail('INVALID_CONNECTOR_CAPABILITIES', `Unknown connector capabilities: ${unknown.join(', ')}`);
  return structuredClone(manifest);
}

export function validateConnector(connector) {
  if (!connector || (typeof connector !== 'object' && typeof connector !== 'function')) {
    fail('INVALID_CONNECTOR', 'Connector must be an object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof connector[method] !== 'function') fail('INVALID_CONNECTOR', `Connector method ${method} is required`);
  }
  const manifest = validateManifest(connector.manifest());
  if (manifest.capabilities.rollback && typeof connector.rollback !== 'function') {
    fail('INVALID_CONNECTOR', 'Connector advertises rollback but does not implement rollback()');
  }
  return manifest;
}

export function assertAsyncIterable(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    fail('INVALID_CONNECTOR_STREAM', 'Connector read() must return an AsyncIterable');
  }
  return stream;
}
