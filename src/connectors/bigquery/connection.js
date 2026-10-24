import { fail } from '../../core/errors.js';
import { requestJson } from '../cloud-http.js';

export function normalizeBigQueryRef(ref = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_BIGQUERY_CONFIG', 'targetRef must be an object');
  const projectId = String(ref.projectId || '').trim();
  const datasetId = String(ref.datasetId || '').trim();
  const tableId = String(ref.tableId || '').trim();
  const location = ref.location ? String(ref.location).trim() : 'US';
  const endpoint = ref.endpoint ? String(ref.endpoint).trim().replace(/\/$/, '') : (process.env.BIGQUERY_ENDPOINT || null);
  const token = ref.token ? String(ref.token).trim() : (process.env.BIGQUERY_TOKEN || 'spool-bigquery-wire-token');

  if (!projectId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery projectId is required');
  if (!datasetId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery datasetId is required');
  if (!tableId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery tableId is required');

  return Object.freeze({
    connector: 'bigquery',
    projectId,
    datasetId,
    tableId,
    location,
    endpoint,
    token
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

  // Real HTTP network transport over wire endpoint
  if (ref.endpoint) {
    const client = {
      query: async (sqlText, params = []) => {
        const queryParameters = params.map(p => ({
          parameterType: { type: typeof p === 'number' ? 'INT64' : 'STRING' },
          parameterValue: { value: String(p) }
        }));

        const res = await requestJson(`${ref.endpoint}/bigquery/v2/projects/${ref.projectId}/queries`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ref.token}`
          },
          body: {
            query: sqlText,
            useLegacySql: false,
            parameterMode: 'POSITIONAL',
            queryParameters
          }
        });

        if (!res.ok) {
          const errText = await res.text();
          fail('BIGQUERY_QUERY_FAILED', `BigQuery query failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const fields = data.schema?.fields || [];
        const rows = (data.rows || []).map(r => {
          const obj = {};
          const fValues = r.f || [];
          for (let i = 0; i < fields.length; i++) {
            obj[fields[i].name] = fValues[i]?.v;
          }
          return obj;
        });

        return { rows, totalRows: data.totalRows };
      }
    };
    return await fn(client);
  }

  // Official @google-cloud/bigquery driver
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
