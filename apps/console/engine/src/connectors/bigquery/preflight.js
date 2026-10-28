import { fail } from '../../core/errors.js';
import { sha256Canonical } from '../../platform/canonical-json.js';
import { normalizeBigQueryRef, withBigQueryClient } from './connection.js';

const CONTRACT_DOMAIN = 'spool-target-contract-v1';

export function bigqueryTargetContractId(targetSchema) {
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) {
    fail('INVALID_BIGQUERY_SCHEMA', 'targetSchema must be a non-empty array');
  }
  return sha256Canonical(CONTRACT_DOMAIN, targetSchema);
}

export async function preflightBigQueryTarget({ targetRef, targetSchema = [], credentialBroker, mockClient = null }) {
  const ref = normalizeBigQueryRef(targetRef);

  return await withBigQueryClient({ targetRef: ref, credentialBroker, mockClient }, async client => {
    // Query INFORMATION_SCHEMA for table metadata
    const colRes = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM \`${ref.projectId}.${ref.datasetId}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = ?
      ORDER BY ordinal_position
    `, [ref.tableId]);

    const existingColumns = colRes.rows || [];
    if (existingColumns.length === 0) {
      fail('TARGET_TABLE_NOT_FOUND', `BigQuery table ${ref.projectId}.${ref.datasetId}.${ref.tableId} not found`);
    }

    const declaredNames = new Set(targetSchema.map(f => f.name));
    for (const col of existingColumns) {
      const isNullable = col.is_nullable === 'YES';
      if (!isNullable && targetSchema.length > 0 && !declaredNames.has(col.column_name)) {
        fail('TARGET_SCHEMA_INCOMPATIBLE', `Required BigQuery column ${col.column_name} is missing from targetSchema`);
      }
    }

    const primaryKey = targetSchema.length > 0 ? [targetSchema[0].name] : [existingColumns[0].column_name];
    const contractId = bigqueryTargetContractId(targetSchema.length > 0 ? targetSchema : existingColumns.map(c => ({
      name: c.column_name,
      type: c.data_type.toLowerCase()
    })));

    return Object.freeze({
      targetContractId: contractId,
      targetSchema: Object.freeze(targetSchema),
      primaryKey: Object.freeze(primaryKey),
      columns: Object.freeze(existingColumns.map(c => ({
        name: c.column_name,
        type: c.data_type.toLowerCase(),
        nullable: c.is_nullable === 'YES'
      })))
    });
  });
}
