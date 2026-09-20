import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { parsePostgresEndpoint, postgresConnectionConfig } from './connection.js';
import { validateSecretRef } from '../../platform/secrets.js';
import { withExportedPostgresSnapshot } from './database-source.js';
import { buildSnapshotCdcBinding } from '../../protocol/migration-state-machine.js';

const SLOT_NAME = /^[a-z0-9_]{1,63}$/;
const PUBLICATION_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_POSTGRES_CDC_CONFIG', `${label} must be a non-empty string`);
  if (value.includes('\u0000')) fail('INVALID_POSTGRES_CDC_CONFIG', `${label} cannot contain NUL`);
  return value.trim();
}

function requireSlotName(value) {
  const name = requireText(value, 'slotName').toLowerCase();
  if (!SLOT_NAME.test(name)) fail('INVALID_POSTGRES_CDC_CONFIG', 'slotName must be 1-63 lowercase letters, digits or underscores');
  return name;
}

function requireDatabaseRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('INVALID_POSTGRES_CDC_CONFIG', 'PostgreSQL database ref is required');
  const endpoint = parsePostgresEndpoint(ref.endpoint);
  const database = requireText(ref.database, 'ref.database');
  const user = requireText(ref.identity?.user, 'ref.identity.user');
  const secretRef = validateSecretRef(ref.secretRef);
  return Object.freeze({ endpoint: endpoint.endpoint, database, identity: Object.freeze({ user }), secretRef });
}

export function comparePostgresLsn(left, right) {
  for (const value of [left, right]) {
    if (typeof value !== 'string' || !LSN.test(value)) fail('INVALID_POSTGRES_LSN', 'PostgreSQL LSN must look like 0/16B6C50');
  }
  const toBigInt = value => {
    const [hi, lo] = value.split('/');
    return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
  };
  const difference = toBigInt(left) - toBigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function withCdcClient({ databaseRef, credentialBroker }, callback) {
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_CDC_CONFIG', 'credentialBroker.withSecret() is required');
  if (typeof callback !== 'function') fail('INVALID_POSTGRES_CDC_CONFIG', 'CDC client callback is required');
  const { Client } = await import('pg');
  return credentialBroker.withSecret(databaseRef.secretRef, async password => {
    const client = new Client(postgresConnectionConfig({ ...databaseRef, identity: databaseRef.identity }, password));
    await client.connect();
    try {
      return await callback(client);
    } finally {
      try { await client.end(); } catch { /* primary operation error wins */ }
    }
  });
}

export async function getPostgresFlushLsn({ ref, credentialBroker } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    const result = await client.query('SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS lsn');
    const lsn = result.rows[0]?.lsn ?? null;
    if (typeof lsn !== 'string' || !LSN.test(lsn)) fail('CDC_FLUSH_LSN_UNAVAILABLE', 'Could not read the current WAL flush position');
    return lsn.toUpperCase();
  });
}

export async function describePostgresSlot({ ref, credentialBroker, slotName } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  const name = requireSlotName(slotName);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    const result = await client.query(
      `SELECT slot_name AS "slotName", plugin, slot_type AS "slotType",
              active AS "active", active_pid AS "activePid",
              restart_lsn::text AS "restartLsn", confirmed_flush_lsn::text AS "confirmedFlushLsn",
              database AS "database"
       FROM pg_catalog.pg_replication_slots WHERE slot_name = $1`,
      [name]
    );
    const row = result.rows[0] ?? null;
    if (!row) return null;
    return Object.freeze({
      slotName: row.slotName, plugin: row.plugin, slotType: row.slotType,
      active: row.active === true, activePid: row.activePid,
      restartLsn: row.restartLsn, confirmedFlushLsn: row.confirmedFlushLsn,
      database: row.database
    });
  });
}

