import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export class SnowflakeWireServer {
  constructor() {
    this.tables = new Map(); // tableKey -> array of row objects
    this.schemas = new Map(); // tableKey -> array of { COLUMN_NAME, DATA_TYPE, IS_NULLABLE }
    this.primaryKeys = new Map(); // tableKey -> array of pk names
    this.ledger = new Map(); // batchIdentity -> ledger row object
    this.leases = new Map(); // resource -> { FENCING_TOKEN, EXPIRES_AT_MS }
    this.server = null;
    this.port = null;
    this.requests = [];
  }

  seedTable(database, schema, table, columns, primaryKey = [columns[0].name]) {
    const key = `${database.toUpperCase()}.${schema.toUpperCase()}.${table.toUpperCase()}`;
    this.schemas.set(key, columns.map(c => ({
      COLUMN_NAME: c.name.toUpperCase(),
      DATA_TYPE: (c.type || 'VARCHAR').toUpperCase(),
      IS_NULLABLE: c.nullable ? 'YES' : 'NO'
    })));
    this.primaryKeys.set(key, primaryKey.map(k => k.toUpperCase()));
    this.tables.set(key, []);
  }

  setLease(resource, token, ttlMs = 60000) {
    this.leases.set(resource, {
      FENCING_TOKEN: Number(token),
      EXPIRES_AT_MS: Date.now() + ttlMs
    });
  }

  async start(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'POST' && url.pathname === '/api/v2/statements') {
          let bodyText = '';
          req.on('data', chunk => { bodyText += chunk; });
          req.on('end', () => {
            try {
              const body = JSON.parse(bodyText);
              this.requests.push({ method: 'POST', path: url.pathname, headers: req.headers, body });

              // Validate Authorization
              const auth = req.headers['authorization'];
              if (!auth || !auth.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ code: '390114', message: 'Authentication token missing or invalid.' }));
              }

              const sql = (body.statement || '').trim();
              const upperSql = sql.toUpperCase();
              const bindings = body.bindings || {};
              const bindValues = Object.keys(bindings).sort((a, b) => Number(a) - Number(b)).map(k => bindings[k].value);

              // 1. Information Schema columns
              if (upperSql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                // Return schema for matched table
                const [targetSchema, targetTable] = bindValues;
                let foundSchema = null;
                for (const [k, cols] of this.schemas.entries()) {
                  if (k.endsWith(`.${targetSchema.toUpperCase()}.${targetTable.toUpperCase()}`)) {
                    foundSchema = cols;
                    break;
                  }
                }
                const rows = (foundSchema || []).map(c => [c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE]);
                return this.#sendSuccess(res, [
                  { name: 'COLUMN_NAME', type: 'text' },
                  { name: 'DATA_TYPE', type: 'text' },
                  { name: 'IS_NULLABLE', type: 'text' }
                ], rows);
              }

              // 2. Primary Keys
              if (upperSql.startsWith('SHOW PRIMARY KEYS')) {
                let pks = ['ID'];
                for (const [k, keyList] of this.primaryKeys.entries()) {
                  if (upperSql.includes(k.split('.').pop())) {
                    pks = keyList;
                    break;
                  }
                }
                const rows = pks.map(k => [k]);
                return this.#sendSuccess(res, [{ name: 'COLUMN_NAME', type: 'text' }], rows);
              }

              // 3. Leases Query
              if (upperSql.includes('FROM "ANALYTICS"."SPOOL_INTERNAL"."SPOOL_EXECUTION_LEASES"') || upperSql.includes('SPOOL_EXECUTION_LEASES')) {
                const resource = bindValues[0];
                const lease = this.leases.get(resource);
                if (lease) {
                  return this.#sendSuccess(res, [
                    { name: 'FENCING_TOKEN', type: 'fixed' },
                    { name: 'EXPIRES_AT_MS', type: 'fixed' }
                  ], [[String(lease.FENCING_TOKEN), String(lease.EXPIRES_AT_MS)]]);
                }
                return this.#sendSuccess(res, [
                  { name: 'FENCING_TOKEN', type: 'fixed' },
                  { name: 'EXPIRES_AT_MS', type: 'fixed' }
                ], []);
              }

              // 4. Ledger Query
              if (upperSql.includes('FROM "ANALYTICS"."SPOOL_INTERNAL"."SPOOL_BATCH_LEDGER"') || upperSql.includes('SPOOL_BATCH_LEDGER')) {
                if (upperSql.startsWith('SELECT')) {
                  const batchIdentity = bindValues[0];
                  const entry = this.ledger.get(batchIdentity);
                  if (entry) {
                    return this.#sendSuccess(res, [
                      { name: 'BATCH_IDENTITY', type: 'text' },
                      { name: 'MIGRATION_ID', type: 'text' },
                      { name: 'ROW_COUNT', type: 'fixed' },
                      { name: 'PAYLOAD_HASH', type: 'text' },
                      { name: 'COMMITTED_AT', type: 'timestamp_ntz' }
                    ], [[entry.batch_identity, entry.migration_id, String(entry.row_count), entry.payload_hash, entry.committed_at]]);
                  }
                  return this.#sendSuccess(res, [
                    { name: 'BATCH_IDENTITY', type: 'text' },
                    { name: 'MIGRATION_ID', type: 'text' },
                    { name: 'ROW_COUNT', type: 'fixed' },
                    { name: 'PAYLOAD_HASH', type: 'text' },
                    { name: 'COMMITTED_AT', type: 'timestamp_ntz' }
                  ], []);
                }

                // Insert into Ledger
                if (upperSql.startsWith('INSERT')) {
                  const [batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token] = bindValues;
                  this.ledger.set(batch_identity, {
                    batch_identity,
                    migration_id,
                    plan_id,
                    row_count: Number(row_count),
                    payload_hash,
                    fencing_token: Number(fencing_token),
                    committed_at: new Date().toISOString()
                  });
                  return this.#sendSuccess(res, [], []);
                }
              }

              // 5. Target Table Inserts
              if (upperSql.startsWith('INSERT INTO') && !upperSql.includes('SPOOL_')) {
                // Find table key
                for (const key of this.tables.keys()) {
                  const parts = key.split('.');
                  const tbl = parts[2];
                  if (upperSql.includes(`"${tbl}"`) || upperSql.includes(tbl)) {
                    const row = {};
                    const cols = this.schemas.get(key) || [];
                    cols.forEach((c, idx) => {
                      row[c.COLUMN_NAME] = bindValues[idx];
                    });
                    this.tables.get(key).push(row);
                    break;
                  }
                }
                return this.#sendSuccess(res, [], []);
              }

              // 6. Target Table Content Selection
              if (upperSql.startsWith('SELECT') && !upperSql.includes('SPOOL_') && !upperSql.includes('INFORMATION_SCHEMA')) {
                let rows = [];
                for (const key of this.tables.keys()) {
                  const parts = key.split('.');
                  const tbl = parts[2];
                  if (upperSql.includes(`"${tbl}"`) || upperSql.includes(tbl)) {
                    rows = this.tables.get(key) || [];
                    break;
                  }
                }
                const first = rows[0] || {};
                const colNames = Object.keys(first);
                const colDefs = colNames.map(n => ({ name: n, type: 'text' }));
                const data = rows.map(r => colNames.map(n => String(r[n])));
                return this.#sendSuccess(res, colDefs, data);
              }

              // 7. Generic DDL / Transactions (BEGIN, COMMIT, ROLLBACK, CREATE SCHEMA, CREATE TABLE, TRUNCATE)
              if (upperSql.startsWith('TRUNCATE')) {
                for (const key of this.tables.keys()) {
                  const parts = key.split('.');
                  const tbl = parts[2];
                  if (upperSql.includes(`"${tbl}"`) || upperSql.includes(tbl)) {
                    this.tables.set(key, []);
                    break;
                  }
                }
              }

              return this.#sendSuccess(res, [], []);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: '250001', message: String(err?.message ?? err) }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not found' }));
      });

      this.server.listen(port, host, () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve(`http://${host}:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  #sendSuccess(res, rowType, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: '090001',
      statementHandle: `stmt_${randomUUID()}`,
      message: 'Statement executed successfully.',
      resultSetMetaData: {
        numRows: data.length,
        format: 'jsonv2',
        rowType
      },
      data
    }));
  }

  async stop() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
  }
}
