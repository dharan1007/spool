import { fail } from '../core/errors.js';
import { sha256Canonical } from '../platform/canonical-json.js';

const HASH_ID = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const WAL_LSN = /^[0-9A-F]+\/[0-9A-F]+$/i;
const TXID = /^\d+$/;
const PG_SNAPSHOT_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-\d+$/;
const SOURCE_DOMAIN = 'spool-source-state-v1';
const TARGET_DOMAIN = 'spool-target-state-v1';

export const SOURCE_STATE_KINDS = Object.freeze({
  FILESYSTEM: 'filesystem-content-v1',
  POSTGRES: 'postgres-mvcc-v1'
});

export const TARGET_STATE_KINDS = Object.freeze({
  SQLITE: 'sqlite-target-v1',
  POSTGRES: 'postgres-target-v1'
});

function exactObject(value, allowed, unknownCode, invalidCode, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(invalidCode, `${label} must use a plain-object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) fail(invalidCode, `${label}.${key} must be inert data`);
    if (!allowed.has(key)) fail(unknownCode, `Unknown ${label} field ${key}`, { field: key });
  }
  return value;
}

function requiredString(value, invalidCode, field) {
  if (typeof value !== 'string' || !value.trim()) fail(invalidCode, `${field} must be a non-empty string`);
  return value;
}

function requiredSafeInteger(value, invalidCode, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(invalidCode, `${field} must be a safe integer >= ${min}`);
  return value;
}

function hashId(value, invalidCode, field) {
  if (typeof value !== 'string' || !HASH_ID.test(value)) fail(invalidCode, `${field} must be a canonical sha256 identity`);
  return value;
}

function buildDescriptor({ type, kind, state, domain }) {
  const record = Object.freeze({ schemaVersion: 1, kind, state: deepFreeze(state) });
  const identity = sha256Canonical(domain, record);
  return Object.freeze({
    schemaVersion: 1,
    kind,
    [`${type}StateId`]: identity,
    state: record.state
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function createFilesystemSourceState(input) {
  exactObject(
    input,
    new Set(['path', 'size', 'contentSha256', 'snapshotId']),
    'UNKNOWN_SOURCE_STATE_FIELD',
    'INVALID_SOURCE_STATE',
    'filesystem SourceState'
  );
  const path = requiredString(input.path, 'INVALID_SOURCE_STATE', 'path');
  const size = requiredSafeInteger(input.size, 'INVALID_SOURCE_STATE', 'size');
  if (typeof input.contentSha256 !== 'string' || !HEX_SHA256.test(input.contentSha256)) {
    fail('INVALID_SOURCE_STATE', 'contentSha256 must be a lowercase SHA-256 digest');
  }
  const snapshotId = hashId(input.snapshotId, 'INVALID_SOURCE_STATE', 'snapshotId');
  return buildDescriptor({
    type: 'source',
    kind: SOURCE_STATE_KINDS.FILESYSTEM,
    domain: SOURCE_DOMAIN,
    state: { path, size, contentSha256: input.contentSha256, snapshotId }
  });
}

function normalizePostgresRelation(relation, invalidCode, label) {
  exactObject(relation, new Set(['schema', 'table', 'relid']), 'UNKNOWN_SOURCE_STATE_FIELD', invalidCode, label);
  return {
    schema: requiredString(relation.schema, invalidCode, `${label}.schema`),
    table: requiredString(relation.table, invalidCode, `${label}.table`),
    relid: requiredSafeInteger(relation.relid, invalidCode, `${label}.relid`, { min: 1 })
  };
}

function normalizePgBase(input, { unknownCode, invalidCode, includeSnapshot }) {
  const allowed = new Set(['systemIdentifier', 'databaseOid', 'databaseName', 'serverVersionNum', 'relation', 'contractId']);
  if (includeSnapshot) {
    allowed.add('snapshot');
    allowed.add('walLsn');
  }
  exactObject(input, allowed, unknownCode, invalidCode, includeSnapshot ? 'PostgreSQL SourceState' : 'PostgreSQL TargetState');

  const systemIdentifier = requiredString(input.systemIdentifier, invalidCode, 'systemIdentifier');
  if (!/^\d+$/.test(systemIdentifier)) fail(invalidCode, 'systemIdentifier must be the PostgreSQL numeric system identifier');
  const databaseOid = requiredSafeInteger(input.databaseOid, invalidCode, 'databaseOid', { min: 1 });
  const databaseName = requiredString(input.databaseName, invalidCode, 'databaseName');
  const serverVersionNum = requiredSafeInteger(input.serverVersionNum, invalidCode, 'serverVersionNum', { min: 90000 });
  const relation = normalizePostgresRelation(input.relation, invalidCode, 'relation');
  const contractId = hashId(input.contractId, invalidCode, 'contractId');
  return { systemIdentifier, databaseOid, databaseName, serverVersionNum, relation, contractId };
}

function normalizePgSnapshot(snapshot) {
  exactObject(snapshot, new Set(['exportedSnapshotId', 'xmin', 'xmax', 'xip']), 'UNKNOWN_SOURCE_STATE_FIELD', 'INVALID_SOURCE_STATE', 'snapshot');
  const exportedSnapshotId = requiredString(snapshot.exportedSnapshotId, 'INVALID_SOURCE_STATE', 'snapshot.exportedSnapshotId');
  if (!PG_SNAPSHOT_ID.test(exportedSnapshotId)) fail('INVALID_SOURCE_STATE', 'snapshot.exportedSnapshotId is not a valid PostgreSQL exported snapshot identifier');
  const xmin = requiredString(snapshot.xmin, 'INVALID_SOURCE_STATE', 'snapshot.xmin');
  const xmax = requiredString(snapshot.xmax, 'INVALID_SOURCE_STATE', 'snapshot.xmax');
  if (!TXID.test(xmin) || !TXID.test(xmax)) fail('INVALID_SOURCE_STATE', 'snapshot xmin/xmax must be decimal transaction IDs');
  if (!Array.isArray(snapshot.xip) || snapshot.xip.some(item => typeof item !== 'string' || !TXID.test(item))) {
    fail('INVALID_SOURCE_STATE', 'snapshot.xip must contain decimal transaction IDs');
  }
  const xip = [...new Set(snapshot.xip)].sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { exportedSnapshotId, xmin, xmax, xip };
}

export function createPostgresSourceState(input) {
  const base = normalizePgBase(input, {
    unknownCode: 'UNKNOWN_SOURCE_STATE_FIELD',
    invalidCode: 'INVALID_SOURCE_STATE',
    includeSnapshot: true
  });
  const snapshot = normalizePgSnapshot(input.snapshot);
  const walLsn = requiredString(input.walLsn, 'INVALID_SOURCE_STATE', 'walLsn').toUpperCase();
  if (!WAL_LSN.test(walLsn)) fail('INVALID_SOURCE_STATE', 'walLsn must be a PostgreSQL WAL LSN');
  return buildDescriptor({
    type: 'source',
    kind: SOURCE_STATE_KINDS.POSTGRES,
    domain: SOURCE_DOMAIN,
    state: { ...base, snapshot, walLsn }
  });
}

export function createSqliteTargetState(input) {
  exactObject(
    input,
    new Set(['realPath', 'device', 'inode', 'table', 'contractId']),
    'UNKNOWN_TARGET_STATE_FIELD',
    'INVALID_TARGET_STATE',
    'SQLite TargetState'
  );
  return buildDescriptor({
    type: 'target',
    kind: TARGET_STATE_KINDS.SQLITE,
    domain: TARGET_DOMAIN,
    state: {
      realPath: requiredString(input.realPath, 'INVALID_TARGET_STATE', 'realPath'),
      device: requiredSafeInteger(input.device, 'INVALID_TARGET_STATE', 'device'),
      inode: requiredSafeInteger(input.inode, 'INVALID_TARGET_STATE', 'inode'),
      table: requiredString(input.table, 'INVALID_TARGET_STATE', 'table'),
      contractId: hashId(input.contractId, 'INVALID_TARGET_STATE', 'contractId')
    }
  });
}

export function createPostgresTargetState(input) {
  const base = normalizePgBase(input, {
    unknownCode: 'UNKNOWN_TARGET_STATE_FIELD',
    invalidCode: 'INVALID_TARGET_STATE',
    includeSnapshot: false
  });
  return buildDescriptor({
    type: 'target',
    kind: TARGET_STATE_KINDS.POSTGRES,
    domain: TARGET_DOMAIN,
    state: base
  });
}

export function assertSourceStateBinding(expected, actual) {
  if (!expected || !actual || typeof expected.sourceStateId !== 'string' || typeof actual.sourceStateId !== 'string') {
    fail('INVALID_SOURCE_STATE', 'Canonical SourceState descriptors are required');
  }
  if (expected.sourceStateId !== actual.sourceStateId) {
    fail('SOURCE_DRIFT', 'Source state changed since binding', {
      expectedSourceStateId: expected.sourceStateId,
      actualSourceStateId: actual.sourceStateId
    });
  }
  return true;
}

export function assertTargetStateBinding(expected, actual) {
  if (!expected || !actual || typeof expected.targetStateId !== 'string' || typeof actual.targetStateId !== 'string') {
    fail('INVALID_TARGET_STATE', 'Canonical TargetState descriptors are required');
  }
  if (expected.targetStateId !== actual.targetStateId) {
    fail('TARGET_DRIFT', 'Target state changed since binding', {
      expectedTargetStateId: expected.targetStateId,
      actualTargetStateId: actual.targetStateId
    });
  }
  return true;
}