export function assertSlotContractUsable({ slot, database, plugin = 'pgoutput', slotName } = {}) {
  if (!slot) fail('CDC_SLOT_LOST', 'Required replication slot does not exist; operator recovery with a new snapshot boundary is required', { slotName });
  if (slot.plugin !== plugin) {
    fail('SLOT_CONTRACT_MISMATCH', 'Existing replication slot uses a different output plugin; refusing to reuse it', {
      slotName, expectedPlugin: plugin, actualPlugin: slot.plugin
    });
  }
  if (slot.slotType !== 'logical') {
    fail('SLOT_CONTRACT_MISMATCH', 'Existing replication slot is not a logical slot; refusing to reuse it', { slotName, slotType: slot.slotType });
  }
  if (slot.database !== database) {
    fail('SLOT_CONTRACT_MISMATCH', 'Existing replication slot belongs to a different database; refusing to reuse it', {
      slotName, expectedDatabase: database, actualDatabase: slot.database
    });
  }
  return slot;
}

export async function createPostgresReplicationSlot({ ref, credentialBroker, slotName, plugin = 'pgoutput' } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  const name = requireSlotName(slotName);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    try {
      const result = await client.query('SELECT * FROM pg_catalog.pg_create_logical_replication_slot($1, $2)', [name, plugin]);
      return Object.freeze({ slotName: name, plugin, existed: false, lsn: result.rows[0]?.consistent_point ?? null });
    } catch (error) {
      if (error?.code === '42710') {
        const existing = await describePostgresSlot({ ref, credentialBroker, slotName: name });
        assertSlotContractUsable({ slot: existing, database: databaseRef.database, plugin, slotName: name });
        return Object.freeze({ slotName: name, plugin: existing.plugin, existed: true, active: existing.active, lsn: existing.restartLsn });
      }
      throw error;
    }
  });
}

export async function dropPostgresReplicationSlot({ ref, credentialBroker, slotName } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  const name = requireSlotName(slotName);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    try {
      await client.query('SELECT pg_catalog.pg_drop_replication_slot($1)', [name]);
      return Object.freeze({ slotName: name, dropped: true });
    } catch (error) {
      if (error?.code === '42704') return Object.freeze({ slotName: name, dropped: false });
      throw error;
    }
  });
}

export async function describePostgresPublication({ ref, credentialBroker, publicationName } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  if (typeof publicationName !== 'string' || !PUBLICATION_NAME.test(publicationName)) {
    fail('INVALID_POSTGRES_CDC_CONFIG', 'publicationName must be a valid PostgreSQL identifier');
  }
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    const pub = await client.query(
      `SELECT pubname AS "name", pubinsert AS "insert", pubupdate AS "update",
              pubdelete AS "delete", pubtruncate AS "truncate"
       FROM pg_catalog.pg_publication WHERE pubname = $1`,
      [publicationName]
    );
    if (pub.rows.length === 0) return null;
    const tables = await client.query(
      `SELECT schemaname AS "schema", tablename AS "table"
       FROM pg_catalog.pg_publication_tables WHERE pubname = $1 ORDER BY schemaname, tablename`,
      [publicationName]
    );
    return Object.freeze({
      publicationName,
      insert: pub.rows[0].insert === true,
      update: pub.rows[0].update === true,
      delete: pub.rows[0].delete === true,
      truncate: pub.rows[0].truncate === true,
      tables: Object.freeze(tables.rows.map(row => Object.freeze({ schema: row.schema, table: row.table })))
    });
  });
}

export function assertPublicationContractUsable({ publication, publicationName, tables } = {}) {
  if (!publication) fail('CDC_PUBLICATION_MISSING', 'Required publication does not exist', { publicationName });
  const expected = [...tables.map(t => `${t.schema}.${t.table}`)].sort();
  const actual = [...publication.tables.map(t => `${t.schema}.${t.table}`)].sort();
  const same = expected.length === actual.length && expected.every((value, index) => value === actual[index]);
  if (!same) {
    fail('PUBLICATION_MISMATCH', 'Existing publication covers a different table set; refusing to reuse it', {
      publicationName, expectedTables: expected, actualTables: actual
    });
  }
  for (const operation of ['insert', 'update', 'delete']) {
    if (publication[operation] !== true) {
      fail('PUBLICATION_MISMATCH', `Existing publication does not publish required operation ${operation}`, { publicationName, operation });
    }
  }
  return publication;
}

