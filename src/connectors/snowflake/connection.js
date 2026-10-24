import { fail } from '../../core/errors.js';

export function normalizeSnowflakeRef(ref = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_SNOWFLAKE_CONFIG', 'targetRef must be an object');
  const account = String(ref.account || '').trim();
  const database = String(ref.database || '').trim().toUpperCase();
  const schema = String(ref.schema || 'PUBLIC').trim().toUpperCase();
  const table = String(ref.table || '').trim().toUpperCase();
  const warehouse = ref.warehouse ? String(ref.warehouse).trim().toUpperCase() : null;

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
    role: ref.role ? String(ref.role).trim().toUpperCase() : null
  });
}

export function quoteIdentifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\u0000')) {
    fail('INVALID_SNOWFLAKE_IDENTIFIER', `Invalid Snowflake identifier: ${name}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Driver abstraction: loads snowflake-sdk if available in node_modules,
 * or utilizes a configured client/mock.
 */
export async function withSnowflakeClient({ targetRef, credentialBroker, mockClient = null }, fn) {
  const ref = normalizeSnowflakeRef(targetRef);
  
  if (mockClient) {
    return await fn(mockClient);
  }

  try {
    const snowflake = await import('snowflake-sdk');
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
    // If driver not installed or credentials absent, fail with clean typed error
    fail('SNOWFLAKE_CONNECTION_FAILED', `Failed to establish Snowflake connection: ${err?.message ?? err}`);
  }
}
