import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, authorizeRole, assertAuthorized } from '../src/platform/rbac.js';

test('RBAC role permissions', () => {
  // Admin can do anything
  assert.equal(authorizeRole(ROLES.ADMIN, 'system.nuke'), true);
  assert.equal(authorizeRole(ROLES.ADMIN, 'migration.create'), true);

  // Operator can create/approve/execute migrations but not user-mgmt
  assert.equal(authorizeRole(ROLES.OPERATOR, 'migration.create'), true);
  assert.equal(authorizeRole(ROLES.OPERATOR, 'migration.approve'), true);
  assert.equal(authorizeRole(ROLES.OPERATOR, 'user.create'), false);

  // Viewer can only read
  assert.equal(authorizeRole(ROLES.VIEWER, 'migration.status'), true);
  assert.equal(authorizeRole(ROLES.VIEWER, 'migration.create'), false);
  assert.equal(authorizeRole(ROLES.VIEWER, 'migration.approve'), false);

  // assertAuthorized throws on forbidden
  assert.doesNotThrow(() => assertAuthorized(ROLES.OPERATOR, 'migration.execute'));
  assert.throws(() => assertAuthorized(ROLES.VIEWER, 'migration.execute'), /FORBIDDEN/);
});