export async function ensurePostgresPublication({ ref, credentialBroker, publicationName, tables } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  if (typeof publicationName !== 'string' || !PUBLICATION_NAME.test(publicationName)) {
    fail('INVALID_POSTGRES_CDC_CONFIG', 'publicationName must be a valid PostgreSQL identifier');
  }
  if (!Array.isArray(tables) || tables.length === 0) fail('INVALID_POSTGRES_CDC_CONFIG', 'publication tables must be a non-empty array');
  const normalized = tables.map((table, index) => {
    if (!table || typeof table !== 'object') fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} must be an object`);
    if (typeof table.schema !== 'string' || !TABLE_NAME.test(table.schema)) fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} schema is invalid`);
    if (typeof table.table !== 'string' || !TABLE_NAME.test(table.table)) fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} table is invalid`);
    return { schema: table.schema, table: table.table };
  });
  const qualified = normalized.map(table => `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    try {
      await client.query(`CREATE PUBLICATION ${quoteIdentifier(publicationName)} FOR TABLE ${qualified.join(', ')}`);
      return Object.freeze({ publicationName, created: true });
    } catch (error) {
      if (error?.code === '42710') {
        const existing = await describePostgresPublication({ ref, credentialBroker, publicationName });
        assertPublicationContractUsable({ publication: existing, publicationName, tables: normalized });
        return Object.freeze({ publicationName, created: false });
      }
      throw error;
    }
  });
}

// Establish a formal snapshot/CDC boundary with a proven no-gap argument.
//
// Ordering (this order is the proof):
//  1. The logical slot is created (or validated) FIRST, reserving WAL from
//     its consistent point P. Nothing committed at or after P can be lost:
//     the server retains it for the slot.
//  2. The MVCC snapshot is exported SECOND. It contains exactly the
//     transactions committed before its xmin instant S (with S after P in
//     wall time, hence commit-LSN(S) >= P).
//
// Coverage: every committed source transaction either committed before S
// (visible in the snapshot) or commits after S (commit LSN > LSN(S) >= P,
// therefore emitted by CDC from P). No committed transaction belongs to
// neither. Transactions committing in (P, S] are BOTH visible and emitted
// (overlap by design); the target reconciles them idempotently through the
// batch ledger, so overlap is safe and gaplessness is what matters.
//
// The returned boundary pins snapshotLsn to the slot consistent point and
// requires cdcStartLsn >= snapshotLsn; a boundary whose snapshot does not
// match its slot reservation fails closed (CDC_BOUNDARY_MISMATCH).
export async function establishPostgresSnapshotCdcBoundary({
  ref, credentialBroker, slotName, plugin = 'pgoutput',
  publicationName, tables, sourceStateId, databaseSnapshotIdentity = null, catalogId = null
} = {}) {
  const databaseRef = requireDatabaseRef(ref);
  if (typeof sourceStateId !== 'string' || !sourceStateId) fail('INVALID_POSTGRES_CDC_CONFIG', 'sourceStateId is required');
  const normalizedTables = (Array.isArray(tables) ? tables : []).map((table, index) => {
    if (!table || typeof table !== 'object') fail('INVALID_POSTGRES_CDC_CONFIG', `boundary table ${index} must be an object`);
    if (typeof table.schema !== 'string' || !TABLE_NAME.test(table.schema)) fail('INVALID_POSTGRES_CDC_CONFIG', `boundary table ${index} schema is invalid`);
    if (typeof table.table !== 'string' || !TABLE_NAME.test(table.table)) fail('INVALID_POSTGRES_CDC_CONFIG', `boundary table ${index} table is invalid`);
    return { schema: table.schema, table: table.table };
  });
  if (normalizedTables.length === 0) fail('INVALID_POSTGRES_CDC_CONFIG', 'boundary tables must be a non-empty array');

  // 1. Publication first (validated definition, fail closed on drift).
  const publication = await ensurePostgresPublication({ ref, credentialBroker, publicationName, tables: normalizedTables });
  // 2. Slot second: reserves WAL from its consistent point P.
  const slot = await createPostgresReplicationSlot({ ref, credentialBroker, slotName, plugin });
  const slotRecord = await describePostgresSlot({ ref, credentialBroker, slotName });
  assertSlotContractUsable({ slot: slotRecord, database: databaseRef.database, plugin, slotName });
  const consistentPoint = slotRecord.restartLsn ?? slot.lsn;
  if (typeof consistentPoint !== 'string' || !LSN.test(consistentPoint)) {
    fail('CDC_BOUNDARY_MISMATCH', 'Slot reservation has no usable consistent point', { slotName });
  }
  // 3. Snapshot third: xmin instant S is after the reservation.
  const snapshot = await withExportedPostgresSnapshot({ ref, credentialBroker }, async exported => exported);
  // 4. Replica identity per table (CDC delete/update preconditions need it).
  const replicaIdentity = await withCdcClient({ databaseRef, credentialBroker }, async client => {
    const result = await client.query(
      `SELECT n.nspname AS "schema", c.relname AS "table",
              CASE c.relreplident WHEN 'f' THEN 'FULL' WHEN 'd' THEN 'DEFAULT' WHEN 'n' THEN 'NOTHING' WHEN 'i' THEN 'INDEX' ELSE 'UNKNOWN' END AS "identity"
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname || '.' || c.relname = ANY($1::text[])`,
      [normalizedTables.map(t => `${t.schema}.${t.table}`)]
    );
    return Object.freeze(result.rows.map(row => Object.freeze({
      schema: row.schema, table: row.table, identity: row.identity
    })));
  });
  const binding = buildSnapshotCdcBinding({
    sourceStateId,
    databaseSnapshotIdentity: databaseSnapshotIdentity ?? `${databaseRef.database}:${slotName}`,
    exportedSnapshotId: snapshot.exportedSnapshotId ?? null,
    snapshotLsn: consistentPoint.toUpperCase(),
    cdcStartLsn: consistentPoint.toUpperCase(),
    cdcSlot: slotName,
    cdcPublication: publicationName,
    catalogId
  });
  const boundaryId = sha256Canonical('spool-snapshot-cdc-boundary-v1', {
    sourceStateId,
    slotName,
    slotPlugin: plugin,
    consistentPoint: consistentPoint.toUpperCase(),
    exportedSnapshotId: snapshot.exportedSnapshotId ?? null,
    snapshotXmin: snapshot.xmin ?? null,
    snapshotXmax: snapshot.xmax ?? null,
    publicationTables: normalizedTables.map(t => `${t.schema}.${t.table}`).sort()
  });
  return Object.freeze({
    boundaryId,
    sourceStateId,
    database: databaseRef.database,
    slotName,
    slotPlugin: plugin,
    publicationName,
    publicationCreated: publication.created,
    slotExisted: slot.existed,
    consistentPoint: consistentPoint.toUpperCase(),
    exportedSnapshotId: snapshot.exportedSnapshotId ?? null,
    snapshotXmin: snapshot.xmin ?? null,
    snapshotXmax: snapshot.xmax ?? null,
    snapshotXip: snapshot.xip ?? [],
    snapshotWalLsn: snapshot.walLsn ?? null,
    replicaIdentity,
    binding,
    createdAt: new Date().toISOString()
  });
}

