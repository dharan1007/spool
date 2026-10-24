import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';
import { normalizeSnowflakeRef, quoteIdentifier, withSnowflakeClient } from './connection.js';

export async function verifySnowflakeContent({ targetRef, expectedRows, targetSchema, targetContractId, primaryKey, credentialBroker, mockClient = null }) {
  if (!Array.isArray(expectedRows)) fail('INVALID_SNOWFLAKE_VERIFICATION', 'expectedRows must be an array');
  const ref = normalizeSnowflakeRef(targetRef);

  return await withSnowflakeClient({ targetRef: ref, credentialBroker, mockClient }, async client => {
    const db = quoteIdentifier(ref.database);
    const schema = quoteIdentifier(ref.schema);
    const table = quoteIdentifier(ref.table);

    const cols = targetSchema.map(f => quoteIdentifier(f.name)).join(', ');
    const orderCols = primaryKey.map(quoteIdentifier).join(', ');

    const res = await client.query(`
      SELECT ${cols}
      FROM ${db}.${schema}.${table}
      ORDER BY ${orderCols}
    `);

    const actualRows = res.rows || [];

    return verifyContentProjection({
      primaryKey,
      columns: targetSchema.map(f => f.name),
      expectedRows,
      actualRows,
      targetContractId
    });
  });
}
