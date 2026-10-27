import { fail } from '../../core/errors.js';
import { requestJson } from '../cloud-http.js';
import { loadSnowflakeDriver } from './driver.js';

export function normalizeSnowflakeRef(ref = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_SNOWFLAKE_CONFIG', 'targetRef must be an object');
  const account = String(ref.account || '').trim();
  const database = String(ref.database || '').trim().toUpperCase();
  const schema = String(ref.schema || 'PUBLIC').trim().toUpperCase();
  const table = String(ref.table || '').trim().toUpperCase();
  const warehouse = ref.warehouse ? String(ref.warehouse).trim().toUpperCase() : null;
  const endpoint = ref.endpoint ? String(ref.endpoint).trim().replace(/\/$/, '') : (process.env.SNOWFLAKE_ENDPOINT || null);
  const token = ref.token ? String(ref.token).trim() : (process.env.SNOWFLAKE_TOKEN || 'spool-snowflake-wire-token');

  if (!account) fail('INVALID_SNOWFLAKE_CONFIG', 'Snowflake account is required');
  if (!database) fail('INVALID_SNOWFLAKE_CONFIG', 'Snowflake database is required');
  if (!table) fail('INVALID_SNOWFLAKE_CONFIG', 'Snowflake table is required');

  return Object.freeze({
    connector: 'snowflake',
    account,
    database,
    schema,
    table,
    warehouse,
    role: ref.role ? String(ref.role).trim().toUpperCase() : null,
    endpoint,
    token
  });
}

export function quoteIdentifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\u0000')) {
    fail('INVALID_SNOWFLAKE_IDENTIFIER', `Invalid Snowflake identifier: ${name}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Driver abstraction: supports:
 * 1. Direct mockClient injection
 * 2. Real HTTP REST / SQL API v2 endpoint (network wire transport)
 * 3. Official snowflake-sdk when installed
 */
export async function withSnowflakeClient({ targetRef, credentialBroker, mockClient = null }, fn) {
  const ref = normalizeSnowflakeRef(targetRef);

  if (mockClient) {
    return await fn(mockClient);
  }

  // Real HTTP network transport over wire endpoint
  if (ref.endpoint) {
    const client = {
      query: async (sqlText, binds = []) => {
        const bindings = {};
        binds.forEach((b, idx) => {
          bindings[String(idx + 1)] = {
            type: typeof b === 'number' ? 'FIXED' : 'TEXT',
            value: String(b)
          };
        });

        const res = await requestJson(`${ref.endpoint}/api/v2/statements`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ref.token}`
          },
          body: {
            statement: sqlText,
            bindings,
            database: ref.database,
            schema: ref.schema,
            warehouse: ref.warehouse,
            role: ref.role
          }
        });

        if (!res.ok) {
          const errText = await res.text();
          fail('SNOWFLAKE_QUERY_FAILED', `Snowflake query failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const rowType = data.resultSetMetaData?.rowType || [];
        const rows = (data.data || []).map(rowArray => {
          const obj = {};
          for (let i = 0; i < rowType.length; i++) {
            obj[rowType[i].name] = rowArray[i];
          }
          return obj;
        });

        return { rows, statementHandle: data.statementHandle };
      }
    };
    return await fn(client);
  }

  // Official snowflake-sdk driver (optional driver, loaded on first use)
  const snowflake = await loadSnowflakeDriver();
  try {
    const connection = snowflake.createConnection({
      account: ref.account,
      username: process.env.SNOWFLAKE_USER || ref.account,
      database: ref.database,
      schema: ref.schema,
      warehouse: ref.warehouse,
      role: ref.role
    });

    await new Promise((resolve, reject) => {
      connection.connect((err, conn) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });

    try {
      const client = {
        query: async (sqlText, binds = []) => {
          return new Promise((resolve, reject) => {
            connection.execute({
              sqlText,
              binds,
              complete: (err, stmt, rows) => {
                if (err) reject(err);
                else resolve({ rows, stmt });
              }
            });
          });
        }
      };
      return await fn(client);
    } finally {
      connection.destroy();
    }
  } catch (err) {
    fail('SNOWFLAKE_CONNECTION_FAILED', `Failed to establish Snowflake connection: ${err?.message ?? err}`);
  }
}