export function assertBoundaryCoversSnapshot(boundary) {
  if (!boundary || typeof boundary !== 'object') fail('CDC_BOUNDARY_MISMATCH', 'Snapshot/CDC boundary is required');
  const consistent = boundary.consistentPoint;
  const snapshotLsn = boundary.binding?.snapshotLsn ?? boundary.snapshotLsn ?? null;
  if (typeof consistent !== 'string' || !LSN.test(consistent)) fail('CDC_BOUNDARY_MISMATCH', 'Boundary has no slot consistent point');
  if (typeof snapshotLsn !== 'string' || !LSN.test(snapshotLsn)) fail('CDC_BOUNDARY_MISMATCH', 'Boundary has no snapshot LSN');
  if (comparePostgresLsn(snapshotLsn.toUpperCase(), consistent.toUpperCase()) !== 0) {
    fail('CDC_BOUNDARY_MISMATCH', 'Boundary snapshot LSN does not match the slot reservation point; the no-gap argument does not hold', {
      snapshotLsn, consistentPoint: consistent
    });
  }
  return true;
}

// Map streaming/subscription failures to operator-actionable CDC errors.
// A missing slot or unavailable WAL is never retried blindly: recovery
// requires a new snapshot boundary and an explicit operator decision.
export function classifyCdcStreamError(error, { slotName = null } = {}) {
  const code = error?.code ?? null;
  if (code === '42704') {
    fail('CDC_SLOT_LOST', 'Replication slot is gone; streaming cannot continue and must not silently resume at a later WAL position', {
      slotName, slotError: error?.message ?? String(error)
    });
  }
  if (code === '58P01' || /requested WAL segment/i.test(error?.message ?? '')) {
    fail('CDC_WAL_UNAVAILABLE', 'Required WAL is no longer retained; streaming cannot continue without a new snapshot boundary', {
      slotName, slotError: error?.message ?? String(error)
    });
  }
  throw error;
}

