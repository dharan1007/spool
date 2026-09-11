import { fail } from '../core/errors.js';
import { validateConnectorDescriptor } from './contract.js';

const ROLES = new Set(['source', 'target']);

function registrationKey(name, role) {
  return `${role}:${name}`;
}

function requireRole(role) {
  if (!ROLES.has(role)) fail('INVALID_CONNECTOR_ROLE', `Unsupported connector role ${String(role)}`);
  return role;
}

function requireName(name) {
  if (typeof name !== 'string' || !name) fail('INVALID_CONNECTOR_NAME', 'Connector name is required');
  return name;
}

export class ConnectorRegistry {
  constructor() {
    this.registrations = new Map();
  }

  register(descriptorInput, factory) {
    const descriptor = validateConnectorDescriptor(descriptorInput);
    if (typeof factory !== 'function') fail('INVALID_CONNECTOR_FACTORY', 'Connector factory must be a function');

    const key = registrationKey(descriptor.name, descriptor.role);
    if (this.registrations.has(key)) {
      fail('CONNECTOR_ALREADY_REGISTERED', `Connector ${descriptor.name} is already registered for role ${descriptor.role}`);
    }

    this.registrations.set(key, Object.freeze({ descriptor, factory }));
    return descriptor;
  }

  descriptor(name, role) {
    const key = registrationKey(requireName(name), requireRole(role));
    const registration = this.registrations.get(key);
    if (!registration) fail('CONNECTOR_NOT_REGISTERED', `Connector ${name} is not registered for role ${role}`);
    return registration.descriptor;
  }

  list({ role } = {}) {
    if (role !== undefined) requireRole(role);
    const descriptors = [...this.registrations.values()]
      .map(registration => registration.descriptor)
      .filter(descriptor => role === undefined || descriptor.role === role)
      .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    return Object.freeze(descriptors);
  }

  async open(name, role, config = undefined, context = undefined) {
    const key = registrationKey(requireName(name), requireRole(role));
    const registration = this.registrations.get(key);
    if (!registration) fail('CONNECTOR_NOT_REGISTERED', `Connector ${name} is not registered for role ${role}`);

    const opened = await registration.factory({
      descriptor: registration.descriptor,
      config,
      context
    });
    if (!opened || typeof opened !== 'object') {
      fail('INVALID_CONNECTOR_RUNTIME', `Connector ${name} factory did not return a runtime object`);
    }
    return opened;
  }
}
