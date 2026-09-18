import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { fail } from '../../core/errors.js';
import { parsePostgresEndpoint, postgresConnectionConfig } from './connection.js';
import { validateSecretRef } from '../../platform/secrets.js';

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

export async function createPostgresReplicationSlot({ ref, credentialBroker, slotName, plugin = 'pgoutput' } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  const name = requireSlotName(slotName);
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    try {
      const result = await client.query('SELECT * FROM pg_catalog.pg_create_logical_replication_slot($1, $2)', [name, plugin]);
      return Object.freeze({ slotName: name, plugin, existed: false, lsn: result.rows[0]?.consistent_point ?? null });
    } catch (error) {
      if (error?.code === '42710') {
        const existing = await client.query('SELECT slot_name AS "slotName", plugin, active AS "active" FROM pg_catalog.pg_replication_slots WHERE slot_name = $1', [name]);
        return Object.freeze({ slotName: name, plugin: existing.rows[0]?.plugin ?? plugin, existed: true, active: existing.rows[0]?.active === true });
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

export async function ensurePostgresPublication({ ref, credentialBroker, publicationName, tables } = {}) {
  const databaseRef = requireDatabaseRef(ref);
  if (typeof publicationName !== 'string' || !PUBLICATION_NAME.test(publicationName)) {
    fail('INVALID_POSTGRES_CDC_CONFIG', 'publicationName must be a valid PostgreSQL identifier');
  }
  if (!Array.isArray(tables) || tables.length === 0) fail('INVALID_POSTGRES_CDC_CONFIG', 'publication tables must be a non-empty array');
  const qualified = tables.map((table, index) => {
    if (!table || typeof table !== 'object') fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} must be an object`);
    if (typeof table.schema !== 'string' || !TABLE_NAME.test(table.schema)) fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} schema is invalid`);
    if (typeof table.table !== 'string' || !TABLE_NAME.test(table.table)) fail('INVALID_POSTGRES_CDC_CONFIG', `publication table ${index} table is invalid`);
    return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
  });
  return withCdcClient({ databaseRef, credentialBroker }, async client => {
    try {
      await client.query(`CREATE PUBLICATION ${quoteIdentifier(publicationName)} FOR TABLE ${qualified.join(', ')}`);
      return Object.freeze({ publicationName, created: true });
    } catch (error) {
      if (error?.code === '42710') return Object.freeze({ publicationName, created: false });
      throw error;
    }
  });
}

function freezeRow(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.freeze({ ...value });
}

function normalizeMessage(lsn, message) {
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
  const changes = [];
  let finished = false;
  let failure = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

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
          changes.push(change);
          if (onChange) await onChange(change);
        }
        await service.acknowledge(typeof lsn === 'string' ? lsn : String(lsn ?? ''));
        const stopByCount = maxMessages != null && changes.length >= maxMessages;
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
    if (failure) throw failure;
    return Object.freeze({ slotName: name, changes: Object.freeze(changes), lastLsn: changes.length ? changes[changes.length - 1].lsn : null });
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