function freezeRow(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.freeze({ ...value });
}

export function normalizeMessage(lsn, message) {
  if (!message || typeof message !== 'object') return null;
  switch (message.tag) {
    case 'begin':
      return Object.freeze({ tag: 'begin', lsn, xid: message.xid ?? null });
    case 'commit':
      return Object.freeze({ tag: 'commit', lsn, commitLsn: message.commitLsn ?? null, commitEndLsn: message.commitEndLsn ?? null });
    case 'insert':
      return Object.freeze({ tag: 'insert', lsn, schema: message.relation?.schema ?? null, table: message.relation?.name ?? null, row: freezeRow(message.new) });
    case 'update':
      return Object.freeze({
        tag: 'update', lsn, schema: message.relation?.schema ?? null, table: message.relation?.name ?? null,
        key: freezeRow(message.key), old: freezeRow(message.old), row: freezeRow(message.new)
      });
    case 'delete':
      return Object.freeze({
        tag: 'delete', lsn, schema: message.relation?.schema ?? null, table: message.relation?.name ?? null,
        key: freezeRow(message.key), old: freezeRow(message.old)
      });
    case 'truncate':
      return Object.freeze({
        tag: 'truncate', lsn,
        tables: Object.freeze((message.relations ?? []).map(relation => `${relation?.schema ?? ''}.${relation?.name ?? ''}`))
      });
    default:
      return null;
  }
}

