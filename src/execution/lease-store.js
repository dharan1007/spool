import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fail } from '../core/errors.js';

function requireText(name, value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_LEASE_INPUT', `${name} must be a non-empty string`);
  return value;
}

function requireTime(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_LEASE_INPUT', `${name} must be a non-negative safe integer`);
  return value;
}

function frozen(row) {
  return Object.freeze({
    resource: row.resource,
    owner: row.owner,
    expiresAtMs: Number(row.expires_at_ms),
    fencingToken: Number(row.fencing_token)
  });
}

export class LeaseStore {
  constructor({ path } = {}) {
    requireText('path', path);
    this.path = resolve(path);
    this.db = new DatabaseSync(this.path);
    this.closed = false;
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spool_execution_leases (
        resource TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1)
      ) STRICT;
    `);
  }

  #open() {
    if (this.closed) fail('LEASE_STORE_CLOSED', 'Lease store is closed');
  }

  acquire({ resource, owner, ttlMs, nowMs = Date.now() } = {}) {
    this.#open();
    requireText('resource', resource);
    requireText('owner', owner);
    requireTime('nowMs', nowMs);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('INVALID_LEASE_INPUT', 'ttlMs must be a positive safe integer');
    const expiresAtMs = nowMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) fail('INVALID_LEASE_INPUT', 'lease expiry exceeds safe integer range');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db.prepare('SELECT resource, owner, expires_at_ms, fencing_token FROM spool_execution_leases WHERE resource = ?').get(resource);
      if (!existing) {
        this.db.prepare('INSERT INTO spool_execution_leases (resource, owner, expires_at_ms, fencing_token) VALUES (?, ?, ?, 1)').run(resource, owner, expiresAtMs);
      } else if (Number(existing.expires_at_ms) > nowMs && existing.owner !== owner) {
        fail('LEASE_HELD', `Execution lease is held by ${existing.owner}`, { resource, owner: existing.owner, expiresAtMs: Number(existing.expires_at_ms) });
      } else if (Number(existing.expires_at_ms) > nowMs && existing.owner === owner) {
        this.db.prepare('UPDATE spool_execution_leases SET expires_at_ms = ? WHERE resource = ? AND owner = ? AND fencing_token = ?')
          .run(expiresAtMs, resource, owner, existing.fencing_token);
      } else {
        this.db.prepare('UPDATE spool_execution_leases SET owner = ?, expires_at_ms = ?, fencing_token = fencing_token + 1 WHERE resource = ?')
          .run(owner, expiresAtMs, resource);
      }
      const row = this.db.prepare('SELECT resource, owner, expires_at_ms, fencing_token FROM spool_execution_leases WHERE resource = ?').get(resource);
      this.db.exec('COMMIT;');
      return frozen(row);
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
      throw error;
    }
  }

  assertFence({ resource, fencingToken, nowMs = Date.now() } = {}) {
    this.#open();
    requireText('resource', resource);
    requireTime('nowMs', nowMs);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_LEASE_INPUT', 'fencingToken must be a positive safe integer');
    const row = this.db.prepare('SELECT owner, expires_at_ms, fencing_token FROM spool_execution_leases WHERE resource = ?').get(resource);
    if (!row) fail('STALE_FENCE', 'No active lease exists for the resource', { resource, fencingToken });
    if (Number(row.fencing_token) !== fencingToken) {
      fail('STALE_FENCE', 'Fencing token is stale', { resource, expected: Number(row.fencing_token), actual: fencingToken });
    }
    if (Number(row.expires_at_ms) <= nowMs) fail('LEASE_EXPIRED', 'Execution lease has expired', { resource, fencingToken });
    return true;
  }

  release({ resource, owner, fencingToken } = {}) {
    this.#open();
    requireText('resource', resource);
    requireText('owner', owner);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail('INVALID_LEASE_INPUT', 'fencingToken must be a positive safe integer');
    const result = this.db.prepare('DELETE FROM spool_execution_leases WHERE resource = ? AND owner = ? AND fencing_token = ?')
      .run(resource, owner, fencingToken);
    return Number(result.changes) === 1;
  }

  current(resource) {
    this.#open();
    requireText('resource', resource);
    const row = this.db.prepare('SELECT resource, owner, expires_at_ms, fencing_token FROM spool_execution_leases WHERE resource = ?').get(resource);
    return row ? frozen(row) : null;
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
