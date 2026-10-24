import { fail } from '../../core/errors.js';
import { verifyContentProjection } from '../../execution/content-verification.js';

export async function verifyMysqlContent({ client, targetRef, expectedRows, targetSchema, targetContractId, primaryKey = [targetSchema[0].name] }) {
  if (!Array.isArray(expectedRows)) fail('INVALID_MYSQL_VERIFICATION', 'expectedRows must be an array');
  if (!targetContractId) fail('INVALID_MYSQL_VERIFICATION', 'targetContractId is required');

  const tableName = targetRef.table;
  const columns = targetSchema.map(f => f.name);
  const quotedCols = columns.map(f => `\`${f}\``).join(', ');

  const [actualRows] = await client.query(`SELECT ${quotedCols} FROM \`${tableName}\` ORDER BY \`${primaryKey[0]}\``);

  return verifyContentProjection({
    primaryKey,
    columns,
    expectedRows,
    actualRows,
    targetContractId
  });
}