export async function streamPostgresChanges({
  ref, credentialBroker, slotName, publicationNames,
  startLsn = null, untilLsn = null, maxMessages = null, onChange = null
} = {}) {
  const databaseRef = requireDatabaseRef(ref);
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_POSTGRES_CDC_CONFIG', 'credentialBroker.withSecret() is required');
  const name = requireSlotName(slotName);
  if (!Array.isArray(publicationNames) || publicationNames.length === 0 || publicationNames.some(item => typeof item !== 'string' || !PUBLICATION_NAME.test(item))) {
    fail('INVALID_POSTGRES_CDC_CONFIG', 'publicationNames must be a non-empty array of valid publication names');
  }
  if (startLsn != null && (typeof startLsn !== 'string' || !LSN.test(startLsn))) fail('INVALID_POSTGRES_LSN', 'startLsn must look like 0/16B6C50');
  if (untilLsn != null && (typeof untilLsn !== 'string' || !LSN.test(untilLsn))) fail('INVALID_POSTGRES_LSN', 'untilLsn must look like 0/16B6C50');
  if (maxMessages != null && (!Number.isSafeInteger(maxMessages) || maxMessages < 1)) fail('INVALID_POSTGRES_CDC_CONFIG', 'maxMessages must be a positive safe integer');
  if (onChange != null && typeof onChange !== 'function') fail('INVALID_POSTGRES_CDC_CONFIG', 'onChange must be a function');

const parsed = parsePostgresEndpoint(databaseRef.endpoint);
  let lastAcknowledgedLsn = startLsn ?? null;
  let messageCount = 0;
  let finished = false;
  let failure = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  // Bounded changes array for testing/debugging - bounded to prevent unbounded memory
  const MAX_CHANGES = 10000;
  const changes = [];

  return credentialBroker.withSecret(databaseRef.secretRef, async secret => {
    if (typeof secret !== 'string' || !secret) fail('SECRET_NOT_FOUND', 'PostgreSQL password is required');
    const service = new LogicalReplicationService(
      {
        host: parsed.host,
        port: parsed.port,
        database: databaseRef.database,
        user: databaseRef.identity.user,
        password: secret,
        ssl: parsed.sslMode === 'disable' ? false : { rejectUnauthorized: parsed.sslMode === 'verify-full' },
        application_name: 'spool-cdc-capture'
      },
      { acknowledge: { auto: false, timeoutSeconds: 10 }, flowControl: { enabled: true } }
    );

    const finish = error => {
      if (finished) return;
      finished = true;
      failure = error ?? null;
      resolveDone();
    };

    service.on('error', error => finish(error));
    service.on('data', async (lsn, message) => {
      if (finished) return;
      try {
        const change = normalizeMessage(typeof lsn === 'string' ? lsn : String(lsn ?? ''), message);
        if (change) {
          if (onChange) await onChange(change);
          // Checkpoint monotonicity: commit LSN must not go backwards (per pgoutput commit-order guarantee)
          if (change.tag === 'commit' && lastAcknowledgedLsn && comparePostgresLsn(change.lsn, lastAcknowledgedLsn) < 0) {
            throw fail('CDC_LSN_MONOTONICITY_VIOLATION', `Commit LSN went backwards: ${lastAcknowledgedLsn} -> ${change.lsn}`);
          }
          if (change.tag === 'commit') {
            lastAcknowledgedLsn = change.lsn;
          }
          messageCount += 1;
          // Bounded changes array for testing - drop oldest if over limit
          if (changes.length >= MAX_CHANGES) changes.shift();
          changes.push(change);
        }
        await service.acknowledge(typeof lsn === 'string' ? lsn : String(lsn ?? ''));
        const stopByCount = maxMessages != null && messageCount >= maxMessages;
        const stopByLsn = untilLsn != null && change && comparePostgresLsn(change.lsn, untilLsn) >= 0;
        if (stopByCount || stopByLsn) {
          try { await service.stop(); } catch { /* stopping wins over stop errors */ }
          finish(null);
        }
      } catch (error) {
        try { await service.stop(); } catch { /* stopping wins over stop errors */ }
        finish(error);
      }
    });

    try {
      await service.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [...publicationNames] }), name, startLsn ?? undefined);
      await done;
    } catch (error) {
      finish(error);
      await done;
    } finally {
      try { await service.destroy(); } catch { /* shutdown must not mask results */ }
    }
    // Translate transport failures into operator-actionable CDC errors at the
    // single choke point: a lost slot or unavailable WAL fails closed here
    // for every consumer (capture helpers and the durable applier alike).
    if (failure) classifyCdcStreamError(failure, { slotName: name });
    return Object.freeze({
      slotName: name,
      changes: Object.freeze(changes),
      messageCount,
      lastLsn: lastAcknowledgedLsn,
      acknowledgedLsn: lastAcknowledgedLsn
    });
  });
}

export function createCdcCheckpointStore({ path } = {}) {
  if (typeof path !== 'string' || !path) fail('INVALID_CDC_CHECKPOINT_STORE', 'checkpoint path is required');
  const db = new Database(resolve(path));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_cdc_checkpoints (
        slot TEXT PRIMARY KEY NOT NULL,
        lsn TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  } catch (error) {
    try { db.close(); } catch { /* preserve the original error */ }
    throw error;
  }
  let closed = false;
  return Object.freeze({
    loadCheckpoint(slot) {
      if (closed) fail('CDC_CHECKPOINT_STORE_CLOSED', 'CDC checkpoint store is closed');
      const name = requireSlotName(slot);
      const row = db.prepare('SELECT lsn FROM spool_cdc_checkpoints WHERE slot = ?').get(name);
      return row?.lsn ?? null;
    },
    saveCheckpoint(slot, lsn) {
      if (closed) fail('CDC_CHECKPOINT_STORE_CLOSED', 'CDC checkpoint store is closed');
      const name = requireSlotName(slot);
      if (typeof lsn !== 'string' || !LSN.test(lsn)) fail('INVALID_POSTGRES_LSN', 'checkpoint LSN must look like 0/16B6C50');
      db.prepare(`
        INSERT INTO spool_cdc_checkpoints (slot, lsn, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET lsn = excluded.lsn, updated_at = excluded.updated_at
      `).run(name, lsn, new Date().toISOString());
    },
    close() { if (!closed) { db.close(); closed = true; } }
  });
}
