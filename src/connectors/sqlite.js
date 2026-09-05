import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from '../core/errors.js';
import { sha256Json } from '../platform/canonical-json.js';
import { CONNECTOR_CAPABILITY_PROFILE_VERSION } from './contract.js';
import { quoteSqliteIdentifier, sqliteTypeForTarget, spoolTypeForSqlite, validateNewSqliteIdentifier } from './sqlite-identifiers.js';

const BATCH_LEDGER_TABLE = '__spool_batch_ledger_v1';
const BATCH_LEDGER_TABLE_SQL = quoteSqliteIdentifier(BATCH_LEDGER_TABLE);
const BATCH_LEDGER_COLUMNS = Object.freeze([
  ['batch_identity', 'TEXT', 1, 1],
  ['resource', 'TEXT', 1, 0],
  ['plan_id', 'TEXT', 1, 0],
  ['job_id', 'TEXT', 1, 0],
  ['committed_rows', 'INTEGER', 1, 0],
  ['target_rows', 'INTEGER', 1, 0],
  ['commit_id', 'TEXT', 1, 0],
  ['committed_at', 'TEXT', 1, 0]
]);

const CAPABILITIES = Object.freeze({
  source: true,
  target: true,
  discover: true,
  streaming: true,
  transactions: true,
  bulkWrite: false,
  upsert: true,
  ddl: true,
  rollback: true,
  checksum: true,
  pagination: true,
  rateLimitAware: false
});

const CAPABILITY_PROFILE = Object.freeze({
  version: CONNECTOR_CAPABILITY_PROFILE_VERSION,
  source: Object.freeze({
    snapshot: 'none',
    ordering: 'none',
    resume: 'unsupported',
    cursorKind: null
  }),
  target: Object.freeze({
    atomicity: 'transaction',
    commitEvidence: 'native_commit_id',
    reconcileAfterCrash: true,
    idempotency: 'batch_key'
  }),
  verification: Object.freeze({
    logicalCount: true,
    schema: true,
    keyCoverage: true,
    sampleHash: true,
    logicalDatasetHash: false,
    physicalArtifactHash: false,
    maxStrength: 'STANDARD'
  })
});

function asPlain(row) { return row ? { ...row } : row; }

function ensureBatchSize(value) {
  const batchSize = value ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) fail('INVALID_BATCH_SIZE', 'batchSize must be between 1 and 10000');
  return batchSize;
}

function ensureOffset(cursor) {
  const offset = cursor?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_SOURCE_CURSOR', 'SQLite cursor.offset must be a non-negative safe integer');
  return offset;
}

function ensureRows(batches) {
  return (async () => {
    const rows = [];
    for await (const batch of batches) {
      if (!batch || !Array.isArray(batch.rows)) fail('INVALID_ROW_BATCH', 'SQLite write requires row batches');
      rows.push(...batch.rows);
    }
    return rows;
  })();
}

function batchContext(ctx = {}) {
  if (ctx.batchIdentity == null) return null;
  if (typeof ctx.batchIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ctx.batchIdentity)) {
    fail('INVALID_BATCH_IDENTITY', 'SQLite batchIdentity must be a sha256 identity');
  }
  if (typeof ctx.planId !== 'string' || !ctx.planId) fail('INVALID_BATCH_CONTEXT', 'SQLite ledger write requires planId');
  if (typeof ctx.jobId !== 'string' || !ctx.jobId) fail('INVALID_BATCH_CONTEXT', 'SQLite ledger write requires jobId');
  return { batchIdentity: ctx.batchIdentity, planId: ctx.planId, jobId: ctx.jobId };
}

function ackFromLedger(row) {
  return {
    committedRows: Number(row.committed_rows),
    commitId: row.commit_id,
    checkpointToken: row.commit_id,
    targetRows: Number(row.target_rows)
  };
}

function ledgerMatches(row, context, resource) {
  return row.resource === resource && row.plan_id === context.planId && row.job_id === context.jobId;
}

