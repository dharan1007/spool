import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';

export async function verifyMssqlContent({ pool, targetRef, expectedRows, targetSchema, targetContractId, primaryKey = [targetSchema[0].name] }) {
  if (!Array.isArray(expectedRows)) fail('INVALID_MSSQL_VERIFICATION', 'expectedRows must be an array');
  if (!targetContractId) fail('INVALID_MSSQL_VERIFICATION', 'targetContractId is required');

  const tableName = targetRef.table;
  const columns = targetSchema.map(f => f.name);
  const bracketCols = columns.map(f => `[${f}]`).join(', ');

  const result = await pool.request().query(`SELECT ${bracketCols} FROM [${targetRef.schema ?? 'dbo'}].[${tableName}] ORDER BY [${primaryKey[0]}]`);
  const actualRows = result.recordset ?? [];

  return verifyContentProjection({
    primaryKey,
    columns,
    expectedRows,
    actualRows,
    targetContractId
  });
}
