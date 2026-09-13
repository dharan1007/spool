import { fail } from '../core/errors.js';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';
import { connectorIdentity } from '../platform/contracts.js';

const REQUEST_DOMAIN = 'spool-migration-request-v1';

export function migrationRequestSemanticId(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_MIGRATION_REQUEST', 'Migration request must be an object');
  if (typeof request.migrationId !== 'string' || !request.migrationId) fail('INVALID_MIGRATION_ID', 'migrationId is required');
  if (typeof request.principal !== 'string' || !request.principal.trim()) fail('INVALID_PRINCIPAL', 'principal is required');
  if (!request.planInput || typeof request.planInput !== 'object' || Array.isArray(request.planInput)) fail('INVALID_MIGRATION_REQUEST', 'planInput is required');
  const input = JSON.parse(canonicalJson(request.planInput));
  input.sourceRef = connectorIdentity(input.sourceRef);
  input.targetRef = connectorIdentity(input.targetRef);
  return sha256Canonical(REQUEST_DOMAIN, {
    migrationId: request.migrationId,
    principal: request.principal,
    planInput: input
  });
}