export class SQLiteConnector {
  constructor(config = {}) {
    this.config = structuredClone(config);
    this.db = null;
    this.connection = null;
  }

  manifest() {
    return {
      name: 'sqlite',
      version: '1.1.0',
      capabilities: { ...CAPABILITIES },
      capabilityProfile: structuredClone(CAPABILITY_PROFILE)
    };
  }

  async validateConfig(config = this.config) {
    if (!config || typeof config.database !== 'string' || !config.database.trim()) {
      fail('INVALID_SQLITE_CONFIG', 'SQLite connector requires database');
    }
    const connection = { database: path.resolve(config.database), readonly: Boolean(config.readonly) };
    if (this.db) this.db.close();
    this.db = new DatabaseSync(connection.database, { readOnly: connection.readonly });
    this.connection = connection;
    return structuredClone(connection);
  }

  async testConnection(ctx = {}) {
    this.#ensureDb(ctx.connection);
    const row = this.db.prepare('SELECT sqlite_version() AS version').get();
    return { ok: true, version: row.version, database: this.connection.database };
  }

  #ensureDb(connection) {
    if (this.db) return this.db;
    const config = connection ?? this.connection ?? this.config;
    if (!config?.database) fail('SQLITE_NOT_OPEN', 'SQLite connection is not initialized');
    this.db = new DatabaseSync(config.database, { readOnly: Boolean(config.readonly) });
    this.connection = { database: path.resolve(config.database), readonly: Boolean(config.readonly) };
    return this.db;
  }

  #tableExists(resource) {
    const row = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(resource);
    return Boolean(row);
  }

  #batchLedgerExists() {
    return this.#tableExists(BATCH_LEDGER_TABLE);
  }

  #ensureBatchLedger() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${BATCH_LEDGER_TABLE_SQL} (
      batch_identity TEXT PRIMARY KEY,
      resource TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      committed_rows INTEGER NOT NULL CHECK (committed_rows >= 0),
      target_rows INTEGER NOT NULL CHECK (target_rows >= 0),
      commit_id TEXT NOT NULL UNIQUE,
      committed_at TEXT NOT NULL
    )`);
    const columns = this.db.prepare(`PRAGMA table_info(${BATCH_LEDGER_TABLE_SQL})`).all();
    const matches = columns.length === BATCH_LEDGER_COLUMNS.length && columns.every((column, index) => {
      const expected = BATCH_LEDGER_COLUMNS[index];
      return column.name === expected[0]
        && String(column.type).toUpperCase() === expected[1]
        && Number(column.notnull) === expected[2]
        && Number(column.pk) === expected[3];
    });
    if (!matches) fail('SQLITE_LEDGER_CONFLICT', `SQLite internal ledger ${BATCH_LEDGER_TABLE} has an incompatible schema`);
  }

  #loadBatchLedger(batchIdentity) {
    if (!this.#batchLedgerExists()) return null;
    return asPlain(this.db.prepare(`SELECT batch_identity, resource, plan_id, job_id, committed_rows, target_rows, commit_id, committed_at FROM ${BATCH_LEDGER_TABLE_SQL} WHERE batch_identity=?`).get(batchIdentity));
  }

  #discoverTable(resource) {
    if (typeof resource !== 'string' || !resource || resource.includes('\0')) fail('INVALID_SQLITE_RESOURCE', 'SQLite resource must be a table name');
    if (!this.#tableExists(resource)) fail('RESOURCE_NOT_FOUND', `SQLite table ${resource} does not exist`);
    const table = quoteSqliteIdentifier(resource);
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => ({
      name: row.name,
      declaredType: row.type || '',
      type: spoolTypeForSqlite(row.type),
      nullable: row.notnull === 0 && row.pk === 0,
      primaryKeyOrder: Number(row.pk) || 0
    }));
    const primaryKey = columns.filter(column => column.primaryKeyOrder > 0).sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder).map(column => column.name);
    const rowCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return { resource, columns, primaryKey, rowCount };
  }

  #orderedRows(discovery, limit = null) {
    const table = quoteSqliteIdentifier(discovery.resource);
    const orderFields = discovery.primaryKey.length ? discovery.primaryKey : discovery.columns.map(column => column.name);
    const order = orderFields.length ? ` ORDER BY ${orderFields.map(quoteSqliteIdentifier).join(', ')}` : '';
    const suffix = limit == null ? '' : ' LIMIT ?';
    const statement = this.db.prepare(`SELECT * FROM ${table}${order}${suffix}`);
    return (limit == null ? statement.all() : statement.all(limit)).map(asPlain);
  }

  async #fullChecksum(discovery) {
    return sha256Json({
      resource: discovery.resource,
      columns: discovery.columns,
      primaryKey: discovery.primaryKey,
      rows: this.#orderedRows(discovery)
    });
  }

  async discover(ctx = {}, request = {}) {
    this.#ensureDb(ctx.connection);
    const result = this.#discoverTable(request.resource);
    const checksum = await this.#fullChecksum(result);
    return {
      ...result,
      schema: result.columns.map(column => ({ name: column.name, type: column.type, nullable: column.nullable })),
      checksum,
      identity: await sha256Json({ connector: 'sqlite', resource: result.resource, columns: result.columns, primaryKey: result.primaryKey, checksum })
    };
  }

  async *read(ctx = {}, request = {}) {
    this.#ensureDb(ctx.connection);
    const discovery = this.#discoverTable(request.resource);
    const batchSize = ensureBatchSize(request.batchSize);
    const table = quoteSqliteIdentifier(request.resource);
    const singlePk = discovery.primaryKey.length === 1 ? discovery.columns.find(column => column.name === discovery.primaryKey[0]) : null;
    const integerPk = singlePk && singlePk.type === 'integer' ? singlePk.name : null;
    let offset = ensureOffset(request.cursor);

    if (integerPk) {
      if (request.cursor?.primaryKey && request.cursor.primaryKey !== integerPk) {
        fail('SOURCE_CURSOR_MISMATCH', `SQLite cursor primary key ${request.cursor.primaryKey} does not match ${integerPk}`);
      }
      const pk = quoteSqliteIdentifier(integerPk);
      let last = request.cursor?.value ?? Number.MIN_SAFE_INTEGER;
      if (!Number.isSafeInteger(last)) fail('INVALID_SOURCE_CURSOR', 'SQLite integer primary-key cursor value must be a safe integer');
      while (true) {
        const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ?`).all(last, batchSize).map(asPlain);
        if (!rows.length) return;
        offset += rows.length;
        last = rows.at(-1)[integerPk];
        yield { rows, cursor: { primaryKey: integerPk, value: last, offset }, bytesRead: Buffer.byteLength(JSON.stringify(rows)) };
        if (rows.length < batchSize) return;
      }
    }

    while (true) {
      const rows = this.db.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`).all(batchSize, offset).map(asPlain);
      if (!rows.length) return;
      offset += rows.length;
      yield { rows, cursor: { offset }, bytesRead: Buffer.byteLength(JSON.stringify(rows)) };
      if (rows.length < batchSize) return;
    }
  }

  async planWrite(ctx = {}, request = {}) {
    this.#ensureDb(ctx.connection);
    const mode = request.mode ?? 'insert';
    if (!['create_insert', 'insert', 'upsert'].includes(mode)) fail('UNSUPPORTED_SQLITE_WRITE_MODE', `Unsupported SQLite write mode ${mode}`);
    const exists = this.#tableExists(request.resource);
    if (mode === 'create_insert' && !exists) {
      validateNewSqliteIdentifier(request.resource, 'table');
      if (!Array.isArray(request.targetSchema) || !request.targetSchema.length) fail('INVALID_TARGET_SCHEMA', 'create_insert requires targetSchema');
    } else if (!exists) {
      fail('RESOURCE_NOT_FOUND', `SQLite table ${request.resource} does not exist`);
    }
    if (mode === 'upsert' && (!Array.isArray(request.keyFields) || !request.keyFields.length)) fail('INVALID_UPSERT_KEY', 'SQLite upsert requires keyFields');
    return {
      strategy: mode,
      transactional: true,
      requiredCapabilities: mode === 'upsert' ? ['target', 'transactions', 'upsert'] : ['target', 'transactions'],
      resource: request.resource
    };
  }

  #createTable(resource, targetSchema) {
    const table = quoteSqliteIdentifier(validateNewSqliteIdentifier(resource, 'table'));
    const columns = targetSchema.map(field => {
      validateNewSqliteIdentifier(field.name, 'column');
      return `${quoteSqliteIdentifier(field.name)} ${sqliteTypeForTarget(field.type)}${field.nullable === false ? ' NOT NULL' : ''}`;
    });
    this.db.exec(`CREATE TABLE ${table} (${columns.join(', ')})`);
  }

  #validateTargetColumns(resource, targetSchema) {
    const discovered = this.#discoverTable(resource);
    const allowed = new Set(discovered.columns.map(column => column.name));
    const fields = Array.isArray(targetSchema) && targetSchema.length ? targetSchema.map(field => field.name) : [...allowed];
    for (const field of fields) if (!allowed.has(field)) fail('TARGET_COLUMN_NOT_FOUND', `SQLite target column ${field} does not exist in ${resource}`);
    return fields;
  }

  async write(ctx = {}, request = {}, batches = []) {
    this.#ensureDb(ctx.connection);
    if (this.connection.readonly) fail('SQLITE_READONLY', 'SQLite target is readonly');
    const rows = await ensureRows(batches);
    const mode = request.mode ?? 'insert';
    await this.planWrite(ctx, request);
    const ledgerContext = batchContext(ctx);
    if (ledgerContext) this.#ensureBatchLedger();

    let ack = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (ledgerContext) {
        const existing = this.#loadBatchLedger(ledgerContext.batchIdentity);
        if (existing) {
          if (!ledgerMatches(existing, ledgerContext, request.resource)) {
            fail('SQLITE_BATCH_IDENTITY_CONFLICT', `SQLite batch identity ${ledgerContext.batchIdentity} is already bound to different target metadata`);
          }
          ack = ackFromLedger(existing);
          this.db.exec('COMMIT');
          return ack;
        }
      }

      if (mode === 'create_insert' && !this.#tableExists(request.resource)) this.#createTable(request.resource, request.targetSchema);
      const fields = this.#validateTargetColumns(request.resource, request.targetSchema);
      const table = quoteSqliteIdentifier(request.resource);
      const columnSql = fields.map(quoteSqliteIdentifier).join(', ');
      const placeholders = fields.map(() => '?').join(', ');
      let sql = `INSERT INTO ${table} (${columnSql}) VALUES (${placeholders})`;
      if (mode === 'upsert') {
        const keys = request.keyFields;
        const allowed = new Set(fields);
        for (const key of keys) if (!allowed.has(key)) fail('INVALID_UPSERT_KEY', `SQLite upsert key ${key} is not a target field`);
        const updates = fields.filter(field => !keys.includes(field));
        const conflict = keys.map(quoteSqliteIdentifier).join(', ');
        sql += updates.length
          ? ` ON CONFLICT (${conflict}) DO UPDATE SET ${updates.map(field => `${quoteSqliteIdentifier(field)}=excluded.${quoteSqliteIdentifier(field)}`).join(', ')}`
          : ` ON CONFLICT (${conflict}) DO NOTHING`;
      }
      const statement = this.db.prepare(sql);
      for (const row of rows) statement.run(...fields.map(field => row?.[field] ?? null));

      const targetRows = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
      if (ledgerContext) {
        const commitId = `sqlite-batch:${ledgerContext.batchIdentity}`;
        this.db.prepare(`INSERT INTO ${BATCH_LEDGER_TABLE_SQL} (
          batch_identity, resource, plan_id, job_id, committed_rows, target_rows, commit_id, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ledgerContext.batchIdentity,
          request.resource,
          ledgerContext.planId,
          ledgerContext.jobId,
          rows.length,
          targetRows,
          commitId,
          new Date().toISOString()
        );
        ack = { committedRows: rows.length, commitId, checkpointToken: commitId, targetRows };
      } else {
        ack = {
          committedRows: rows.length,
          checkpointToken: `sqlite:${request.resource}:${targetRows}`,
          targetRows
        };
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }

    return ack;
  }

  async reconcileTargetCommit(ctx = {}, request = {}) {
    this.#ensureDb(ctx.connection);
    const ledgerContext = batchContext(ctx);
    if (!ledgerContext) fail('INVALID_RECONCILIATION_REQUEST', 'SQLite reconciliation requires batchIdentity context');
    if (typeof request.resource !== 'string' || !request.resource) fail('INVALID_RECONCILIATION_REQUEST', 'SQLite reconciliation requires target resource');
    const pendingIdentity = request.pendingBatch?.batchIdentity;
    if (typeof pendingIdentity !== 'string' || pendingIdentity !== ledgerContext.batchIdentity) {
      fail('INVALID_RECONCILIATION_REQUEST', 'SQLite reconciliation pending batch identity does not match execution context');
    }
    if (!this.#batchLedgerExists()) return { status: 'UNKNOWN' };

    const row = this.#loadBatchLedger(ledgerContext.batchIdentity);
    if (!row) return { status: 'NOT_COMMITTED' };
    if (!ledgerMatches(row, ledgerContext, request.resource)) return { status: 'UNKNOWN' };
    if (!this.#tableExists(request.resource)) return { status: 'UNKNOWN' };

    const currentRows = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(request.resource)}`).get().count);
    if (!Number.isSafeInteger(currentRows) || currentRows < Number(row.target_rows)) return { status: 'UNKNOWN' };
    return { status: 'COMMITTED', ack: ackFromLedger(row) };
  }

  async verify(ctx = {}, request = {}) {
    this.#ensureDb(ctx.connection);
    const discovery = this.#discoverTable(request.resource);
    const table = quoteSqliteIdentifier(request.resource);
    const sample = this.#orderedRows(discovery, 100);
    const sampleHash = await sha256Json(sample);
    const checksum = await this.#fullChecksum(discovery);
    const countOk = request.expectedRows == null || discovery.rowCount === request.expectedRows;
    let primaryKeyCoverage = null;
    if (discovery.primaryKey.length === 1) {
      const key = quoteSqliteIdentifier(discovery.primaryKey[0]);
      const row = this.db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT ${key}) AS distinctCount FROM ${table} WHERE ${key} IS NOT NULL`).get();
      primaryKeyCoverage = { total: Number(row.total), distinct: Number(row.distinctCount), ok: Number(row.total) === Number(row.distinctCount) };
    }
    return {
      ok: countOk && (primaryKeyCoverage?.ok ?? true),
      targetRows: discovery.rowCount,
      primaryKey: discovery.primaryKey,
      primaryKeyCoverage,
      schema: discovery.columns,
      checksum,
      sampleHash,
      checks: [
        { name: 'target_count', ok: countOk, expected: request.expectedRows ?? null, actual: discovery.rowCount },
        { name: 'full_checksum', ok: true, value: checksum, scope: discovery.rowCount },
        { name: 'sample_hash', ok: true, value: sampleHash, scope: Math.min(100, discovery.rowCount) }
      ]
    };
  }

  async rollback() {
    if (!this.db) return { ok: true, rolledBack: false };
    try { this.db.exec('ROLLBACK'); return { ok: true, rolledBack: true }; }
    catch { return { ok: true, rolledBack: false }; }
  }

  async close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}
