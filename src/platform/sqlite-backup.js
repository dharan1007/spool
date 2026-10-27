// SQLite backup and restore verification.
//
// The enterprise registry, per-migration checkpoints and SQLite targets are all
// WAL-mode SQLite databases. Copying the file with the filesystem while a writer
// is active can capture a torn state, so backups go through SQLite's online
// backup API and every backup is integrity-checked and content-compared before it
// is accepted as restorable.
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { fail } from '../core/errors.js';

const INTERNAL_PREFIXES = ['sqlite_'];

function tablesOf(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => row.name)
    .filter(name => !INTERNAL_PREFIXES.some(prefix => name.startsWith(prefix)));
}

function tableDigest(db, table) {
  const hash = createHash('sha256');
  const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).iterate();
  let count = 0;
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
    count += 1;
  }
  return { table, rows: count, sha256: hash.digest('hex') };
}

export function describeDatabase(path) {
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') fail('BACKUP_INTEGRITY_FAILED', `Integrity check failed for ${path}`, { integrity });
    const tables = tablesOf(db).map(table => tableDigest(db, table));
    const schema = createHash('sha256')
      .update(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
        .map(row => `${row.type}:${row.name}:${row.sql ?? ''}`).join('\n'))
      .digest('hex');
    return Object.freeze({
      path,
      bytes: statSync(path).size,
      journalMode: db.pragma('journal_mode', { simple: true }),
      integrity,
      schemaSha256: schema,
      tables: Object.freeze(tables),
      rows: tables.reduce((total, table) => total + table.rows, 0)
    });
  } catch (error) {
    if (error?.code === 'BACKUP_INTEGRITY_FAILED') throw error;
    fail('BACKUP_UNREADABLE', `Database cannot be read for backup verification: ${error?.message ?? String(error)}`, { path });
  } finally {
    if (db) db.close();
  }
}

// Online backup of a database that may have a live writer. The source handle is
// opened read-write so SQLite can run its backup step even while a WAL file
// exists; the destination is a fresh, complete database.
export async function backupDatabase({ source, destination }) {
  if (typeof source !== 'string' || typeof destination !== 'string') {
    fail('BACKUP_INVALID', 'source and destination paths are required');
  }
  const db = new Database(source, { timeout: 5000 });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  return describeDatabase(destination);
}

// A restore is only accepted when the restored bytes are structurally identical
// to the source: same schema, same row counts, same per-table content digests.
export function verifyRestore({ source, restored }) {
  const before = describeDatabase(source);
  const after = describeDatabase(restored);
  const problems = [];
  if (before.schemaSha256 !== after.schemaSha256) problems.push('schema differs');
  if (before.rows !== after.rows) problems.push(`row count differs (${before.rows} != ${after.rows})`);
  const expected = new Map(before.tables.map(table => [table.table, table]));
  for (const table of after.tables) {
    const match = expected.get(table.table);
    if (!match) problems.push(`unexpected table ${table.table}`);
    else if (match.sha256 !== table.sha256 || match.rows !== table.rows) problems.push(`content differs in ${table.table}`);
  }
  for (const table of before.tables) if (!after.tables.some(candidate => candidate.table === table.table)) problems.push(`missing table ${table.table}`);
  return Object.freeze({ ok: problems.length === 0, problems, source: before, restored: after });
}
