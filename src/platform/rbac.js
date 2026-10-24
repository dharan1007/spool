import { fail } from '../core/errors.js';

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
  API_CLIENT: 'api-client'
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set(['*']),
  [ROLES.OPERATOR]: new Set([
    'migration.create',
    'migration.plan',
    'migration.dryRun',
    'migration.approve',
    'migration.execute',
    'migration.status',
    'migration.receipt',
    'migration.verification',
    'migration.history',
    'source.inspect',
    'destination.inspect',
    'destination.listTables'
  ]),
  [ROLES.VIEWER]: new Set([
    'migration.status',
    'migration.receipt',
    'migration.verification',
    'migration.history',
    'source.inspect',
    'destination.inspect',
    'destination.listTables'
  ]),
  [ROLES.API_CLIENT]: new Set([
    'migration.create',
    'migration.plan',
    'migration.dryRun',
    'migration.approve',
    'migration.execute',
    'migration.status',
    'migration.receipt',
    'migration.verification',
    'migration.history'
  ])
});

export function authorizeRole(role, action) {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) {
    fail('UNAUTHORIZED', `Unknown role: ${role}`);
  }
  if (permissions.has('*') || permissions.has(action)) {
    return true;
  }
  return false;
}

export function assertAuthorized(role, action) {
  if (!authorizeRole(role, action)) {
    fail('FORBIDDEN', `Role '${role}' is not authorized to perform '${action}'`);
  }
}
