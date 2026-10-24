import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export class BigQueryWireServer {
  constructor() {
    this.tables = new Map(); // tableKey -> array of row objects
    this.schemas = new Map(); // tableKey -> array of { column_name, data_type, is_nullable }
    this.ledger = new Map(); // batchIdentity -> ledger row object
    this.leases = new Map(); // resource -> fencing_token
    this.server = null;
    this.port = null;
    this.requests = [];
  }

  seedTable(projectId, datasetId, tableId, columns) {
    const key = `${projectId}.${datasetId}.${tableId}`.toLowerCase();
    this.schemas.set(key, columns.map(c => ({
      column_name: c.name,
      data_type: (c.type || 'STRING').toUpperCase(),
      is_nullable: c.nullable ? 'YES' : 'NO'
    })));
    this.tables.set(key, []);
  }

  setLease(resource, token) {
    this.leases.set(resource, Number(token));
  }

  async start(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'POST' && url.pathname.includes('/queries')) {
          let bodyText = '';
          req.on('data', chunk => { bodyText += chunk; });
          req.on('end', () => {
            try {
              const body = JSON.parse(bodyText);
              this.requests.push({ method: 'POST', path: url.pathname, headers: req.headers, body });

              // Validate OAuth2 Authorization
              const auth = req.headers['authorization'];
              if (!auth || !auth.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }));
              }

              const sql = (body.query || '').trim();
              const upperSql = sql.toUpperCase();
              const queryParams = body.queryParameters || [];
              const paramValues = queryParams.map(p => p.parameterValue?.value ?? p);

              // 1. Information Schema
              if (upperSql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                const targetTable = paramValues[0];
                let found = null;
                for (const [k, cols] of this.schemas.entries()) {
                  if (k.endsWith(`.${String(targetTable).toLowerCase()}`)) {
                    found = cols;
                    break;
                  }
                }
                const fields = [
                  { name: 'column_name', type: 'STRING' },
                  { name: 'data_type', type: 'STRING' },
                  { name: 'is_nullable', type: 'STRING' }
                ];
                const rows = (found || []).map(c => ({
                  f: [{ v: c.column_name }, { v: c.data_type }, { v: c.is_nullable }]
                }));
                return this.#sendSuccess(res, fields, rows);
              }

              // 2. Leases Query
              if (upperSql.includes('_SPOOL_EXECUTION_LEASES')) {
                const resource = paramValues[0];
                const token = this.leases.get(resource);
                if (token !== undefined) {
                  return this.#sendSuccess(res, [{ name: 'fencing_token', type: 'INTEGER' }], [
                    { f: [{ v: String(token) }] }
                  ]);
                }
                return this.#sendSuccess(res, [{ name: 'fencing_token', type: 'INTEGER' }], []);
              }

              // 3. Ledger Query & Insert
              if (upperSql.includes('_SPOOL_BATCH_LEDGER')) {
                if (upperSql.startsWith('SELECT')) {
                  const batchIdentity = paramValues[0];
                  const entry = this.ledger.get(batchIdentity);
                  if (entry) {
                    return this.#sendSuccess(res, [
                      { name: 'batch_identity', type: 'STRING' },
                      { name: 'migration_id', type: 'STRING' },
                      { name: 'row_count', type: 'INTEGER' },
                      { name: 'payload_hash', type: 'STRING' },
                      { name: 'committed_at', type: 'TIMESTAMP' }
                    ], [{
                      f: [
                        { v: entry.batch_identity },
                        { v: entry.migration_id },
                        { v: String(entry.row_count) },
                        { v: entry.payload_hash },
                        { v: entry.committed_at }
                      ]
                    }]);
                  }
                  return this.#sendSuccess(res, [
                    { name: 'batch_identity', type: 'STRING' },
                    { name: 'migration_id', type: 'STRING' },
                    { name: 'row_count', type: 'INTEGER' },
                    { name: 'payload_hash', type: 'STRING' },
                    { name: 'committed_at', type: 'TIMESTAMP' }
                  ], []);
                }

                if (upperSql.startsWith('INSERT')) {
                  const [batch_identity, migration_id, plan_id, row_count, payload_hash, fencing_token] = paramValues;
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

              // 4. Target Table Inserts
              if (upperSql.startsWith('INSERT INTO') && !upperSql.includes('_SPOOL_')) {
                for (const key of this.tables.keys()) {
                  const tbl = key.split('.')[2];
                  if (upperSql.includes(`\`${tbl}\``) || upperSql.includes(tbl.toUpperCase())) {
                    const row = {};
                    const cols = this.schemas.get(key) || [];
                    cols.forEach((c, idx) => {
                      row[c.column_name] = paramValues[idx];
                    });
                    this.tables.get(key).push(row);
                    break;
                  }
                }
                return this.#sendSuccess(res, [], []);
              }

              // 5. Target Table Content Selection
              if (upperSql.startsWith('SELECT') && !upperSql.includes('_SPOOL_') && !upperSql.includes('INFORMATION_SCHEMA')) {
                let rows = [];
                for (const key of this.tables.keys()) {
                  const tbl = key.split('.')[2];
                  if (upperSql.includes(`\`${tbl}\``) || upperSql.includes(tbl.toUpperCase())) {
                    rows = this.tables.get(key) || [];
                    break;
                  }
                }
                const first = rows[0] || {};
                const colNames = Object.keys(first);
                const fields = colNames.map(n => ({ name: n, type: 'STRING' }));
                const bqRows = rows.map(r => ({
                  f: colNames.map(n => ({ v: String(r[n]) }))
                }));
                return this.#sendSuccess(res, fields, bqRows);
              }

              // 6. Truncate
              if (upperSql.startsWith('TRUNCATE')) {
                for (const key of this.tables.keys()) {
                  const tbl = key.split('.')[2];
                  if (upperSql.includes(`\`${tbl}\``) || upperSql.includes(tbl.toUpperCase())) {
                    this.tables.set(key, []);
                    break;
                  }
                }
              }

              return this.#sendSuccess(res, [], []);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 500, message: String(err?.message ?? err) } }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, message: 'Not found' } }));
      });

      this.server.listen(port, host, () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve(`http://${host}:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  #sendSuccess(res, fields, rows) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      kind: 'bigquery#queryResponse',
      schema: { fields },
      jobReference: { projectId: 'spool-wire', jobId: `job_${randomUUID()}` },
      totalRows: String(rows.length),
      rows,
      jobComplete: true
    }));
  }

  async stop() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
  }
}
