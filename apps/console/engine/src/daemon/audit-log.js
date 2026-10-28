import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export class AuditLog {
  constructor({ path = ':memory:' } = {}) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spool_audit_events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail_json TEXT,
        ip TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON spool_audit_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_principal ON spool_audit_events(principal);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON spool_audit_events(resource);
    `);

    this.q = {
      insert: this.db.prepare(`
        INSERT INTO spool_audit_events (event_id, timestamp, principal, action, resource, outcome, detail_json, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      query: this.db.prepare(`
        SELECT * FROM spool_audit_events
        WHERE (? IS NULL OR principal = ?)
          AND (? IS NULL OR action = ?)
          AND (? IS NULL OR resource = ?)
          AND (? IS NULL OR timestamp >= ?)
          AND (? IS NULL OR timestamp <= ?)
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      prune: this.db.prepare(`
        DELETE FROM spool_audit_events WHERE timestamp < ?
      `)
    };
  }

  record({ principal = 'anonymous', action, resource, outcome, detail = {}, ip = null }) {
    const eventId = `audit_${randomUUID()}`;
    const timestamp = new Date().toISOString();
    this.q.insert.run(
      eventId,
      timestamp,
      principal,
      action,
      resource,
      outcome,
      JSON.stringify(detail),
      ip
    );
    return { eventId, timestamp };
  }

  query({ principal = null, action = null, resource = null, from = null, to = null, limit = 100 } = {}) {
    const rows = this.q.query.all(
      principal, principal,
      action, action,
      resource, resource,
      from, from,
      to, to,
      limit
    );
    return rows.map(r => ({
      ...r,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null
    }));
  }

  prune(olderThanIso) {
    const info = this.q.prune.run(olderThanIso);
    return info.changes;
  }

  close() {
    this.db.close();
  }
}
