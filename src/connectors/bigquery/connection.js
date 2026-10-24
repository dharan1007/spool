import { fail } from '../../core/errors.js';

export function normalizeBigQueryRef(ref = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_BIGQUERY_CONFIG', 'targetRef must be an object');
  const projectId = String(ref.projectId || '').trim();
  const datasetId = String(ref.datasetId || '').trim();
  const tableId = String(ref.tableId || '').trim();
  const location = ref.location ? String(ref.location).trim() : 'US';

  if (!projectId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery projectId is required');
  if (!datasetId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery datasetId is required');
  if (!tableId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery tableId is required');

  return Object.freeze({
    connector: 'bigquery',
    projectId,
    datasetId,
    tableId,
    location
  });
}

export function escapeBigQueryTable(ref) {
  return `\`${ref.projectId}.${ref.datasetId}.${ref.tableId}\``;
}

export async function withBigQueryClient({ targetRef, credentialBroker, mockClient = null }, fn) {
  const ref = normalizeBigQueryRef(targetRef);

  if (mockClient) {
    return await fn(mockClient);
  }

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({
      projectId: ref.projectId
    });

    const client = {
      query: async (query, params = []) => {
        const [rows] = await bq.query({ query, params });
        return { rows };
      },
      getTable: async () => {
        return bq.dataset(ref.datasetId).table(ref.tableId);
      }
    };

    return await fn(client);
  } catch (err) {
    fail('BIGQUERY_CONNECTION_FAILED', `Failed to initialize BigQuery client: ${err?.message ?? err}`);
  }
}
