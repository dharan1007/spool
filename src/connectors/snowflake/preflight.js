import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizeSnowflakeRef, quoteIdentifier, withSnowflakeClient } from './connection.js';

const CONTRACT_DOMAIN = 'spool-target-contract-v1';

export function snowflakeTargetContractId(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) {
    fail('INVALID_SNOWFLAKE_SCHEMA', 'targetSchema must be a non-empty array');
  }
  return sha256Canonical(CONTRACT_DOMAIN, targetSchema);
}

export async function preflightSnowflakeTarget({ targetRef, targetSchema = [], credentialBroker, mockClient = null }) {
  const ref = normalizeSnowflakeRef(targetRef);

  return await withSnowflakeClient({ targetRef: ref, credentialBroker, mockClient }, async client => {
    // 1. Check table existence and columns in Information Schema
    const colRes = await client.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM ${quoteIdentifier(ref.database)}.INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [ref.schema, ref.table]);

    const existingColumns = colRes.rows || [];
    if (existingColumns.length === 0) {
      fail('TARGET_TABLE_NOT_FOUND', `Snowflake table ${ref.database}.${ref.schema}.${ref.table} not found or has no columns`);
    }

    // 2. Discover Primary Keys
    let primaryKey = [];
    try {
      const pkRes = await client.query(`SHOW PRIMARY KEYS IN TABLE ${quoteIdentifier(ref.database)}.${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.table)}`);
      primaryKey = (pkRes.rows || []).map(r => r.column_name || r.COLUMN_NAME);
    } catch {
      // Some roles lack SHOW permissions or table has no PK
      primaryKey = [existingColumns[0].COLUMN_NAME || existingColumns[0].column_name];
    }

    const declaredNames = new Set(targetSchema.map(f => f.name.toUpperCase()));
    for (const col of existingColumns) {
      const cName = (col.COLUMN_NAME || col.column_name).toUpperCase();
      const isNullable = (col.IS_NULLABLE || col.is_nullable) === 'YES';
      if (!isNullable && targetSchema.length > 0 && !declaredNames.has(cName)) {
        fail('TARGET_SCHEMA_INCOMPATIBLE', `Required column ${cName} is missing from migration mapping`);
      }
    }

    const contractId = snowflakeTargetContractId(targetSchema.length > 0 ? targetSchema : existingColumns.map(c => ({
      name: c.COLUMN_NAME || c.column_name,
      type: (c.DATA_TYPE || c.data_type).toLowerCase()
    })));

    return Object.freeze({
      targetContractId: contractId,
      targetSchema: Object.freeze(targetSchema),
      primaryKey: Object.freeze(primaryKey),
      columns: Object.freeze(existingColumns.map(c => ({
        name: c.COLUMN_NAME || c.column_name,
        type: (c.DATA_TYPE || c.data_type).toLowerCase(),
        nullable: (c.IS_NULLABLE || c.is_nullable) === 'YES'
      })))
    });
  });
}
