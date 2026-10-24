import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';
import { normalizeBigQueryRef, escapeBigQueryTable, withBigQueryClient } from './connection.js';

export async function verifyBigQueryContent({ targetRef, expectedRows, targetSchema, targetContractId, primaryKey, credentialBroker, mockClient = null }) {
  if (!Array.isArray(expectedRows)) fail('INVALID_BIGQUERY_VERIFICATION', 'expectedRows must be an array');
  const ref = normalizeBigQueryRef(targetRef);

  return await withBigQueryClient({ targetRef: ref, credentialBroker, mockClient }, async client => {
    const table = escapeBigQueryTable(ref);
    const cols = targetSchema.map(f => `\`${f.name}\``).join(', ');
    const orderCols = primaryKey.map(k => `\`${k}\``).join(', ');

    const res = await client.query(`
      SELECT ${cols}
      FROM ${table}
      ORDER BY ${orderCols}
    `);

    const rawRows = res.rows || [];
    const nameMap = new Map(targetSchema.map(f => [f.name.toLowerCase(), f.name]));
    const actualRows = rawRows.map(r => {
      const normalized = {};
      for (const [k, v] of Object.entries(r)) {
        const canonical = nameMap.get(k.toLowerCase()) || k;
        normalized[canonical] = typeof v === 'string' && !isNaN(v) && v.trim() !== '' && !v.includes('-') && !v.includes('.') ? Number(v) : v;
      }
      return normalized;
    });

    const normalizedExpected = expectedRows.map(r => {
      const normalized = {};
      for (const [k, v] of Object.entries(r)) {
        const canonical = nameMap.get(k.toLowerCase()) || k;
        normalized[canonical] = v;
      }
      return normalized;
    });

    return verifyContentProjection({
      primaryKey,
      columns: targetSchema.map(f => f.name),
      expectedRows: normalizedExpected,
      actualRows,
      targetContractId
    });
  });
}
